import type { Env, SemanticUnit } from "../types";
import { embed, rerank } from "../utils/llm";
import { getUnitsByIds, getChildrenOfUnit, getParentOfUnit } from "../utils/db";
import { buildRerankDocument } from "../pipeline/embeddings";
import { RETRIEVAL } from "../config.gen";

export interface RetrievedUnit {
  unit: SemanticUnit;
  vectorScore?: number;
  rerankScore?: number;
  /** Phase 6: final ranking score from the weighted formula. */
  finalScore?: number;
  viaRelation?: string;
  expansionRole?: "seed" | "parent" | "sibling" | "child";
  /** Which sub-query(ies) found this candidate. */
  sourceSubQueries?: number[];
  /** Phase 5: structured provenance for diagnostics and evidence selection. */
  provenance?: CandidateProvenance;
}

/** Phase 5: Structured provenance for a candidate. */
export interface CandidateProvenance {
  sources: {
    type: "vector_subject" | "vector_content" | "lexical" | "parent" | "sibling" | "child" | "concept";
    rank?: number;
    score?: number;
    subQueryIndex?: number;
    parentUnitId?: string;
    conceptId?: string;
  }[];
}

// Phase 4: Hybrid retrieval config
const SUBJECT_TOP_K = RETRIEVAL.retrieval.subjectTopK.value;
const CONTENT_TOP_K = RETRIEVAL.retrieval.contentTopK.value;
const LEXICAL_TOP_K = RETRIEVAL.retrieval.lexicalTopK.value;
const RRF_K = RETRIEVAL.retrieval.rrfK.value;

// Phase 5: Expansion config
const CONCEPT_EXPANSION_TOP_K = RETRIEVAL.retrieval.conceptExpansionTopK.value;
const CONCEPT_UNITS_PER_CONCEPT = RETRIEVAL.retrieval.conceptUnitsPerConcept.value;
const MAX_CANDIDATES = RETRIEVAL.retrieval.maxCandidates.value;

// Phase 6: Ranking config
const WEIGHT_RERANK = RETRIEVAL.ranking.weightRerank.value;
const WEIGHT_COVERAGE = RETRIEVAL.ranking.weightCoverage.value;
const WEIGHT_DIRECT_HIT = RETRIEVAL.ranking.weightDirectHit.value;
const WEIGHT_DIVERSITY = RETRIEVAL.ranking.weightDiversity.value;
const RERANK_THRESHOLD = RETRIEVAL.rerank.threshold.value;
const RERANK_MAX_RESULTS = RETRIEVAL.rerank.maxResults.value;
const RERANK_FALLBACK_TOP_K = RETRIEVAL.rerank.fallbackTopK.value;

// Phase 5: Table type set for type-driven expansion
const TABLE_TYPES = new Set(["DataTableHeader", "DataTableRow", "ColumnListTable", "ColumnListItem"]);

interface SubQueryResult {
  subQueryIndex: number;
  candidates: Map<string, RetrievedUnit>;
}

/** FTS5 lexical search via D1. Returns unit IDs ranked by FTS5 relevance. */
async function lexicalSearch(env: Env, query: string, topK: number): Promise<{ id: string; rank: number; score: number }[]> {
  try {
    const sanitized = query.replace(/["'*:]/g, " ").trim();
    if (!sanitized) return [];

    const { results } = await env.DB.prepare(
      `SELECT rowid, bm25(semantic_unit_search) as score
       FROM semantic_unit_search
       WHERE semantic_unit_search MATCH ?
       ORDER BY score
       LIMIT ?`
    ).bind(sanitized, topK).all();

    if (!results || results.length === 0) return [];

    const rowids = results.map((r: any) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const { results: unitRows } = await env.DB.prepare(
      `SELECT rowid, id FROM semantic_units WHERE rowid IN (${placeholders})`
    ).bind(...rowids).all();

    const rowidToId = new Map<number, string>();
    for (const r of unitRows ?? []) {
      rowidToId.set((r as any).rowid, (r as any).id);
    }

    return results.map((r: any, index: number) => ({
      id: rowidToId.get(r.rowid) ?? "",
      rank: index + 1,
      score: -r.score,
    })).filter((r) => r.id !== "");
  } catch {
    return [];
  }
}

/** Reciprocal Rank Fusion: combine multiple ranked lists into a single ranking. */
function rrfFuse(
  subjectResults: { id: string; rank: number; score: number }[],
  contentResults: { id: string; rank: number; score: number }[],
  lexicalResults: { id: string; rank: number; score: number }[],
  k: number,
): Map<string, { rrfScore: number; sources: ("vector_subject" | "vector_content" | "lexical")[] }> {
  const fused = new Map<string, { rrfScore: number; sources: ("vector_subject" | "vector_content" | "lexical")[] }>();

  const addResult = (results: { id: string; rank: number }[], type: "vector_subject" | "vector_content" | "lexical") => {
    for (const r of results) {
      const existing = fused.get(r.id);
      const contribution = 1 / (k + r.rank);
      if (existing) {
        existing.rrfScore += contribution;
        if (!existing.sources.includes(type)) existing.sources.push(type);
      } else {
        fused.set(r.id, { rrfScore: contribution, sources: [type] });
      }
    }
  };

  addResult(subjectResults, "vector_subject");
  addResult(contentResults, "vector_content");
  addResult(lexicalResults, "lexical");

  return fused;
}

/** Phase 5: Concept expansion — find related units via the concept layer.
 *  For each seed unit, find its concept mentions, then find other units
 *  that mention the same concepts. This is the related-rule discovery mechanism
 *  that replaces graph relations.
 *
 *  Runs BEFORE hierarchy expansion to ensure concept candidates (which have
 *  genuine similarity scores) are not starved by structural expansion. */
async function expandConcepts(
  env: Env,
  seeds: RetrievedUnit[],
  existingIds: Set<string>,
  candidates: Map<string, RetrievedUnit>,
): Promise<void> {
  if (seeds.length === 0) return;

  // Get concept mentions for all seed units
  const seedIds = seeds.map((s) => s.unit.id);
  const placeholders = seedIds.map(() => "?").join(",");
  const { results: mentionRows } = await env.DB.prepare(
    `SELECT concept_id, unit_id FROM concept_mentions WHERE unit_id IN (${placeholders})`
  ).bind(...seedIds).all();

  if (!mentionRows || mentionRows.length === 0) return;

  // Group by concept: conceptId → set of seed unit IDs
  const conceptToSeeds = new Map<string, Set<string>>();
  for (const r of mentionRows) {
    const conceptId = (r as any).concept_id;
    const unitId = (r as any).unit_id;
    const set = conceptToSeeds.get(conceptId) ?? new Set();
    set.add(unitId);
    conceptToSeeds.set(conceptId, set);
  }

  // For each concept, find other units that mention it
  const conceptIds = [...conceptToSeeds.keys()].slice(0, CONCEPT_EXPANSION_TOP_K);
  const newUnitIds = new Set<string>();

  for (const conceptId of conceptIds) {
    const seedUnitIds = conceptToSeeds.get(conceptId)!;
    const { results: otherMentions } = await env.DB.prepare(
      `SELECT unit_id FROM concept_mentions WHERE concept_id = ? AND unit_id NOT IN (${placeholders})
       LIMIT ?`
    ).bind(conceptId, ...[...seedUnitIds], CONCEPT_UNITS_PER_CONCEPT).all();

    for (const r of otherMentions ?? []) {
      const unitId = (r as any).unit_id;
      if (!existingIds.has(unitId) && !candidates.has(unitId)) {
        newUnitIds.add(unitId);
        // Track which concept brought this unit
        const existing = candidates.get(unitId);
        if (!existing) {
          // Will be filled after fetching units
        }
      }
    }
  }

  if (newUnitIds.size === 0) return;

  // Fetch full units
  const expandedUnits = await getUnitsByIds(env, [...newUnitIds]);
  for (const u of expandedUnits) {
    if (candidates.has(u.id) || existingIds.has(u.id)) continue;
    candidates.set(u.id, {
      unit: u,
      viaRelation: "concept_expansion",
      expansionRole: "seed",
      sourceSubQueries: [],
      provenance: { sources: [] }, // concept sources will be filled below
    });
  }

  // Fill concept provenance for expanded units
  for (const conceptId of conceptIds) {
    const { results: mentions } = await env.DB.prepare(
      `SELECT unit_id FROM concept_mentions WHERE concept_id = ?`
    ).bind(conceptId).all();

    for (const r of mentions ?? []) {
      const unitId = (r as any).unit_id;
      const candidate = candidates.get(unitId);
      if (candidate && candidate.provenance) {
        candidate.provenance.sources.push({
          type: "concept",
          conceptId,
        });
      }
    }
  }
}

/** Phase 5: Type-driven hierarchy expansion.
 *
 *  Expansion rules based on seed unit type:
 *  | Seed type           | Parent | Siblings     | Children       |
 *  | Rule                | No     | No           | No             |
 *  | DataTableHeader     | Yes    | No           | All children   |
 *  | DataTableRow        | Yes    | All siblings | No             |
 *  | ColumnListTable     | Yes    | No           | All children   |
 *  | ColumnListItem      | Yes    | No           | All children   |
 *  | Image               | No     | No           | No             |
 *
 *  Structural candidates do NOT receive invented reranker scores.
 *  They are included for context but ranked based on their own rerank scores. */
async function expandHierarchy(
  env: Env,
  seeds: RetrievedUnit[],
  existingIds: Set<string>,
  candidates: Map<string, RetrievedUnit>,
): Promise<void> {
  const expandedIds = new Set<string>();
  const expansionInfo = new Map<string, { role: "parent" | "sibling" | "child"; parentUnitId?: string }>();

  for (const seed of seeds) {
    const u = seed.unit;
    const type = u.type;

    // Skip non-table types — no hierarchy expansion for Rules or Images
    if (!TABLE_TYPES.has(type)) continue;

    // Parent expansion (all table types except Image)
    if (u.parentUnitId) {
      if (!candidates.has(u.parentUnitId) && !existingIds.has(u.parentUnitId)) {
        expandedIds.add(u.parentUnitId);
        expansionInfo.set(u.parentUnitId, { role: "parent", parentUnitId: u.parentUnitId });
      }

      // Sibling expansion (only for DataTableRow)
      if (type === "DataTableRow") {
        const siblings = await getChildrenOfUnit(env, u.parentUnitId);
        for (const s of siblings) {
          if (s.id !== u.id && !candidates.has(s.id) && !existingIds.has(s.id)) {
            expandedIds.add(s.id);
            expansionInfo.set(s.id, { role: "sibling", parentUnitId: u.parentUnitId });
          }
        }
      }
    }

    // Children expansion (DataTableHeader, ColumnListTable, ColumnListItem)
    if (type === "DataTableHeader" || type === "ColumnListTable" || type === "ColumnListItem") {
      const children = await getChildrenOfUnit(env, u.id);
      for (const c of children) {
        if (!candidates.has(c.id) && !existingIds.has(c.id)) {
          expandedIds.add(c.id);
          expansionInfo.set(c.id, { role: "child", parentUnitId: u.id });
        }
      }
    }
  }

  if (expandedIds.size === 0) return;

  const expandedUnits = await getUnitsByIds(env, [...expandedIds]);
  for (const u of expandedUnits) {
    if (candidates.has(u.id) || existingIds.has(u.id)) continue;
    const info = expansionInfo.get(u.id);
    candidates.set(u.id, {
      unit: u,
      viaRelation: "hierarchy_expansion",
      expansionRole: info?.role ?? "sibling",
      sourceSubQueries: [],
      provenance: {
        sources: [{
          type: info?.role ?? "sibling",
          parentUnitId: info?.parentUnitId,
        }],
      },
    });
  }
}

/** Retrieve candidates for a single sub-query using hybrid retrieval:
 *  subject vector search + content vector search + FTS5 lexical search,
 *  fused via Reciprocal Rank Fusion (RRF). */
async function retrieveForSubQuery(
  env: Env,
  subQuery: string,
  subQueryIndex: number,
  existingIds?: Set<string>
): Promise<SubQueryResult> {
  const candidates = new Map<string, RetrievedUnit>();

  // 1. Embed the subquery
  const [queryVector] = await embed(env, [subQuery]);

  // 2. Subject vector search
  const subjectMatches = await env.VECTORIZE_SUBJECTS.query(queryVector, {
    topK: SUBJECT_TOP_K,
    returnMetadata: true,
  });
  const subjectResults = (subjectMatches.matches ?? [])
    .filter((m) => !existingIds?.has(m.id))
    .map((m, i) => ({ id: m.id, rank: i + 1, score: m.score ?? 0 }));

  // 3. Content vector search
  const contentMatches = await env.VECTORIZE_CONTENT.query(queryVector, {
    topK: CONTENT_TOP_K,
    returnMetadata: true,
  });
  const contentResults = (contentMatches.matches ?? [])
    .filter((m) => !existingIds?.has(m.id))
    .map((m, i) => ({ id: m.id, rank: i + 1, score: m.score ?? 0 }));

  // 4. FTS5 lexical search
  const lexicalResults = (await lexicalSearch(env, subQuery, LEXICAL_TOP_K))
    .filter((r) => !existingIds?.has(r.id));

  // 5. Fuse via RRF
  const fused = rrfFuse(subjectResults, contentResults, lexicalResults, RRF_K);

  // 6. Build candidate map with provenance
  const seedIds: string[] = [];
  for (const [id, fusion] of fused) {
    seedIds.push(id);
    const provenanceSources: CandidateProvenance["sources"] = [];
    for (const source of fusion.sources) {
      const sourceResult = source === "vector_subject" ? subjectResults : source === "vector_content" ? contentResults : lexicalResults;
      const match = sourceResult.find((r) => r.id === id);
      provenanceSources.push({
        type: source,
        rank: match?.rank,
        score: match?.score,
        subQueryIndex,
      });
    }
    candidates.set(id, {
      unit: null as any,
      vectorScore: fusion.rrfScore,
      expansionRole: "seed",
      sourceSubQueries: [subQueryIndex],
      provenance: { sources: provenanceSources },
    });
  }

  if (seedIds.length === 0) return { subQueryIndex, candidates };

  // Fetch full units for seeds
  const seedUnits = await getUnitsByIds(env, seedIds);
  for (const u of seedUnits) {
    const existing = candidates.get(u.id);
    if (existing) existing.unit = u;
  }

  // Remove candidates whose units couldn't be fetched
  for (const [id, candidate] of candidates) {
    if (!candidate.unit) candidates.delete(id);
  }

  return { subQueryIndex, candidates };
}

/** Compute the final ranking score using the Phase 6 formula:
 *
 *  final_score =
 *      weight_rerank × max_rerank_score
 *    + weight_coverage × query_coverage
 *    + weight_direct_hit × directHit
 *    + weight_diversity × retrieval_diversity
 *
 *  - max_rerank_score: highest rerank score across all sub-queries (0-1)
 *  - query_coverage: fraction of sub-queries that found this candidate (0-1)
 *  - directHit: 1 if any source is vector_subject/vector_content/lexical, 0 otherwise
 *  - retrieval_diversity: fraction of distinct retrieval source types (0-1) */
function computeFinalScore(
  candidate: RetrievedUnit,
  totalSubQueries: number,
): number {
  const maxRerankScore = candidate.rerankScore ?? 0;
  const queryCoverage = totalSubQueries > 0
    ? (candidate.sourceSubQueries?.length ?? 0) / totalSubQueries
    : 0;
  const directHit = candidate.provenance?.sources.some(
    (s) => s.type === "vector_subject" || s.type === "vector_content" || s.type === "lexical"
  ) ? 1 : 0;
  const sourceTypes = new Set(candidate.provenance?.sources.map((s) => s.type) ?? []);
  const retrievalDiversity = sourceTypes.size > 0 ? sourceTypes.size / 6 : 0; // 6 possible source types

  return (
    WEIGHT_RERANK * maxRerankScore +
    WEIGHT_COVERAGE * queryCoverage +
    WEIGHT_DIRECT_HIT * directHit +
    WEIGHT_DIVERSITY * retrievalDiversity
  );
}

/** Retrieve and rerank candidates for multiple sub-queries.
 *
 *  Phase 4: Each sub-query runs hybrid retrieval (subject + content + lexical),
 *  fused via RRF.
 *
 *  Phase 5: After hybrid retrieval, candidates are expanded via:
 *    1. Concept expansion (first — concepts have genuine similarity scores)
 *    2. Type-driven hierarchy expansion (second — structural context)
 *
 *  Phase 6: Reranking uses a configurable weighted formula:
 *    final_score = w_rerank × max_rerank + w_coverage × coverage + w_direct × directHit + w_diversity × diversity
 *  Server-controlled threshold (0.4) replaces decomposer-controlled threshold.
 *
 *  @param existingIds Unit ids already retrieved in previous iterations (skipped).
 *  @param rerankThreshold Ignored — server-controlled threshold is used instead (Phase 6). */
export async function retrieve(
  env: Env,
  subQueries: string[],
  opts: {
    rerankThreshold?: number;
    existingIds?: Set<string>;
  } = {}
): Promise<RetrievedUnit[]> {
  // Phase 6: Ignore decomposer-provided threshold — use server-controlled value
  void opts.rerankThreshold; // explicitly ignored
  const existingIds = opts.existingIds ?? new Set<string>();

  // Run all sub-queries in parallel (hybrid retrieval)
  const subQueryResults = await Promise.all(
    subQueries.map((sq, i) => retrieveForSubQuery(env, sq, i, existingIds))
  );

  // Aggregate: merge all candidates, dedupe by unit id, track source sub-queries
  const aggregated = new Map<string, RetrievedUnit>();
  for (const { subQueryIndex, candidates } of subQueryResults) {
    for (const [id, candidate] of candidates) {
      const existing = aggregated.get(id);
      if (existing) {
        const sources = new Set([...(existing.sourceSubQueries ?? []), subQueryIndex]);
        existing.sourceSubQueries = [...sources];
        if (existing.provenance && candidate.provenance) {
          existing.provenance.sources.push(...candidate.provenance.sources);
        }
      } else {
        aggregated.set(id, candidate);
      }
    }
  }

  if (aggregated.size === 0) return [];

  // Phase 5: Expansion
  // 1. Concept expansion first (concepts have genuine similarity scores)
  const seedCandidates = [...aggregated.values()].filter((c) => c.expansionRole === "seed");
  await expandConcepts(env, seedCandidates, existingIds, aggregated);

  // 2. Type-driven hierarchy expansion (structural context)
  await expandHierarchy(env, seedCandidates, existingIds, aggregated);

  // 3. Cap total candidates to prevent unbounded pools
  const allCandidates = [...aggregated.values()];
  if (allCandidates.length > MAX_CANDIDATES) {
    allCandidates.sort((a, b) => {
      const aIsSeed = a.expansionRole === "seed" ? 1 : 0;
      const bIsSeed = b.expansionRole === "seed" ? 1 : 0;
      if (aIsSeed !== bIsSeed) return bIsSeed - aIsSeed;
      return (b.vectorScore ?? 0) - (a.vectorScore ?? 0);
    });
    allCandidates.length = MAX_CANDIDATES;
  }

  // Per-sub-query reranking: group candidates by their source sub-query, rerank each group
  const subQueryGroups = new Map<number, number[]>();
  for (let i = 0; i < allCandidates.length; i++) {
    for (const sqIdx of allCandidates[i].sourceSubQueries ?? []) {
      const group = subQueryGroups.get(sqIdx) ?? [];
      group.push(i);
      subQueryGroups.set(sqIdx, group);
    }
  }

  // Rerank each group against its sub-query
  for (const [sqIdx, candidateIndices] of subQueryGroups) {
    const subQuery = subQueries[sqIdx];
    const docs = candidateIndices.map((i) => buildRerankDocument(allCandidates[i].unit));
    const results = await rerank(env, subQuery, docs);
    for (const r of results) {
      const candidateIdx = candidateIndices[r.index];
      const candidate = allCandidates[candidateIdx];
      if (candidate.rerankScore === undefined || r.score > candidate.rerankScore) {
        candidate.rerankScore = r.score;
      }
    }
  }

  // Phase 6: Compute final scores using the weighted formula
  for (const candidate of allCandidates) {
    (candidate as any).finalScore = computeFinalScore(candidate, subQueries.length);
  }

  // Sort by final score
  allCandidates.sort((a, b) => (b as any).finalScore - (a as any).finalScore);

  // Phase 6: Filter by server-controlled rerank threshold
  const filtered = allCandidates.filter((c) => (c.rerankScore ?? 0) >= RERANK_THRESHOLD);

  // Fallback: if no candidates pass the threshold, return top-K by rerank score
  if (filtered.length === 0 && allCandidates.length > 0) {
    return allCandidates
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
      .slice(0, RERANK_FALLBACK_TOP_K);
  }

  // Cap at max results
  return filtered.slice(0, RERANK_MAX_RESULTS);
}
