import type { Env, SufficiencyResult, SufficiencyGap, GapType } from "../types";
import type { RetrievedUnit } from "./query";
import { llmJson } from "../utils/llm";
import { RETRIEVAL } from "../config.gen";

const MAX_FOLLOW_UP_QUERIES = RETRIEVAL.sufficiency.maxFollowUpQueries.value;

const GAP_TYPES: GapType[] = [
  "missing_exception",
  "missing_prerequisite",
  "missing_interaction",
  "missing_table_dimension",
  "missing_definition",
  "contradictory_evidence",
  "missing_step",
  "missing_dependency",
  "missing_category_member",
  "other",
];

const SUFFICIENCY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sufficient: { type: "boolean" },
    gaps: { type: "array", items: { type: "string" } },
    categorized_gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: GAP_TYPES },
          description: { type: "string" },
          target: { type: "string" },
          follow_up_query: { type: "string" },
        },
        required: ["type", "description"],
      },
    },
    follow_up_queries: { type: "array", items: { type: "string" }, maxItems: MAX_FOLLOW_UP_QUERIES },
  },
  required: ["sufficient", "gaps", "follow_up_queries"],
};

const SYSTEM_PROMPT = RETRIEVAL.prompts.sufficiency.text;

/** Phase 9: Check sufficiency with categorized gaps and targeted follow-ups.
 *
 *  For complex queries, this is the primary iterative gathering mechanism —
 *  not just a rare fallback. The sufficiency check identifies specific gaps
 *  and generates targeted follow-up queries to fill them. */
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
      categorizedGaps: [{
        type: "missing_definition",
        description: "No evidence was retrieved at all.",
        followUpQuery: russianQuery,
      }],
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
      categorized_gaps?: {
        type: GapType;
        description: string;
        target?: string;
        follow_up_query?: string;
      }[];
      follow_up_queries: string[];
    }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.REASONING_MODEL,
      schema: SUFFICIENCY_SCHEMA,
    });

    const categorizedGaps: SufficiencyGap[] = (result.categorized_gaps ?? []).map((g) => ({
      type: g.type,
      description: g.description,
      target: g.target,
      followUpQuery: g.follow_up_query,
    }));

    // Build follow-up queries from categorized gaps if not provided directly
    const followUpQueries = (result.follow_up_queries ?? [])
      .filter((q) => q.trim().length > 0);

    // If no direct follow-up queries but we have categorized gaps with queries, use those
    const effectiveFollowUps = followUpQueries.length > 0
      ? followUpQueries
      : categorizedGaps
          .map((g) => g.followUpQuery)
          .filter((q): q is string => !!q && q.trim().length > 0);

    return {
      sufficient: result.sufficient ?? false,
      gaps: result.gaps ?? [],
      categorizedGaps,
      followUpQueries: effectiveFollowUps,
    };
  } catch (err) {
    console.warn(`Sufficiency check failed, assuming sufficient: ${String(err)}`);
    return { sufficient: true, gaps: [], categorizedGaps: [], followUpQueries: [] };
  }
}
