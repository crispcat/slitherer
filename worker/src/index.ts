import type { Env, StructureDocument, ConversationMessage } from "./types";
import { processIngestionBatch, rebuildAllRelationships, startIngestion, INGEST_STAGES } from "./pipeline/ingest";
import { cleanupDocument, getIngestionJob, getLastConversationTurns, logQueryStep, resetIngestionStage } from "./utils/db";
import { runQuery, runQueryStream } from "./retrieval/pipeline";
import { route, generateChatResponse } from "./retrieval/router";
import { decompose } from "./retrieval/decompose";
import { retrieve } from "./retrieval/query";
import { checkSufficiency } from "./retrieval/sufficiency";
import { generateAnswer } from "./retrieval/answer";
import { uuid } from "./utils/ids";
import { INGESTION, CLIENT } from "./config.gen";

const CORS_ORIGIN = CLIENT.cors.allowOrigin.value;
const CORS_HEADERS = CLIENT.cors.allowHeaders.value;
const CORS_METHODS = CLIENT.cors.allowMethods.value;
const CORS_MAX_AGE = String(CLIENT.cors.maxAge.value);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-allow-methods": CORS_METHODS,
    },
  });
}

/** Handle CORS preflight (OPTIONS) requests. */
function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": CORS_ORIGIN,
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-allow-methods": CORS_METHODS,
      "access-control-max-age": CORS_MAX_AGE,
    },
  });
}

/** Constant-time-ish string compare to avoid trivial timing side-channels on the API key check. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

/** Admin routes (/ingest*) fail CLOSED if ADMIN_API_KEY isn't configured — never silently open. */
function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) return false;
  const token = bearerToken(request);
  return token.length > 0 && safeEqual(token, env.ADMIN_API_KEY);
}

/** /query* endpoints are open by default; set QUERY_API_KEY to lock them down. */
function isQueryAuthorized(request: Request, env: Env): boolean {
  if (!env.QUERY_API_KEY) return true;
  const token = bearerToken(request);
  return token.length > 0 && safeEqual(token, env.QUERY_API_KEY);
}

/**
 * Structure documents are large; the client is expected to store the raw
 * structure.json in R2 first (or POST it directly for small docs) and pass
 * either { structure: StructureDocument } or { bucketKey: string }.
 */
async function loadStructureDoc(env: Env, body: any): Promise<StructureDocument> {
  if (body.structure) return body.structure as StructureDocument;
  if (body.bucketKey) {
    const obj = await env.slitherer_rag_storage.get(body.bucketKey);
    if (!obj) throw new Error(`No such object in BUCKET: ${body.bucketKey}`);
    return (await obj.json()) as StructureDocument;
  }
  throw new Error("Request body must include either 'structure' or 'bucketKey'");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — handle before auth so the browser can complete the handshake
    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    try {
      if (url.pathname.startsWith("/ingest") && !isAdminAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (url.pathname.startsWith("/query") && !isQueryAuthorized(request, env)) {
        return json({ error: "unauthorized" }, 401);
      }

      // POST /query/verify
      // Validates the API key without doing any work. Used by the client
      // to check the token before rendering the UI.
      if (url.pathname === "/query/verify" && request.method === "POST") {
        return json({ ok: true });
      }

      // POST /ingest/upload?documentId=...&sourcePath=...
      // Body: raw StructureDocument JSON. Stores it (plus a small sourcePath
      // sidecar) in R2 and returns { bucketKey } for use with POST /ingest.
      // This is the recommended default path — it sidesteps any client/edge
      // request-body-size caveats around inlining `structure` directly.
      if (url.pathname === "/ingest/upload" && request.method === "POST") {
        const documentId = url.searchParams.get("documentId");
        const sourcePath = url.searchParams.get("sourcePath") ?? "unknown";
        if (!documentId) return json({ error: "documentId query param is required" }, 400);

        const bodyText = await request.text();
        JSON.parse(bodyText); // validate it's well-formed JSON before storing

        const bucketKey = `structures/${documentId}.json`;
        await env.slitherer_rag_storage.put(bucketKey, bodyText, {
          httpMetadata: { contentType: "application/json" },
        });
        await env.slitherer_rag_storage.put(
          `structures/${documentId}.meta.json`,
          JSON.stringify({ documentId, sourcePath, uploadedAt: new Date().toISOString() })
        );

        return json({ bucketKey, documentId, sourcePath });
      }

      // POST /ingest  { documentId, sourcePath, structure | bucketKey }
      // Starts (or restarts) ingestion for a document and stores the structure
      // tree + a resumable job. Returns { jobId }.
      if (url.pathname === "/ingest" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId ?? uuid();
        const sourcePath: string = body.sourcePath ?? "unknown";
        const doc = await loadStructureDoc(env, body);
        const jobId = uuid();

        await env.slitherer_rag_storage.put(`jobs/${jobId}.json`, JSON.stringify(doc));

        const { totalNodes } = await startIngestion(env, documentId, sourcePath, doc, jobId);
        return json({ jobId, documentId, totalNodes });
      }

      // POST /ingest/step { jobId, batchSize?, stage? }
      // Advances an ingestion job by one batch. Call repeatedly until done=true.
      // If stage is specified (e.g. "units", "summary", "metadata", "relations"),
      // skips ahead to that phase and stops after it completes.
      if (url.pathname === "/ingest/step" && request.method === "POST") {
        const body = await request.json<any>();
        const jobId: string = body.jobId;
        const obj = await env.slitherer_rag_storage.get(`jobs/${jobId}.json`);
        if (!obj) return json({ error: "job structure not found" }, 404);
        const doc = (await obj.json()) as StructureDocument;
        const stage = body.stage;
        if (stage && !INGEST_STAGES.includes(stage)) {
          return json({ error: `Invalid stage: ${stage}. Valid stages: ${INGEST_STAGES.join(", ")}` }, 400);
        }
        const result = await processIngestionBatch(
          env, doc, jobId,
          body.batchSize ?? INGESTION.ingestion.batchSizes.unitsDefault.value,
          stage
        );
        return json(result);
      }

      // GET /ingest/status?jobId=...
      if (url.pathname === "/ingest/status" && request.method === "GET") {
        const jobId = url.searchParams.get("jobId") ?? "";
        const job = await getIngestionJob(env, jobId);
        if (!job) return json({ error: "not found" }, 404);
        return json(job);
      }

      // POST /ingest/cleanup { documentId }
      // Removes every D1 row, Vectorize vector, and R2 object for a document.
      if (url.pathname === "/ingest/cleanup" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId;
        if (!documentId) return json({ error: "documentId is required" }, 400);
        await cleanupDocument(env, documentId);
        return json({ ok: true, documentId });
      }

      // POST /ingest/reset-stage { documentId, stage }
      // Clears the outputs of the specified stage AND all downstream stages,
      // then resets unit statuses so the stage can be re-run from clean state.
      // Stages: units | summary | metadata | relations
      if (url.pathname === "/ingest/reset-stage" && request.method === "POST") {
        const body = await request.json<any>();
        const documentId: string = body.documentId;
        const stage: string = body.stage;
        if (!documentId) return json({ error: "documentId is required" }, 400);
        if (!stage || !INGEST_STAGES.includes(stage as any)) {
          return json({ error: `Invalid stage: ${stage}. Valid stages: ${INGEST_STAGES.join(", ")}` }, 400);
        }
        await resetIngestionStage(env, documentId, stage);
        return json({ ok: true, documentId, stage });
      }

      // POST /ingest/table { node }
      // Processes a single table node and returns the detected semantic units
      // WITHOUT saving to DB. Useful for testing table processing in isolation.
      if (url.pathname === "/ingest/table" && request.method === "POST") {
        const body = await request.json<any>();
        const node = body.node;
        if (!node || node.type !== "table") {
          return json({ error: "node (type=table) is required" }, 400);
        }
        // Process the table and return both the structure and units for debugging.
        const { detectTableStructure, buildTableUnitsFromTree } = await import("./pipeline/table_tree");
        const structure = await detectTableStructure(env, node);
        const detectedUnits = buildTableUnitsFromTree(node, structure);
        // Convert DetectedUnit[] to SemanticUnit[] (assign IDs).
        const units = detectedUnits.map((u, i) => ({
          id: `UNIT-${i}`,
          type: u.type,
          sourceOrder: i,
          parentUnitId: u.parentIndex !== undefined ? `UNIT-${u.parentIndex}` : undefined,
          secondaryParentUnitId: u.secondaryParentIndex !== undefined ? `UNIT-${u.secondaryParentIndex}` : undefined,
          content: u.content,
        }));
        return json({
          nodeId: node.id,
          unitCount: units.length,
          structure: {
            row_tree: structure.row_tree,
            column_tree: structure.column_tree,
          },
          units,
        });
      }

      // POST /ingest/rebuild-relations { batchSize?, cursor? }
      // Second pass over Phase 5 across the whole knowledge base (see
      // pipeline/ingest.ts:rebuildAllRelationships for rationale).
      if (url.pathname === "/ingest/rebuild-relations" && request.method === "POST") {
        const body = await request.json<any>().catch(() => ({}));
        const result = await rebuildAllRelationships(env, body.batchSize ?? INGESTION.ingestion.batchSizes.rebuildRelations.value, body.cursor ?? 0);
        return json(result);
      }

      // POST /query { question, conversationId?, stream?, debug?, graphHops?, maxIterations? }
      // Full agentic retrieval pipeline: router → decompose → retrieve → sufficiency loop → answer.
      // All-in-one endpoint. For step-by-step execution, use the /query/* endpoints below.
      if (url.pathname === "/query" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const stream = body.stream === true;

        if (stream) {
          // Streaming mode: Server-Sent Events
          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(controller) {
              try {
                const generator = runQueryStream(env, question, {
                  conversationId: body.conversationId,
                  stream: true,
                  debug: body.debug === true,
                  graphHops: body.graphHops,
                  maxIterations: body.maxIterations,
                });

                let result;
                while (true) {
                  const { value, done } = await generator.next();
                  if (done) {
                    result = value;
                    break;
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: value })}\n\n`));
                }

                // Send final result as a metadata event
                if (result) {
                  controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify(result.result)}\n\n`));
                }
                controller.close();
              } catch (err: any) {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err?.message ?? "internal error" })}\n\n`));
                controller.close();
              }
            },
          });

          return new Response(readable, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              "connection": "keep-alive",
              "access-control-allow-origin": CORS_ORIGIN,
              "access-control-allow-headers": CORS_HEADERS,
              "access-control-allow-methods": CORS_METHODS,
            },
          });
        }

        // Complete mode: standard JSON response
        const { result, retrieved } = await runQuery(env, question, {
          conversationId: body.conversationId,
          debug: body.debug === true,
          graphHops: body.graphHops,
          maxIterations: body.maxIterations,
        });

        return json({
          ...result,
          retrievedUnits: retrieved.map((r) => ({
            id: r.unit.id,
            type: r.unit.type,
            name: r.unit.name,
            section: r.unit.section,
            page: r.unit.page,
            vectorScore: r.vectorScore,
            rerankScore: r.rerankScore,
            sourceSubQueries: r.sourceSubQueries,
          })),
        });
      }

      // ---- Step-by-step query endpoints (for client-side orchestration) ----

      // POST /query/router { question, conversationId? }
      // Step 1: RAG-vs-chat classification + language detection + translation.
      if (url.pathname === "/query/router" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const history: ConversationMessage[] = body.conversationId
          ? await getLastConversationTurns(env, body.conversationId, 6)
          : [];

        const start = Date.now();
        const result = await route(env, question, history);
        const durationMs = Date.now() - start;
        console.log(`[/query/router] rag=${result.rag} lang=${result.language} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "router", { question }, result, durationMs, body.conversationId);
        }

        // If not RAG, generate chat response
        if (!result.rag && !result.chatResponse) {
          result.chatResponse = await generateChatResponse(env, question, result.language, history);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/decompose { russianQuery, conversationId? }
      // Step 2: Query decomposition into sub-queries + dynamic rerank threshold.
      if (url.pathname === "/query/decompose" && request.method === "POST") {
        const body = await request.json<any>();
        const russianQuery: string = body.russianQuery;
        if (!russianQuery) return json({ error: "russianQuery is required" }, 400);

        const history: ConversationMessage[] = body.conversationId
          ? await getLastConversationTurns(env, body.conversationId, 6)
          : [];

        const start = Date.now();
        const result = await decompose(env, russianQuery, history);
        const durationMs = Date.now() - start;
        console.log(`[/query/decompose] ${result.subQueries.length} sub-queries threshold=${result.rerankThreshold} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "decompose", { russianQuery }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/retrieve { subQueries, rerankThreshold?, graphHops?, existingIds? }
      // Step 3+4: Multi-sub-query retrieval + per-sub-query rerank + threshold filter.
      if (url.pathname === "/query/retrieve" && request.method === "POST") {
        const body = await request.json<any>();
        const subQueries: string[] = body.subQueries;
        if (!subQueries || !Array.isArray(subQueries) || subQueries.length === 0) {
          return json({ error: "subQueries array is required" }, 400);
        }

        const start = Date.now();
        const retrieved = await retrieve(env, subQueries, {
          graphHops: body.graphHops,
          rerankThreshold: body.rerankThreshold,
          existingIds: body.existingIds ? new Set(body.existingIds) : undefined,
        });
        const durationMs = Date.now() - start;
        console.log(`[/query/retrieve] ${retrieved.length} units duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "retrieve", { subQueries }, { count: retrieved.length }, durationMs, body.conversationId);
        }

        return json({
          retrievedUnits: retrieved.map((r) => ({
            id: r.unit.id,
            type: r.unit.type,
            name: r.unit.name,
            section: r.unit.section,
            page: r.unit.page,
            content: r.unit.content,
            vectorScore: r.vectorScore,
            rerankScore: r.rerankScore,
            sourceSubQueries: r.sourceSubQueries,
          })),
          durationMs,
        });
      }

      // POST /query/sufficiency { russianQuery, retrievedUnits, subQueries }
      // Step 5: Sufficiency check + follow-up query generation.
      if (url.pathname === "/query/sufficiency" && request.method === "POST") {
        const body = await request.json<any>();
        const russianQuery: string = body.russianQuery;
        const subQueries: string[] = body.subQueries;
        if (!russianQuery || !subQueries) {
          return json({ error: "russianQuery and subQueries are required" }, 400);
        }

        // Reconstruct RetrievedUnit[] from the flat JSON
        const retrieved = (body.retrievedUnits ?? []).map((r: any) => ({
          unit: {
            id: r.id,
            type: r.type,
            name: r.name,
            section: r.section,
            page: r.page,
            content: r.content,
          },
          rerankScore: r.rerankScore,
          sourceSubQueries: r.sourceSubQueries,
        }));

        const start = Date.now();
        const result = await checkSufficiency(env, russianQuery, retrieved, subQueries);
        const durationMs = Date.now() - start;
        console.log(`[/query/sufficiency] sufficient=${result.sufficient} gaps=${result.gaps.length} duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "sufficiency", { russianQuery }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }

      // POST /query/answer { question, language, retrievedUnits, subQueries?, gaps? }
      // Step 6: Answer generation with citations.
      if (url.pathname === "/query/answer" && request.method === "POST") {
        const body = await request.json<any>();
        const question: string = body.question;
        if (!question) return json({ error: "question is required" }, 400);

        const retrieved = (body.retrievedUnits ?? []).map((r: any) => ({
          unit: {
            id: r.id,
            type: r.type,
            name: r.name,
            section: r.section,
            page: r.page,
            content: r.content,
          },
          rerankScore: r.rerankScore,
        }));

        const start = Date.now();
        const result = await generateAnswer(env, question, retrieved, {
          language: body.language ?? "ru",
          subQueries: body.subQueries,
          gaps: body.gaps,
        });
        const durationMs = Date.now() - start;
        console.log(`[/query/answer] ${result.citations.length} citations duration=${durationMs}ms`);

        if (body.conversationId) {
          await logQueryStep(env, "answer", { question }, result, durationMs, body.conversationId);
        }

        return json({ ...result, durationMs });
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      console.error(err?.stack ?? err); // full detail in `wrangler tail`, not in the response
      return json({ error: err?.message ?? "internal error" }, 500);
    }
  },
};
