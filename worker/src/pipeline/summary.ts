import type { Env, SemanticUnit } from "../types";
import { llmJson } from "../utils/llm";
import { getSemanticUnit } from "../utils/db";
import { INGESTION } from "../config.gen";

// Cap parent context so the prompt stays within the 70b model's budget.
const PARENT_CONTEXT_MAX_CHARS = INGESTION.parentContext.maxChars.value;
const FALLBACK_SUMMARY_LEN = INGESTION.fallbackSummaryLength.value;

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

const SYSTEM_PROMPT = INGESTION.prompts.summary.text;

/** Generate a concise summary for a semantic unit using the 70b model.
 *  Parent unit summaries (when available) are injected as context so child
 *  units — especially table cells and orphan-linked modifiers — get meaningful
 *  summaries that incorporate their parent's meaning. */
export async function generateSummary(env: Env, unit: SemanticUnit): Promise<string> {
  let parentContext = "";
  if (unit.parentUnitId) {
    const parent = await getSemanticUnit(env, unit.parentUnitId);
    if (parent) {
      const parentName = parent.name ?? "(unnamed)";
      const parentText = (parent.summary ?? parent.content).slice(0, PARENT_CONTEXT_MAX_CHARS);
      parentContext = `\nParent Unit (${parent.type}, ${parentName}):\n${parentText}`;
    }
  }
  if (unit.secondaryParentUnitId) {
    const colParent = await getSemanticUnit(env, unit.secondaryParentUnitId);
    if (colParent) {
      const colName = colParent.name ?? "(unnamed)";
      const colText = (colParent.summary ?? colParent.content).slice(0, PARENT_CONTEXT_MAX_CHARS);
      parentContext += `\nColumn Parent (${colParent.type}, ${colName}):\n${colText}`;
    }
  }

  const userPrompt = `Type: ${unit.type}\nName: ${unit.name ?? "(unnamed)"}\nSection: ${unit.section.join(" > ")}${parentContext}\nContent:\n${unit.content}`;

  try {
    const result = await llmJson<{ summary: string }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.ANSWER_MODEL,
      schema: SUMMARY_SCHEMA,
    });
    return result.summary ?? unit.content.slice(0, FALLBACK_SUMMARY_LEN);
  } catch {
    return unit.content.slice(0, FALLBACK_SUMMARY_LEN);
  }
}
