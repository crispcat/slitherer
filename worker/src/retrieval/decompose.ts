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
  },
  required: ["sub_queries", "rerank_threshold"],
};

const SYSTEM_PROMPT = RETRIEVAL.prompts.decompose.text;

export async function decompose(
  env: Env,
  russianQuery: string,
  history: ConversationMessage[] = []
): Promise<DecomposeResult> {
  const historyText = history.length > 0
    ? `\n\nConversation history (for context, last ${history.length} messages):\n${history.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const userPrompt = `Question: ${russianQuery}${historyText}`;

  try {
    const result = await llmJson<{
      sub_queries: string[];
      rerank_threshold: number;
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

    return { subQueries, rerankThreshold: threshold };
  } catch (err) {
    throw new Error(`Decomposition failed: ${String(err)}`);
  }
}
