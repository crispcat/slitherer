import type { Env, ConversationMessage, DecomposeResult } from "../types";
import { llmJson } from "../utils/llm";
import { RETRIEVAL } from "../config.gen";

const MAX_SUB_QUERIES = RETRIEVAL.decomposition.maxSubQueries.value;
const FALLBACK_RERANK_THRESHOLD = RETRIEVAL.decomposition.fallbackRerankThreshold.value;

const DECOMPOSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sub_queries: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_SUB_QUERIES,
    },
    rerank_threshold: { type: "number" },
    is_list_query: { type: "boolean" },
    query_complexity: { type: "string", enum: ["simple", "complex"] },
  },
  required: ["sub_queries", "rerank_threshold"],
};

const SYSTEM_PROMPT = RETRIEVAL.prompts.decompose.text;

export async function decompose(
  env: Env,
  russianQuery: string,
  history: ConversationMessage[] = [],
  originalQuery?: string,
  entities?: string[],
): Promise<DecomposeResult> {
  const historyText = history.length > 0
    ? `\n\nConversation history (for context, last ${history.length} messages):\n${history.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  // Phase 8: Include original query and entities for context
  const originalText = originalQuery && originalQuery !== russianQuery
    ? `\n\nOriginal query (in user's language): ${originalQuery}`
    : "";
  const entitiesText = entities && entities.length > 0
    ? `\n\nExtracted entities (proper nouns, abbreviations, numbers, dice notation, item names, acronyms, game terminology — preserve these exactly in sub-queries): ${entities.join(", ")}`
    : "";

  const userPrompt = `Question: ${russianQuery}${originalText}${entitiesText}${historyText}`;

  try {
    const result = await llmJson<{
      sub_queries: string[];
      rerank_threshold: number;
      is_list_query?: boolean;
      query_complexity?: "simple" | "complex";
    }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.REASONING_MODEL,
      schema: DECOMPOSE_SCHEMA,
    });

    const subQueries = (result.sub_queries ?? []).filter((q) => q.trim().length > 0);
    if (subQueries.length === 0) {
      throw new Error("Decomposition produced no sub-queries");
    }

    const threshold = typeof result.rerank_threshold === "number"
      ? Math.max(0, Math.min(1, result.rerank_threshold))
      : FALLBACK_RERANK_THRESHOLD;

    return {
      subQueries,
      rerankThreshold: threshold,
      isListQuery: result.is_list_query === true,
      queryComplexity: result.query_complexity === "complex" ? "complex" : "simple",
    };
  } catch (err) {
    throw new Error(`Decomposition failed: ${String(err)}`);
  }
}
