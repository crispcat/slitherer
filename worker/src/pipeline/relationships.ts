import type { Env, Relation, RelationType, SemanticUnit } from "../types";
import { RELATION_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { nextId } from "../utils/ids";

interface RawRelation {
  target_name: string;
  relation_type: string;
  confidence: number;
}

const RELATION_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      target_name: { type: "string" },
      relation_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["target_name", "relation_type", "confidence"],
  },
};

const SYSTEM_PROMPT = `You are a rules-analysis engine for a tabletop RPG rulebook (Russian language).
Given a semantic unit and a list of CANDIDATE related units (id, name, type, short summary), decide
which candidates this unit actually relates to and how.

Valid relation types: ${RELATION_TYPES.join(", ")}.

Respond with ONLY a JSON array of the form:
[{"target_name": "<candidate name exactly as given>", "relation_type": "modifies", "confidence": 0.0-1.0}]

Only include relations you are reasonably confident about (based on explicit textual evidence: named
references, shared mechanics, explicit modification/exception language). Omit anything speculative.
If there are no clear relations, return [].`;

export async function extractRelationships(
  env: Env,
  unit: SemanticUnit,
  candidates: SemanticUnit[]
): Promise<Relation[]> {
  if (candidates.length === 0) return [];

  const candidateList = candidates
    .map((c) => `- id=${c.id} | name=${c.name ?? "(unnamed)"} | type=${c.type} | summary=${c.summary ?? c.content.slice(0, 120)}`)
    .join("\n");

  const userPrompt = `SOURCE UNIT\nid=${unit.id}\nname=${unit.name ?? "(unnamed)"}\ntype=${unit.type}\ncontent:\n${unit.content}\n\nCANDIDATES\n${candidateList}`;

  let raw: RawRelation[];
  try {
    raw = await llmJson<RawRelation[]>(env, SYSTEM_PROMPT, userPrompt, { model: env.EXTRACTION_MODEL, schema: RELATION_SCHEMA });
    if (!Array.isArray(raw)) raw = [];
  } catch {
    raw = [];
  }

  const byName = new Map(candidates.map((c) => [c.name ?? "", c.id]));
  const relations: Relation[] = [];
  for (const r of raw) {
    const targetId = byName.get(r.target_name);
    if (!targetId) continue;
    const relationType = RELATION_TYPES.includes(r.relation_type as RelationType) ? (r.relation_type as RelationType) : "related_to";
    const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    relations.push({
      id: nextId("REL"),
      source: unit.id,
      target: targetId,
      relation_type: relationType,
      confidence,
    });
  }
  return relations;
}
