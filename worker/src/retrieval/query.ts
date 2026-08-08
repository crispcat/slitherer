import type { Env, SemanticUnit } from "../types";
import { embed, rerank } from "../utils/llm";
import { getRelationsForUnits, getUnitsByIds, getChildrenOfUnit, getParentsOfUnit } from "../utils/db";
import { buildEnrichedDocument } from "../pipeline/embeddings";
import { RETRIEVAL } from "../config.gen";

export interface RetrievedUnit {
  unit: SemanticUnit;
  vectorScore?: number;
  rerankScore?: number;
  viaRelation?: string;
  expansionRole?: "seed" | "row_parent" | "col_parent" | "row_sibling" | "col_sibling";
  /** Which sub-query(ies) found this candidate. */
  sourceSubQueries?: number[];
}

/** Minimum vector similarity for a match to be kept. */
const SIMILARITY_THRESHOLD = RETRIEVAL.retrieval.similarityThreshold.value;

/** Minimum relation confidence for graph expansion. */
const RELATION_CONFIDENCE_THRESHOLD = RETRIEVAL.retrieval.relationConfidenceThreshold.value;

/** Candidate pool per sub-query for vector search. */
const VECTOR_CANDIDATE_POOL = RETRIEVAL.retrieval.vectorCandidatePool.value;

/** Default rerank threshold if not provided by decomposer. */
const DEFAULT_RERANK_THRESHOLD = RETRIEVAL.retrieval.defaultRerankThreshold.value;

interface SubQueryResult {
  subQueryIndex: number;
  candidates: Map<string, RetrievedUnit>;
}

/** Retrieve candidates for a single sub-query: vector search + parent/sibling
 *  expansion + graph expansion. Returns candidates tagged with the sub-query index. */
async function retrieveForSubQuery(
  env: Env,
  subQuery: string,
  subQueryIndex: number,
  graphHops: number,
  existingIds?: Set<string>
): Promise<SubQueryResult> {
  const candidates = new Map<string, RetrievedUnit>();

  // 3a. Vector search
  const [queryVector] = await embed(env, [subQuery]);
  const matches = await env.VECTORIZE_INDEX.query(queryVector, {
    topK: VECTOR_CANDIDATE_POOL,
    returnMetadata: true,
  });

  const seedIds: string[] = [];
  for (const m of matches.matches ?? []) {
    if (m.score < SIMILARITY_THRESHOLD) continue;
    if (existingIds?.has(m.id)) continue;
    seedIds.push(m.id);
    candidates.set(m.id, {
      unit: null as any, // filled below
      vectorScore: m.score,
      expansionRole: "seed",
      sourceSubQueries: [subQueryIndex],
    });
  }

  if (seedIds.length === 0) return { subQueryIndex, candidates };

  // Fetch full units for seeds
  const seedUnits = await getUnitsByIds(env, seedIds);
  for (const u of seedUnits) {
    const existing = candidates.get(u.id);
    if (existing) existing.unit = u;
  }

  // 3b. Parent/sibling expansion
  const expandedIds = new Set<string>();
  for (const u of seedUnits) {
    const { row, col } = await getParentsOfUnit(env, u);
    if (row) {
      if (!candidates.has(row.id) && !existingIds?.has(row.id)) expandedIds.add(row.id);
      const rowSiblings = await getChildrenOfUnit(env, row.id);
      for (const s of rowSiblings) {
        if (s.id !== u.id && !candidates.has(s.id) && !existingIds?.has(s.id)) expandedIds.add(s.id);
      }
    }
    if (col) {
      if (!candidates.has(col.id) && !existingIds?.has(col.id)) expandedIds.add(col.id);
      const colSiblings = await getChildrenOfUnit(env, col.id);
      for (const s of colSiblings) {
        if (s.id !== u.id && !candidates.has(s.id) && !existingIds?.has(s.id)) expandedIds.add(s.id);
      }
    }
  }
  if (expandedIds.size > 0) {
    const expandedUnits = await getUnitsByIds(env, [...expandedIds]);
    for (const u of expandedUnits) {
      if (!candidates.has(u.id)) {
        let role: RetrievedUnit["expansionRole"] = "row_sibling";
        if (seedUnits.some((s) => s.parentUnitId === u.id)) role = "row_parent";
        else if (seedUnits.some((s) => s.secondaryParentUnitId === u.id)) role = "col_parent";
        else if (seedUnits.some((s) => s.secondaryParentUnitId !== null && s.secondaryParentUnitId === u.secondaryParentUnitId)) role = "col_sibling";
        candidates.set(u.id, {
          unit: u,
          viaRelation: "parent_expansion",
          expansionRole: role,
          sourceSubQueries: [subQueryIndex],
        });
      }
    }
  }

  // 3c. Graph expansion (confidence-filtered)
  let frontier = [...candidates.keys()];
  for (let hop = 0; hop < graphHops && frontier.length > 0; hop++) {
    const relations = await getRelationsForUnits(env, frontier);
    const nextIds = new Set<string>();
    for (const r of relations) {
      if (r.confidence < RELATION_CONFIDENCE_THRESHOLD) continue;
      const otherId = frontier.includes(r.source) ? r.target : r.source;
      if (!candidates.has(otherId) && !existingIds?.has(otherId)) nextIds.add(otherId);
    }
    if (nextIds.size === 0) break;
    const nextUnits = await getUnitsByIds(env, [...nextIds]);
    for (const u of nextUnits) {
      if (!candidates.has(u.id)) {
        candidates.set(u.id, {
          unit: u,
          viaRelation: "graph_expansion",
          sourceSubQueries: [subQueryIndex],
        });
      }
    }
    frontier = nextUnits.map((u) => u.id);
  }

  return { subQueryIndex, candidates };
}

/** Retrieve and rerank candidates for multiple sub-queries.
 *
 *  Each sub-query runs vector search + parent/sibling expansion + graph expansion
 *  independently. Results are aggregated, then per-sub-query reranked: each
 *  candidate is reranked against the sub-query(ies) that found it. If found by
 *  multiple sub-queries, the max rerank score is kept.
 *
 *  @param existingIds Unit ids already retrieved in previous iterations (skipped).
 *  @param rerankThreshold Dynamic threshold from the decomposer (default 0.3). */
export async function retrieve(
  env: Env,
  subQueries: string[],
  opts: {
    graphHops?: number;
    rerankThreshold?: number;
    existingIds?: Set<string>;
  } = {}
): Promise<RetrievedUnit[]> {
  const graphHops = opts.graphHops ?? 2;
  const rerankThreshold = opts.rerankThreshold ?? DEFAULT_RERANK_THRESHOLD;
  const existingIds = opts.existingIds ?? new Set<string>();

  // Run all sub-queries in parallel
  const subQueryResults = await Promise.all(
    subQueries.map((sq, i) => retrieveForSubQuery(env, sq, i, graphHops, existingIds))
  );

  // Aggregate: merge all candidates, dedupe by unit id, track source sub-queries
  const aggregated = new Map<string, RetrievedUnit>();
  for (const { subQueryIndex, candidates } of subQueryResults) {
    for (const [id, candidate] of candidates) {
      const existing = aggregated.get(id);
      if (existing) {
        // Already found by another sub-query — merge source indices
        const sources = new Set([...(existing.sourceSubQueries ?? []), subQueryIndex]);
        existing.sourceSubQueries = [...sources];
      } else {
        aggregated.set(id, candidate);
      }
    }
  }

  if (aggregated.size === 0) return [];

  // Per-sub-query reranking: group candidates by their source sub-query, rerank each group
  const allCandidates = [...aggregated.values()];

  // Build groups: sub-query index → list of candidate indices in allCandidates
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
    const docs = candidateIndices.map((i) => buildEnrichedDocument(allCandidates[i].unit));
    const results = await rerank(env, subQuery, docs);
    for (const r of results) {
      const candidateIdx = candidateIndices[r.index];
      const candidate = allCandidates[candidateIdx];
      // Keep max score across sub-queries
      if (candidate.rerankScore === undefined || r.score > candidate.rerankScore) {
        candidate.rerankScore = r.score;
      }
    }
  }

  // Filter by rerank threshold and return
  return allCandidates
    .filter((c) => (c.rerankScore ?? 0) >= rerankThreshold)
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
}
