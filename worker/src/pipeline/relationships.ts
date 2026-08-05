import type { Env, Relation, RelationType, SemanticUnit, UnitMetadata } from "../types";
import { RELATION_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { nextId } from "../utils/ids";

interface RawRelation {
  target_id?: string;
  target_name?: string;
  relation_type: string;
  confidence: number;
}

const RELATION_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      target_id: { type: "string" },
      target_name: { type: "string" },
      relation_type: { type: "string" },
      confidence: { type: "number" },
    },
    required: ["relation_type", "confidence"],
  },
};

const SYSTEM_PROMPT = `You are a rules-analysis engine for a tabletop RPG rulebook (Russian language).
Given a semantic unit and a list of CANDIDATE related units (id, name, type, short summary), decide
which candidates this unit actually relates to and how.

Valid relation types: ${RELATION_TYPES.join(", ")}.

Respond with ONLY a JSON array of the form:
[{"target_id": "<candidate id>", "relation_type": "modifies", "confidence": 0.0-1.0}]

Prefer target_id. Only use target_name when the candidate has a clear, unique name.
Only include relations you are reasonably confident about (based on explicit textual evidence: named
references, shared mechanics, explicit modification/exception language). Omit anything speculative.
If there are no clear relations, return [].`;

const RELATION_FROM_METADATA: { field: keyof UnitMetadata; type: RelationType }[] = [
  { field: "references", type: "references" },
  { field: "requires", type: "requires" },
  { field: "modifies", type: "modifies" },
  { field: "modified_by", type: "modified_by" },
  { field: "exceptions", type: "excepts" },
];

function normalizeRef(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Try to resolve a reference string from metadata to one of the candidate units. */
function resolveReference(name: string, candidates: SemanticUnit[]): SemanticUnit | null {
  const normalized = normalizeRef(name);
  if (!normalized) return null;

  // Exact name match
  for (const c of candidates) {
    if (normalizeRef(c.name ?? "") === normalized) return c;
  }

  // Metadata.defines match
  for (const c of candidates) {
    const defines = c.metadata?.defines ?? [];
    if (defines.some((d) => normalizeRef(d) === normalized)) return c;
  }

  // Section path match (references are often section titles)
  for (const c of candidates) {
    if (c.section.some((s) => normalizeRef(s).includes(normalized))) return c;
  }

  // Content / summary substring match
  for (const c of candidates) {
    if (normalizeRef(c.content).includes(normalized)) return c;
    if (c.summary && normalizeRef(c.summary).includes(normalized)) return c;
  }

  return null;
}

/** Build deterministic adjacency relations for units split from the same source node. */
function extractAdjacencyRelations(unit: SemanticUnit, candidates: SemanticUnit[]): Relation[] {
  const siblings = candidates.filter((c) => c.sourceNodeId === unit.sourceNodeId && c.sourceOrder != null);
  if (siblings.length <= 1) return [];

  siblings.sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
  const index = siblings.findIndex((c) => c.id === unit.id);
  if (index === -1) return [];

  const relations: Relation[] = [];
  const addEdge = (target: SemanticUnit) => {
    relations.push({
      id: nextId("REL"),
      source: unit.id,
      target: target.id,
      relation_type: "related_to",
      confidence: 0.85,
    });
  };

  // Link to immediate predecessor and successor so precedence is captured.
  if (index > 0) addEdge(siblings[index - 1]);
  if (index < siblings.length - 1) addEdge(siblings[index + 1]);

  return relations;
}

interface MetadataRelationResult {
  relations: Relation[];
  unresolved: string[];
}

/** Build relations from the explicit metadata fields produced in Phase 4.
 *  Returns both resolved edges and unresolved reference strings for later reporting. */
function extractMetadataRelations(unit: SemanticUnit, candidates: SemanticUnit[]): MetadataRelationResult {
  const relations: Relation[] = [];
  const unresolved: string[] = [];
  for (const { field, type } of RELATION_FROM_METADATA) {
    const names = unit.metadata?.[field] ?? [];
    for (const name of names) {
      const target = resolveReference(name, candidates);
      if (target) {
        relations.push({
          id: nextId("REL"),
          source: unit.id,
          target: target.id,
          relation_type: type,
          confidence: 0.9,
        });
      } else {
        unresolved.push(name);
      }
    }
  }
  return { relations, unresolved };
}

function validateRelationships(unit: SemanticUnit, unresolved: string[]): string[] {
  // Only flag substantive references (single characters and tiny fragments are usually noise).
  const metadataOrphans = Array.from(new Set(unresolved.filter((name) => name.trim().length > 1)));

  if (metadataOrphans.length > 0) {
    console.warn(
      `Relationship validation for unit ${unit.id} (${unit.name ?? "unnamed"}) flagged ${metadataOrphans.length} unresolved reference(s): ${metadataOrphans.slice(0, 5).join(", ")}`
    );
  }

  return metadataOrphans;
}

async function extractLLMRelations(
  env: Env,
  unit: SemanticUnit,
  candidates: SemanticUnit[]
): Promise<Relation[]> {
  if (candidates.length === 0) return [];

  const candidateList = candidates
    .map((c) => {
      const sameSource = c.sourceNodeId === unit.sourceNodeId ? " [same source node]" : "";
      return `- id=${c.id} | name=${c.name ?? "(unnamed)"} | type=${c.type}${sameSource} | summary=${c.summary ?? c.content.slice(0, 120)}`;
    })
    .join("\n");

  const userPrompt = `SOURCE UNIT\nid=${unit.id}\nname=${unit.name ?? "(unnamed)"}\ntype=${unit.type}\ncontent:\n${unit.content}\n\nCANDIDATES\n${candidateList}`;

  let raw: RawRelation[];
  try {
    raw = await llmJson<RawRelation[]>(env, SYSTEM_PROMPT, userPrompt, { model: env.EXTRACTION_MODEL, schema: RELATION_SCHEMA });
    if (!Array.isArray(raw)) raw = [];
  } catch {
    raw = [];
  }

  const byId = new Map(candidates.map((c) => [c.id, c.id]));
  const byName = new Map(candidates.map((c) => [c.name ?? "", c.id]));
  const relations: Relation[] = [];
  for (const r of raw) {
    let targetId: string | undefined;
    if (r.target_id && byId.has(r.target_id)) {
      targetId = r.target_id;
    } else if (r.target_name && byName.has(r.target_name)) {
      targetId = byName.get(r.target_name);
    }
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

export async function extractRelationships(
  env: Env,
  unit: SemanticUnit,
  candidates: SemanticUnit[]
): Promise<Relation[]> {
  const adjacencyRelations = extractAdjacencyRelations(unit, candidates);
  const { relations: metadataRelations, unresolved } = extractMetadataRelations(unit, candidates);
  const llmRelations = await extractLLMRelations(env, unit, candidates);

  const seen = new Set<string>();
  const relations: Relation[] = [];
  for (const r of [...adjacencyRelations, ...metadataRelations, ...llmRelations]) {
    const key = `${r.source}|${r.target}|${r.relation_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push(r);
  }

  // Flag unresolved metadata references so the operator can see what the model
  // thought existed but could not be linked to any known unit.
  const metadataOrphans = validateRelationships(unit, unresolved);
  if (metadataOrphans.length > 0) {
    const base = unit.metadata ?? {
      defines: [],
      references: [],
      requires: [],
      exceptions: [],
      modifies: [],
      modified_by: [],
      keywords: [],
      aliases: [],
      summary: "",
    };
    unit.metadata = {
      ...base,
      unresolved_references: metadataOrphans.slice(0, 20),
    };
  }

  return relations;
}
