import type { Env, SemanticUnit } from "../types";
import { embed, rerank } from "../utils/llm";
import { getRelationsForUnits, getUnitsByIds, getChildrenOfUnit, getParentsOfUnit } from "../utils/db";
import { buildEnrichedDocument } from "../pipeline/embeddings";

export interface RetrievedUnit {
  unit: SemanticUnit;
  vectorScore?: number;
  rerankScore?: number;
  viaRelation?: string; // relation_type that pulled this unit in via graph expansion, if not a direct hit
  expansionRole?: "seed" | "row_parent" | "col_parent" | "row_sibling" | "col_sibling";
}

/** Phase 8 — Retrieval pipeline: vector search -> parent expansion -> graph expansion -> dedupe -> rerank. */
export async function retrieve(
  env: Env,
  question: string,
  opts: { topKVector?: number; graphHops?: number; finalCount?: number } = {}
): Promise<RetrievedUnit[]> {
  const topKVector = opts.topKVector ?? 8;
  const graphHops = opts.graphHops ?? 2;
  const finalCount = opts.finalCount ?? 12;

  // 1-3: embed query, search Vectorize, get top matches.
  const [queryVector] = await embed(env, [question]);
  const matches = await env.VECTORIZE_INDEX.query(queryVector, { topK: topKVector, returnMetadata: true });

  const seedIds = matches.matches.map((m) => m.id);
  if (seedIds.length === 0) return [];

  // 4. retrieve full semantic units
  const seedUnits = await getUnitsByIds(env, seedIds);
  const scoreById = new Map(matches.matches.map((m) => [m.id, m.score]));

  const collected = new Map<string, RetrievedUnit>();
  for (const u of seedUnits) {
    collected.set(u.id, { unit: u, vectorScore: scoreById.get(u.id), expansionRole: "seed" });
  }

  // 4.5. parent expansion: for each seed, fetch both parents + siblings.
  const expandedIds = new Set<string>();
  for (const u of seedUnits) {
    const { row, col } = await getParentsOfUnit(env, u);
    if (row) {
      if (!collected.has(row.id)) expandedIds.add(row.id);
      const rowSiblings = await getChildrenOfUnit(env, row.id);
      for (const s of rowSiblings) {
        if (s.id !== u.id && !collected.has(s.id)) expandedIds.add(s.id);
      }
    }
    if (col) {
      if (!collected.has(col.id)) expandedIds.add(col.id);
      const colSiblings = await getChildrenOfUnit(env, col.id);
      for (const s of colSiblings) {
        if (s.id !== u.id && !collected.has(s.id)) expandedIds.add(s.id);
      }
    }
  }
  if (expandedIds.size > 0) {
    const expandedUnits = await getUnitsByIds(env, [...expandedIds]);
    for (const u of expandedUnits) {
      if (!collected.has(u.id)) {
        // Determine expansion role by checking which parent matches.
        let role: RetrievedUnit["expansionRole"] = "row_sibling";
        if (seedUnits.some((s) => s.parentUnitId === u.id)) role = "row_parent";
        else if (seedUnits.some((s) => s.secondaryParentUnitId === u.id)) role = "col_parent";
        else if (seedUnits.some((s) => s.secondaryParentUnitId !== null && s.secondaryParentUnitId === u.secondaryParentUnitId)) role = "col_sibling";
        collected.set(u.id, { unit: u, viaRelation: "parent_expansion", expansionRole: role });
      }
    }
  }

  // 5-7. expand through the knowledge graph
  let frontier = [...collected.keys()];
  for (let hop = 0; hop < graphHops && frontier.length > 0; hop++) {
    const relations = await getRelationsForUnits(env, frontier);
    const nextIds = new Set<string>();
    for (const r of relations) {
      const otherId = frontier.includes(r.source) ? r.target : r.source;
      if (!collected.has(otherId)) nextIds.add(otherId);
    }
    if (nextIds.size === 0) break;
    const nextUnits = await getUnitsByIds(env, [...nextIds]);
    for (const u of nextUnits) {
      if (!collected.has(u.id)) collected.set(u.id, { unit: u, viaRelation: "graph_expansion" });
    }
    frontier = nextUnits.map((u) => u.id);
  }

  // 8. dedupe already guaranteed by Map keyed on unit id.
  const candidates = [...collected.values()];

  // 9. rerank
  const docs = candidates.map((c) => buildEnrichedDocument(c.unit));
  const rerankResults = await rerank(env, question, docs);
  for (const r of rerankResults) {
    if (candidates[r.index]) candidates[r.index].rerankScore = r.score;
  }
  candidates.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

  return candidates.slice(0, finalCount);
}
