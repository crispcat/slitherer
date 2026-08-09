import type { Env, SemanticUnit } from "../types";
import { llmJson } from "../utils/llm";
import { getSemanticUnit, getChildrenOfUnit } from "../utils/db";
import { INGESTION } from "../config.gen";

const CHILDREN_CONTENT_MAX_CHARS = INGESTION.parentContext.childrenMaxChars.value;
const FALLBACK_SUMMARY_LEN = INGESTION.fallbackSummaryLength.value;

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  required: ["summary"],
};

const SYSTEM_PROMPT = INGESTION.prompts.summary.text;

/** Generate a concise summary for a semantic unit using the extraction model.
 *  Context provided to the LLM:
 *  - Parent unit name (not content/summary)
 *  - The unit's own name + content (takes precedence)
 *  - Children names (if aggregate content under threshold)
 *  The LLM is explicitly instructed that the unit's own name and content
 *  take precedence over parent/children context. */
export async function generateSummary(env: Env, unit: SemanticUnit): Promise<string> {
  // Parent name only — no summary or content
  let parentName = "";
  if (unit.parentUnitId) {
    const parent = await getSemanticUnit(env, unit.parentUnitId);
    if (parent) parentName = parent.name ?? "";
  }

  // Children names only (never content). Skip if aggregate content too large.
  let childrenNames = "";
  const children = await getChildrenOfUnit(env, unit.id);
  if (children.length > 0) {
    const totalChildrenContent = children.reduce((sum, c) => sum + c.content.length, 0);
    if (totalChildrenContent <= CHILDREN_CONTENT_MAX_CHARS) {
      childrenNames = children.map((c) => c.name ?? "(unnamed)").join(", ");
    }
  }

  const userPrompt = `Name: ${unit.name ?? "(unnamed)"}\nParent: ${parentName || "(none)"}\nChildren: ${childrenNames || "(none)"}\nContent:\n${unit.content}`;

  try {
    const result = await llmJson<{ summary: string }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.EXTRACTION_MODEL,
      schema: SUMMARY_SCHEMA,
    });
    return result.summary ?? unit.content.slice(0, FALLBACK_SUMMARY_LEN);
  } catch {
    return unit.content.slice(0, FALLBACK_SUMMARY_LEN);
  }
}
