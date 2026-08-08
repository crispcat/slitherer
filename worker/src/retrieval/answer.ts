import type { Citation, Env, QueryResult } from "../types";
import type { RetrievedUnit } from "./query";
import { llmText } from "../utils/llm";
import { RETRIEVAL } from "../config.gen";

const SYSTEM_PROMPT = RETRIEVAL.prompts.answer.text;
const CITATION_ID_PATTERN = new RegExp(RETRIEVAL.answer.citationIdPattern.value, "g");
const STREAMING_CHUNK_SIZE = RETRIEVAL.pipeline.streamingChunkSize.value;

interface AnswerContext {
  language: string;
  subQueries?: string[];
  gaps?: string[];
}

export async function generateAnswer(
  env: Env,
  question: string,
  retrieved: RetrievedUnit[],
  context: AnswerContext
): Promise<QueryResult> {
  if (retrieved.length === 0) {
    return {
      answer: "В базе знаний не найдено информации, относящейся к этому вопросу.",
      citations: [],
      usedUnitIds: [],
      language: context.language,
    };
  }

  const evidence = retrieved
    .map(
      (r) =>
        `[${r.unit.id}] (${r.unit.type}, ${r.unit.section.join(" > ")}, page ${r.unit.page})\n${r.unit.content}`
    )
    .join("\n\n---\n\n");

  let contextSection = "";
  if (context.subQueries && context.subQueries.length > 0) {
    contextSection += `\n\nSearch sub-queries used:\n${context.subQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;
  }
  if (context.gaps && context.gaps.length > 0) {
    contextSection += `\n\nIdentified gaps (information that could not be found):\n${context.gaps.map((g) => `- ${g}`).join("\n")}`;
  }

  const userPrompt = `QUESTION:\n${question}\n\nEVIDENCE:\n${evidence}${contextSection}\n\nAnswer in language: ${context.language}`;
  const answer = await llmText(env, SYSTEM_PROMPT, userPrompt, env.ANSWER_MODEL);

  CITATION_ID_PATTERN.lastIndex = 0;
  const usedUnitIds = [...new Set((answer.match(CITATION_ID_PATTERN) ?? []))].filter((id) =>
    retrieved.some((r) => r.unit.id === id)
  );

  const citations: Citation[] = retrieved
    .filter((r) => usedUnitIds.includes(r.unit.id))
    .map((r) => ({ unitId: r.unit.id, section: r.unit.section.join(" > "), page: r.unit.page }));

  return { answer, citations, usedUnitIds, language: context.language };
}

/** Generate answer as a stream of tokens. Returns an async generator yielding text chunks.
 *  Used for streaming mode (interactive UI). */
export async function* generateAnswerStream(
  env: Env,
  question: string,
  retrieved: RetrievedUnit[],
  context: AnswerContext
): AsyncGenerator<string, QueryResult, unknown> {
  // For streaming, we first generate the full answer (Workers AI doesn't support
  // true token streaming yet), then yield it in chunks to simulate streaming.
  // When Workers AI adds streaming support, this can be replaced with a real stream.
  const result = await generateAnswer(env, question, retrieved, context);

  // Yield in chunks to simulate streaming
  const chunkSize = STREAMING_CHUNK_SIZE;
  for (let i = 0; i < result.answer.length; i += chunkSize) {
    yield result.answer.slice(i, i + chunkSize);
  }

  return result;
}
