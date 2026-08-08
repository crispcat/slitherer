import type { Env, SufficiencyResult } from "../types";
import type { RetrievedUnit } from "./query";
import { llmJson } from "../utils/llm";
import { RETRIEVAL } from "../config.gen";

const MAX_FOLLOW_UP_QUERIES = RETRIEVAL.sufficiency.maxFollowUpQueries.value;

const SUFFICIENCY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sufficient: { type: "boolean" },
    gaps: { type: "array", items: { type: "string" } },
    follow_up_queries: { type: "array", items: { type: "string" }, maxItems: MAX_FOLLOW_UP_QUERIES },
  },
  required: ["sufficient", "gaps", "follow_up_queries"],
};

const SYSTEM_PROMPT = RETRIEVAL.prompts.sufficiency.text;

export async function checkSufficiency(
  env: Env,
  russianQuery: string,
  retrieved: RetrievedUnit[],
  subQueries: string[]
): Promise<SufficiencyResult> {
  if (retrieved.length === 0) {
    return {
      sufficient: false,
      gaps: ["No evidence was retrieved at all."],
      followUpQueries: [russianQuery],
    };
  }

  // Group evidence by source sub-query
  const groupedEvidence: string[] = [];
  for (let sqIdx = 0; sqIdx < subQueries.length; sqIdx++) {
    const unitsInGroup = retrieved.filter((r) => r.sourceSubQueries?.includes(sqIdx));
    if (unitsInGroup.length === 0) continue;
    const unitsText = unitsInGroup
      .map((r) => `[${r.unit.id}] (${r.unit.type}, ${r.unit.section.join(" > ")}, page ${r.unit.page})\n${r.unit.content}`)
      .join("\n\n");
    groupedEvidence.push(`--- Sub-query ${sqIdx + 1}: "${subQueries[sqIdx]}" ---\n${unitsText}`);
  }

  const evidenceText = groupedEvidence.join("\n\n");
  const userPrompt = `Question: ${russianQuery}\n\nEvidence (grouped by sub-query):\n${evidenceText}`;

  try {
    const result = await llmJson<{
      sufficient: boolean;
      gaps: string[];
      follow_up_queries: string[];
    }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.ANSWER_MODEL,
      schema: SUFFICIENCY_SCHEMA,
    });

    return {
      sufficient: result.sufficient ?? false,
      gaps: result.gaps ?? [],
      followUpQueries: (result.follow_up_queries ?? []).filter((q) => q.trim().length > 0),
    };
  } catch (err) {
    console.warn(`Sufficiency check failed, assuming sufficient: ${String(err)}`);
    return { sufficient: true, gaps: [], followUpQueries: [] };
  }
}
