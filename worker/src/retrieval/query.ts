import type { Env, SemanticUnit } from "../types";
import { embed, rerank } from "../utils/llm";
import { getRelationsForUnits, getUnitsByIds, getChildrenOfUnit, getParentOfUnit } from "../utils/db";
import { buildEnrichedDocument } from "../pipeline/embeddings";
import { RETRIEVAL } from "../config.gen";

export interface RetrievedUnit {
  unit: SemanticUnit;
  vectorScore?: number;
  rerankScore?: number;
  viaRelation?: string;
  expansionRole?: "seed" | "parent" | "sibling" | "child";
  /** Which sub-query(ies) found this candidate. */
  sourceSubQueries?: number[];
}

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

  // 3a. Vector search (top 10, no similarity threshold)
  const [queryVector] = await embed(env, [subQuery]);
  const matches = await env.VECTORIZE_INDEX.query(queryVector, {
    topK: 10,
    returnMetadata: true,
  });

  const seedIds: string[] = [];
  for (const m of matches.matches ?? []) {
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

  // 3b. Parent/sibling/child expansion
  const expandedIds = new Set<string>();
  for (const u of seedUnits) {
    // Fetch parent + siblings (other children of the same parent)
    const parent = await getParentOfUnit(env, u);
    if (parent) {
      if (!candidates.has(parent.id) && !existingIds?.has(parent.id)) expandedIds.add(parent.id);
      const siblings = await getChildrenOfUnit(env, parent.id);
      for (const s of siblings) {
        if (s.id !== u.id && !candidates.has(s.id) && !existingIds?.has(s.id)) expandedIds.add(s.id);
      }
    }
    // Fetch direct children of the seed unit
    const children = await getChildrenOfUnit(env, u.id);
    for (const c of children) {
      if (!candidates.has(c.id) && !existingIds?.has(c.id)) expandedIds.add(c.id);
    }
  }
  if (expandedIds.size > 0) {
    const expandedUnits = await getUnitsByIds(env, [...expandedIds]);
    for (const u of expandedUnits) {
      if (!candidates.has(u.id)) {
        let role: RetrievedUnit["expansionRole"] = "sibling";
        if (seedUnits.some((s) => s.parentUnitId === u.id)) role = "parent";
        else if (seedUnits.some((s) => s.id === u.parentUnitId)) role = "child";
        candidates.set(u.id, {
          unit: u,
          viaRelation: "parent_expansion",
          expansionRole: role,
          sourceSubQueries: [subQueryIndex],
        });
      }
    }
  }

  // 3c. Graph expansion (2 hops)
  let frontier = [...candidates.keys()];
  for (let hop = 0; hop < graphHops && frontier.length > 0; hop++) {
    const relations = await getRelationsForUnits(env, frontier);
    const nextIds = new Set<string>();
    for (const r of relations) {
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
