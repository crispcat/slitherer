import type { Env, Relation, RelationType, SemanticUnit, UnitMetadata } from "../types";
import { embed } from "../utils/llm";
import { nextId } from "../utils/ids";
import { INGESTION } from "../config.gen";

/** Minimum vector similarity score for a relationship match to be kept.
 *  bge-m3 produces normalized embeddings, so cosine similarity is in [0, 1]. */
const SIMILARITY_THRESHOLD = INGESTION.relationshipExtraction.similarityThreshold.value;

/** How many vector matches to retrieve per term. We cast a wide net and let
 *  SIMILARITY_THRESHOLD filter the results — no fixed topN on the final set. */
const VECTOR_SEARCH_TOP_K = INGESTION.relationshipExtraction.vectorSearchTopK.value;

/** Maps each metadata field to its corresponding relation type.
 *  Every term in a field becomes a vector-search probe; matches above the
 *  similarity threshold become typed relations with confidence = similarity. */
const FIELD_TO_RELATION_TYPE: { field: keyof UnitMetadata; type: RelationType }[] = [
  { field: "defines", type: "defines" },
  { field: "references", type: "references" },
  { field: "requires", type: "requires" },
  { field: "exceptions", type: "excepts" },
  { field: "modifies", type: "modifies" },
  { field: "modified_by", type: "modified_by" },
  { field: "overrides", type: "overrides" },
  { field: "related_to", type: "related_to" },
  { field: "incompatible_with", type: "incompatible_with" },
  { field: "creates", type: "creates" },
  { field: "consumes", type: "consumes" },
  { field: "supersedes", type: "supersedes" },
  { field: "example_of", type: "example_of" },
  { field: "part_of", type: "part_of" },
];

/** Collect all (term, relationType) probes from a unit's metadata fields. */
function collectTermProbes(unit: SemanticUnit): { term: string; type: RelationType }[] {
  const probes: { term: string; type: RelationType }[] = [];
  const meta = unit.metadata;
  if (!meta) return probes;

  for (const { field, type } of FIELD_TO_RELATION_TYPE) {
    const terms = meta[field] ?? [];
    for (const term of terms) {
      const trimmed = term.trim();
      if (trimmed.length > 1) {
        probes.push({ term: trimmed, type });
      }
    }
  }
  return probes;
}

/** Vector-search-based relationship extraction.
 *
 *  For every term in the unit's metadata fields, construct a short embedding
 *  from the term + the unit's summary, search the main semantic-unit vector
 *  database, and create typed relations with confidence = similarity score
 *  from the vector search. Matches below SIMILARITY_THRESHOLD are discarded.
 *
 *  This replaces both the deterministic string-matching resolution and the
 *  LLM relation pass from the previous implementation. Vector search catches
 *  fuzzy/semantic matches that exact string matching misses, and the
 *  similarity score provides a meaningful confidence value rather than a
 *  fixed constant. */
async function extractVectorSearchRelations(
  env: Env,
  unit: SemanticUnit
): Promise<Relation[]> {
  const probes = collectTermProbes(unit);
  if (probes.length === 0) return [];

  const summary = unit.summary ?? unit.content.slice(0, INGESTION.fallbackSummaryLength.value);

  // Deduplicate terms — the same term may appear in multiple fields.
  // We search once per unique term and create relations for each field it appears in.
  const uniqueTerms = Array.from(new Set(probes.map((p) => p.term)));
  const termToTypes = new Map<string, RelationType[]>();
  for (const { term, type } of probes) {
    const existing = termToTypes.get(term) ?? [];
    if (!existing.includes(type)) existing.push(type);
    termToTypes.set(term, existing);
  }

  // Batch-embed all unique terms (term + summary).
  const embedInputs = uniqueTerms.map((term) => `${term} ${summary}`);
  const vectors = await embed(env, embedInputs);

  // Query Vectorize for each term embedding in parallel.
  const queryResults = await Promise.all(
    vectors.map((vec) =>
      env.VECTORIZE_INDEX.query(vec, { topK: VECTOR_SEARCH_TOP_K, returnMetadata: true })
    )
  );

  const relations: Relation[] = [];
  for (let i = 0; i < uniqueTerms.length; i++) {
    const term = uniqueTerms[i];
    const types = termToTypes.get(term)!;
    const matches = queryResults[i].matches ?? [];

    for (const match of matches) {
      // Don't create self-relations.
      if (match.id === unit.id) continue;

      const score = typeof match.score === "number" ? match.score : 0;
      if (score < SIMILARITY_THRESHOLD) continue;

      for (const relationType of types) {
        relations.push({
          id: nextId("REL"),
          source: unit.id,
          target: match.id,
          relation_type: relationType,
          confidence: score,
        });
      }
    }
  }

  return relations;
}

export async function extractRelationships(
  env: Env,
  unit: SemanticUnit
): Promise<Relation[]> {
  const relations = await extractVectorSearchRelations(env, unit);

  // Deduplicate on (source, target, relation_type).
  const seen = new Set<string>();
  const unique: Relation[] = [];
  for (const r of relations) {
    const key = `${r.source}|${r.target}|${r.relation_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique;
}
