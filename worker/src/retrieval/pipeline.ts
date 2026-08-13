import type { Env, ConversationMessage, QueryDebug, QueryResult, RouterResult, DecomposeResult, SufficiencyResult, IterationDebug } from "../types";
import { route, generateChatResponse } from "./router";
import { decompose } from "./decompose";
import { retrieve, RetrievedUnit } from "./query";
import { selectEvidence, buildEvidenceContext, SelectedEvidence } from "./evidence";
import { checkSufficiency } from "./sufficiency";
import { generateAnswer } from "./answer";
import {
  appendConversationMessage,
  getLastConversationTurns,
  logDebug,
  logQueryStep,
  logCandidate,
} from "../utils/db";
import { RETRIEVAL } from "../config.gen";

const HISTORY_TURNS = RETRIEVAL.pipeline.historyTurns.value;
const MAX_ITERATIONS = RETRIEVAL.pipeline.maxIterations.value;
const MAX_COMPLEX_ITERATIONS = RETRIEVAL.pipeline.maxComplexIterations.value;

export interface PipelineOptions {
  conversationId?: string;
  stream?: boolean;
  debug?: boolean;
  maxIterations?: number;
}

export interface PipelineResult {
  result: QueryResult;
  retrieved: RetrievedUnit[];
}

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = Date.now();
  return fn().then((value) => ({ value, durationMs: Date.now() - start }));
}

/** Full agentic retrieval pipeline: router → decompose → retrieve → sufficiency loop → answer. */
export async function runQuery(
  env: Env,
  question: string,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const { conversationId, debug = false, maxIterations } = opts;

  // Load conversation history (last N turns)
  const history: ConversationMessage[] = conversationId
    ? await getLastConversationTurns(env, conversationId, HISTORY_TURNS)
    : [];

  // Step 1: Router
  console.log(`[pipeline] Step 1: Router — question: "${question.slice(0, 80)}..."`);
  const { value: routerResult, durationMs: routerMs } = await timed(() => route(env, question, history));
  console.log(`[pipeline] Router: rag=${routerResult.rag}, language=${routerResult.language}, duration=${routerMs}ms`);
  await logDebug(env, "info", "retrieval:router", `rag=${routerResult.rag}, language=${routerResult.language}`, { durationMs: routerMs, question: question.slice(0, 120) });

  if (conversationId) {
    await logQueryStep(env, "router", { question, historyLength: history.length }, routerResult, routerMs, conversationId);
  }

  // If not RAG, return chat response directly
  if (!routerResult.rag) {
    console.log(`[pipeline] RAG=false — returning chat response`);
    let chatResponse = routerResult.chatResponse;
    if (!chatResponse) {
      const { value: response, durationMs } = await timed(() => generateChatResponse(env, question, routerResult.language, history));
      chatResponse = response;
      if (conversationId) {
        await logQueryStep(env, "chat", { question }, chatResponse, durationMs, conversationId);
      }
    }

    const result: QueryResult = {
      answer: chatResponse,
      citations: [],
      usedUnitIds: [],
      language: routerResult.language,
    };

    // Save to conversation
    if (conversationId) {
      await appendConversationMessage(env, conversationId, { role: "user", content: question });
      await appendConversationMessage(env, conversationId, { role: "assistant", content: chatResponse });
    }

    return { result, retrieved: [] };
  }

  // Step 2: Decompose — Phase 8: pass both original and translated queries
  console.log(`[pipeline] Step 2: Decompose — original: "${routerResult.originalQuery.slice(0, 80)}...", russian_query: "${routerResult.russianQuery.slice(0, 80)}..."`);
  const { value: decomposeResult, durationMs: decomposeMs } = await timed(() =>
    decompose(env, routerResult.russianQuery, history, routerResult.originalQuery, routerResult.entities)
  );
  console.log(`[pipeline] Decompose: ${decomposeResult.subQueries.length} sub-queries, threshold=${decomposeResult.rerankThreshold}, list=${decomposeResult.isListQuery}, complexity=${decomposeResult.queryComplexity}, duration=${decomposeMs}ms`);
  await logDebug(env, "info", "retrieval:decompose", `${decomposeResult.subQueries.length} sub-queries`, { durationMs: decomposeMs, threshold: decomposeResult.rerankThreshold, isListQuery: decomposeResult.isListQuery, queryComplexity: decomposeResult.queryComplexity });

  if (conversationId) {
    await logQueryStep(env, "decompose", { originalQuery: routerResult.originalQuery, russianQuery: routerResult.russianQuery, entities: routerResult.entities }, decomposeResult, decomposeMs, conversationId);
  }

  // Phase 9: Determine iteration limit based on query complexity
  const isComplex = decomposeResult.queryComplexity === "complex";
  const effectiveMaxIterations = maxIterations ?? (isComplex ? MAX_COMPLEX_ITERATIONS : MAX_ITERATIONS);
  console.log(`[pipeline] Query complexity: ${decomposeResult.queryComplexity ?? "simple"}, max iterations: ${effectiveMaxIterations}`);

  // Iterative retrieval loop — Phase 9: evidence is accumulated across iterations
  const allRetrieved = new Map<string, RetrievedUnit>();
  const allRetrievedIds = new Set<string>();
  const iterations: IterationDebug[] = [];
  let currentSubQueries = decomposeResult.subQueries;
  let lastSufficiency: SufficiencyResult | undefined;
  let allGaps: string[] = [];

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
    console.log(`[pipeline] Step 3: Retrieve — iteration ${iteration + 1}, ${currentSubQueries.length} sub-queries`);

    const { value: retrieved, durationMs: retrieveMs } = await timed(() =>
      retrieve(env, currentSubQueries, {
        rerankThreshold: decomposeResult.rerankThreshold,
        existingIds: allRetrievedIds,
      })
    );
    console.log(`[pipeline] Retrieve: ${retrieved.length} candidates, duration=${retrieveMs}ms`);
    await logDebug(env, "info", "retrieval:retrieve", `${retrieved.length} candidates (iter ${iteration + 1})`, { durationMs: retrieveMs, totalAfterMerge: allRetrieved.size });

    if (conversationId) {
      await logQueryStep(env, "retrieve", { iteration, subQueries: currentSubQueries }, { count: retrieved.length }, retrieveMs, conversationId);
    }

    // Phase 10: Log candidates for diagnostics
    for (const r of retrieved) {
      await logCandidate(env, {
        conversationId: conversationId ?? undefined,
        queryText: question,
        iteration,
        stage: "rerank",
        unitId: r.unit.id,
        unitName: r.unit.name ?? undefined,
        unitType: r.unit.type,
        vectorScore: r.vectorScore,
        rerankScore: r.rerankScore,
        finalScore: r.finalScore,
        provenance: r.provenance ? JSON.stringify(r.provenance) : undefined,
      });
    }

    // Merge into allRetrieved (dedupe by unit id, keep best rerankScore, merge sourceSubQueries)
    for (const r of retrieved) {
      const existing = allRetrieved.get(r.unit.id);
      if (existing) {
        if ((r.rerankScore ?? 0) > (existing.rerankScore ?? 0)) {
          existing.rerankScore = r.rerankScore;
        }
        const sources = new Set([...(existing.sourceSubQueries ?? []), ...(r.sourceSubQueries ?? [])]);
        existing.sourceSubQueries = [...sources];
      } else {
        allRetrieved.set(r.unit.id, r);
        allRetrievedIds.add(r.unit.id);
      }
    }

    const iterationDebug: IterationDebug = {
      iteration: iteration + 1,
      subQueries: [...currentSubQueries],
      candidatesFound: retrieved.length,
      afterRerank: allRetrieved.size,
    };

    // Step 5: Sufficiency check (skip on last iteration — use what we have)
    if (iteration < effectiveMaxIterations - 1) {
      console.log(`[pipeline] Step 5: Sufficiency check — iteration ${iteration + 1}`);
      const { value: sufficiency, durationMs: suffMs } = await timed(() =>
        checkSufficiency(env, routerResult.russianQuery, [...allRetrieved.values()], currentSubQueries)
      );
      console.log(`[pipeline] Sufficiency: sufficient=${sufficiency.sufficient}, gaps=${sufficiency.gaps.length}, categorizedGaps=${sufficiency.categorizedGaps?.length ?? 0}, duration=${suffMs}ms`);
      await logDebug(env, "info", "retrieval:sufficiency", `sufficient=${sufficiency.sufficient}, gaps=${sufficiency.gaps.length}`, { durationMs: suffMs, iteration: iteration + 1, categorizedGaps: sufficiency.categorizedGaps?.length ?? 0 });

      if (conversationId) {
        await logQueryStep(env, "sufficiency", { iteration: iteration + 1 }, sufficiency, suffMs, conversationId);
      }

      iterationDebug.sufficiency = sufficiency;
      lastSufficiency = sufficiency;
      allGaps = [...allGaps, ...sufficiency.gaps];

      if (sufficiency.sufficient) {
        console.log(`[pipeline] Sufficient — breaking loop`);
        iterations.push(iterationDebug);
        break;
      }

      if (sufficiency.followUpQueries.length === 0) {
        console.log(`[pipeline] No follow-up queries — breaking loop`);
        iterations.push(iterationDebug);
        break;
      }

      currentSubQueries = sufficiency.followUpQueries;
    }

    iterations.push(iterationDebug);
  }

  const retrievedList = [...allRetrieved.values()];
  console.log(`[pipeline] Total retrieved: ${retrievedList.length} units`);

  // Phase 7: Evidence selection — select the best evidence from the candidate pool
  const isListQuery = decomposeResult.isListQuery ?? false;
  const allUnitsMap = new Map(retrievedList.map((r) => [r.unit.id, r.unit]));
  const selectedEvidence = selectEvidence(retrievedList, decomposeResult.subQueries.length, isListQuery, allUnitsMap);
  console.log(`[pipeline] Evidence selected: ${selectedEvidence.length} units (list=${isListQuery})`);

  // Phase 10: Log evidence selection
  for (const e of selectedEvidence) {
    await logCandidate(env, {
      conversationId: conversationId ?? undefined,
      queryText: question,
      iteration: -1, // evidence selection is post-iteration
      stage: "evidence_selection",
      unitId: e.unit.id,
      unitName: e.unit.name ?? undefined,
      unitType: e.unit.type,
      rerankScore: e.rerankScore,
      finalScore: e.finalScore,
      selected: true,
    });
  }

  // Step 6: Answer generation — pass selected evidence with hierarchical context
  console.log(`[pipeline] Step 6: Answer generation — language: ${routerResult.language}`);
  const { value: result, durationMs: answerMs } = await timed(() =>
    generateAnswer(env, question, selectedEvidence.map((e) => ({ unit: e.unit, rerankScore: e.rerankScore } as any)), {
      language: routerResult.language,
      subQueries: decomposeResult.subQueries,
      gaps: allGaps,
      evidenceContext: buildEvidenceContext(selectedEvidence),
    } as any)
  );
  console.log(`[pipeline] Answer: ${result.citations.length} citations, duration=${answerMs}ms`);
  await logDebug(env, "info", "retrieval:answer", `${result.citations.length} citations`, { durationMs: answerMs, evidenceCount: selectedEvidence.length });

  if (conversationId) {
    await logQueryStep(env, "answer", { question, language: routerResult.language }, result, answerMs, conversationId);
  }

  // Add debug info if requested
  if (debug) {
    const queryDebug: QueryDebug = {
      router: routerResult,
      decomposition: decomposeResult,
      iterations,
      finalEvidenceCount: selectedEvidence.length,
    };
    result.debug = queryDebug;
  }

  // Save to conversation
  if (conversationId) {
    await appendConversationMessage(env, conversationId, { role: "user", content: question });
    await appendConversationMessage(env, conversationId, { role: "assistant", content: result.answer });
  }

  return { result, retrieved: retrievedList };
}

/** Streaming version — yields answer chunks, returns final result. */
export async function* runQueryStream(
  env: Env,
  question: string,
  opts: PipelineOptions = {}
): AsyncGenerator<string, PipelineResult, unknown> {
  // Run the full pipeline (non-streaming up to answer generation)
  // For now, we run the pipeline and then stream the answer.
  // When Workers AI supports streaming, we can stream the answer generation directly.
  const pipelineResult = await runQuery(env, question, opts);

  // Yield answer in chunks
  const chunkSize = RETRIEVAL.pipeline.streamingChunkSize.value;
  for (let i = 0; i < pipelineResult.result.answer.length; i += chunkSize) {
    yield pipelineResult.result.answer.slice(i, i + chunkSize);
  }

  return pipelineResult;
}
