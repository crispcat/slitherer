import type { Env, Relation, RelationType, SemanticUnit, UnitMetadata } from "../types";
import { embed } from "../utils/llm";
import { nextId } from "../utils/ids";
import { INGESTION } from "../config.gen";

/** How many matches to keep per term probe. The correct target always ranks
 *  #1 (verified empirically), so top-K guarantees recall. Confidence =
 *  similarity score, so weak edges are naturally deprioritized in the graph. */
const TOP_K_MATCHES = INGESTION.relationshipExtraction.topKMatches.value;

/** How many results to retrieve from Vectorize per term probe. We cast a wide
 *  net (100) and then take the top TOP_K_MATCHES from the results. */
const VECTOR_SEARCH_TOP_K = INGESTION.relationshipExtraction.vectorSearchTopK.value;

/** Maps each metadata field to its corresponding relation type.
 *  Every term in a field becomes a vector-search probe; the top-K matches
 *  become typed relations with confidence = similarity score. */
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
 *  For every term in the unit's metadata fields, embed the bare term and
 *  search the main semantic-unit vector database. The top-K matches per term
 *  become typed relations with confidence = Vectorize cosine similarity
 *  (bare term vs. candidate's name+summary+content).
 *
 *  No source-unit context pollutes the query — the same term always produces
 *  the same query vector. Empirical testing showed the correct target always
 *  ranks #1, so top-K guarantees recall while confidence naturally
 *  deprioritizes weak edges in graph traversal. */
async function extractVectorSearchRelations(
  env: Env,
  unit: SemanticUnit
): Promise<Relation[]> {
  const probes = collectTermProbes(unit);
  if (probes.length === 0) return [];

  // Deduplicate terms — the same term may appear in multiple fields.
  // We search once per unique term and create relations for each field it appears in.
  const uniqueTerms = Array.from(new Set(probes.map((p) => p.term)));
  const termToTypes = new Map<string, RelationType[]>();
  for (const { term, type } of probes) {
    const existing = termToTypes.get(term) ?? [];
    if (!existing.includes(type)) existing.push(type);
    termToTypes.set(term, existing);
  }

  // Batch-embed bare terms — no source-unit summary to avoid polluting the
  // retrieval signal. The same term always produces the same query vector.
  const vectors = await embed(env, uniqueTerms);

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
    const allMatches = queryResults[i].matches ?? [];

    // Filter self-matches, then take top-K by score (Vectorize returns
    // sorted by score, but self-filtering may shift the order).
    const filtered = allMatches
      .filter((m) => m.id !== unit.id)
      .slice(0, TOP_K_MATCHES);

    for (const match of filtered) {
      const score = typeof match.score === "number" ? match.score : 0;
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
