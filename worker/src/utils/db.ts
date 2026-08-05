import type { Env, Relation, SemanticUnit, StructureNode } from "../types";

export async function upsertDocument(env: Env, id: string, sourcePath: string) {
  await env.DB.prepare(
    `INSERT INTO documents (id, source_path, ingested_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET source_path = excluded.source_path`
  )
    .bind(id, sourcePath, new Date().toISOString())
    .run();
}

export async function upsertStructureNode(env: Env, documentId: string, node: StructureNode, contentHash: string) {
  await env.DB.prepare(
    `INSERT INTO structure_nodes (id, document_id, parent_id, type, page, section_path, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       parent_id = excluded.parent_id,
       type = excluded.type,
       page = excluded.page,
       section_path = excluded.section_path,
       content = excluded.content,
       content_hash = excluded.content_hash`
  )
    .bind(node.id, documentId, node.parent, node.type, node.page, JSON.stringify(node.path), node.content, contentHash)
    .run();
}

export async function upsertSemanticUnit(env: Env, u: SemanticUnit) {
  await env.DB.prepare(
    `INSERT INTO semantic_units
       (id, source_node_id, type, name, page, section, content, content_hash, summary, metadata_json, parent_unit_id, source_order, embedding_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_node_id = excluded.source_node_id,
       type = excluded.type,
       name = excluded.name,
       page = excluded.page,
       section = excluded.section,
       content = excluded.content,
       content_hash = excluded.content_hash,
       summary = excluded.summary,
       metadata_json = excluded.metadata_json,
       parent_unit_id = excluded.parent_unit_id,
       source_order = excluded.source_order,
       embedding_id = excluded.embedding_id,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(
      u.id,
      u.sourceNodeId,
      u.type,
      u.name,
      u.page,
      JSON.stringify(u.section),
      u.content,
      u.contentHash,
      u.summary ?? null,
      u.metadata ? JSON.stringify(u.metadata) : null,
      u.parentUnitId ?? null,
      u.sourceOrder ?? null,
      u.embeddingId ?? null,
      u.status,
      u.updatedAt
    )
    .run();
}

export async function getSemanticUnit(env: Env, id: string): Promise<SemanticUnit | null> {
  const row = await env.DB.prepare(`SELECT * FROM semantic_units WHERE id = ?`).bind(id).first();
  if (!row) return null;
  return rowToUnit(row);
}

export async function getSemanticUnitsBySourceNode(env: Env, sourceNodeId: string): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units WHERE source_node_id = ?`)
    .bind(sourceNodeId)
    .all();
  return (results ?? []).map(rowToUnit);
}

export async function getUnitsByIds(env: Env, ids: string[]): Promise<SemanticUnit[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all();
  return (results ?? []).map(rowToUnit);
}

function rowToUnit(row: any): SemanticUnit {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    parentUnitId: row.parent_unit_id,
    sourceOrder: row.source_order ?? undefined,
    type: row.type,
    name: row.name,
    page: row.page,
    section: JSON.parse(row.section ?? "[]"),
    content: row.content,
    contentHash: row.content_hash,
    summary: row.summary ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    embeddingId: row.embedding_id ?? undefined,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export async function upsertConcept(env: Env, id: string, name: string, description: string, aliases: string[]) {
  await env.DB.prepare(
    `INSERT INTO concepts (id, name, description, aliases) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, aliases = excluded.aliases`
  )
    .bind(id, name, description, JSON.stringify(aliases))
    .run();
}

export async function getConceptIdByName(env: Env, name: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM concepts WHERE name = ?`).bind(name).first<{ id: string }>();
  return row?.id ?? null;
}

export async function linkConceptUnit(env: Env, conceptId: string, unitId: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO concept_unit (concept_id, unit_id) VALUES (?, ?)`)
    .bind(conceptId, unitId)
    .run();
}

export async function insertKeyword(env: Env, unitId: string, keyword: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO keywords (unit_id, keyword) VALUES (?, ?)`).bind(unitId, keyword).run();
}

export async function clearKeywords(env: Env, unitId: string) {
  await env.DB.prepare(`DELETE FROM keywords WHERE unit_id = ?`).bind(unitId).run();
}

export async function clearRelationsForSource(env: Env, unitId: string) {
  await env.DB.prepare(`DELETE FROM relations WHERE source_id = ?`).bind(unitId).run();
}

export async function insertRelation(env: Env, r: Relation) {
  await env.DB.prepare(
    `INSERT INTO relations (id, source_id, target_id, relation_type, confidence) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET confidence = excluded.confidence`
  )
    .bind(r.id, r.source, r.target, r.relation_type, r.confidence)
    .run();
}

export async function getRelationsForUnits(env: Env, unitIds: string[]): Promise<Relation[]> {
  if (unitIds.length === 0) return [];
  const placeholders = unitIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
  )
    .bind(...unitIds, ...unitIds)
    .all();
  return (results ?? []).map((row: any) => ({
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    relation_type: row.relation_type,
    confidence: row.confidence,
  }));
}

export async function findCandidateUnits(env: Env, unit: SemanticUnit, limit = 20): Promise<SemanticUnit[]> {
  const keywords = unit.metadata?.keywords ?? [];
  // Collect explicit reference strings from metadata to use as search probes.
  const referenceNames = new Set<string>();
  const addRefs = (arr?: string[]) => {
    if (!arr) return;
    for (const s of arr) {
      const trimmed = s.trim();
      if (trimmed.length > 0) referenceNames.add(trimmed);
    }
  };
  addRefs(unit.metadata?.defines);
  addRefs(unit.metadata?.references);
  addRefs(unit.metadata?.requires);
  addRefs(unit.metadata?.modifies);
  addRefs(unit.metadata?.modified_by);
  addRefs(unit.metadata?.exceptions);
  addRefs(unit.metadata?.aliases);

  // Prefer the most specific non-empty section path element (e.g. the subsection).
  const sectionPath = unit.section.filter((s) => s?.trim().length > 0);
  const deepestSection = sectionPath[sectionPath.length - 1] ?? "";
  const chapter = sectionPath[0] ?? "";

  const seen = new Set<string>();
  const rows: any[] = [];
  const addRows = (results: any[] | undefined | null) => {
    for (const r of results ?? []) {
      const id = (r as any).id as string;
      if (id !== unit.id && !seen.has(id)) {
        seen.add(id);
        rows.push(r);
      }
    }
  };

  // 1. Keyword-based candidates.
  if (keywords.length > 0 && rows.length < limit) {
    const placeholders = keywords.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT su.* FROM semantic_units su
       JOIN keywords k ON k.unit_id = su.id
       WHERE k.keyword IN (${placeholders}) AND su.id != ?
       LIMIT ?`
    )
      .bind(...keywords, unit.id, limit)
      .all();
    addRows(results);
  }

  // 2. Reference-name candidates (name, defines, content, summary, section).
  if (referenceNames.size > 0 && rows.length < limit) {
    const names = Array.from(referenceNames).filter((n) => n.length > 1);
    if (names.length > 0) {
      const placeholders = names.map(() => "?").join(",");
      const likeClauses = names.map(() => "metadata_json LIKE ? OR content LIKE ? OR summary LIKE ?").join(" OR ");
      const { results } = await env.DB.prepare(
        `SELECT * FROM semantic_units
         WHERE id != ? AND (
           name IN (${placeholders}) OR ${likeClauses}
         )
         LIMIT ?`
      )
        .bind(
          unit.id,
          ...names,
          ...names.flatMap((n) => [`%${n}%`, `%${n}%`, `%${n}%`])
        )
        .all();
      addRows(results);
    }
  }

  // 3. Same-source-node siblings: units from the same structure node are
  // likely related even when the split lost adjacency (e.g. an age modifier
  // and the "Старый" label it follows).
  if (rows.length < limit) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM semantic_units WHERE source_node_id = ? AND id != ? LIMIT ?`
    )
      .bind(unit.sourceNodeId, unit.id, limit - rows.length)
      .all();
    addRows(results);
  }

  // 4. Section-path candidates: deepest first, then chapter as fallback.
  if (rows.length < limit) {
    for (const sectionPattern of [deepestSection, chapter]) {
      if (rows.length >= limit) break;
      if (!sectionPattern) continue;
      const { results } = await env.DB.prepare(
        `SELECT * FROM semantic_units WHERE section LIKE ? AND id != ? LIMIT ?`
      )
        .bind(`%${sectionPattern}%`, unit.id, limit - rows.length)
        .all();
      addRows(results);
    }
  }

  return rows.map(rowToUnit);
}

export async function getAllUnits(env: Env): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units`).all();
  return (results ?? []).map(rowToUnit);
}

/** Return units whose metadata contains unresolved references for a document.
 *  Useful for a human-in-the-loop review pass after ingestion. */
export async function getUnitsWithUnresolvedRefs(env: Env, documentId: string): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(
    `SELECT su.* FROM semantic_units su
     JOIN structure_nodes sn ON su.source_node_id = sn.id
     WHERE sn.document_id = ? AND su.metadata_json LIKE '%unresolved_references%'`
  )
    .bind(documentId)
    .all();
  return (results ?? []).map(rowToUnit);
}

export async function getUnitsByStatus(env: Env, status: string, limit: number): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units WHERE status = ? LIMIT ?`)
    .bind(status, limit)
    .all();
  return (results ?? []).map(rowToUnit);
}

export async function countUnitsByStatus(env: Env, status: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM semantic_units WHERE status = ?`)
    .bind(status)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function createIngestionJob(env: Env, id: string, documentId: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ingestion_jobs (id, document_id, phase, status, detail, created_at, updated_at)
     VALUES (?, ?, 'structure', 'running', NULL, ?, ?)`
  )
    .bind(id, documentId, now, now)
    .run();
}

export async function updateIngestionJob(env: Env, id: string, phase: string, status: string, detail?: string) {
  await env.DB.prepare(
    `UPDATE ingestion_jobs SET phase = ?, status = ?, detail = ?, updated_at = ? WHERE id = ?`
  )
    .bind(phase, status, detail ?? null, new Date().toISOString(), id)
    .run();
}

export async function getIngestionJob(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM ingestion_jobs WHERE id = ?`).bind(id).first();
}

/** Delete all data for a document across D1, Vectorize, and R2. */
export async function cleanupDocument(env: Env, documentId: string) {
  const { results } = await env.DB.prepare(
    `SELECT su.id FROM semantic_units su
     JOIN structure_nodes sn ON su.source_node_id = sn.id
     WHERE sn.document_id = ?`
  )
    .bind(documentId)
    .all();
  const unitIds = ((results ?? []) as any[]).map((r: any) => r.id as string);

  for (let i = 0; i < unitIds.length; i += 100) {
    const chunk = unitIds.slice(i, i + 100);
    await env.VECTORIZE_INDEX.deleteByIds(chunk);
  }

  const jobRows = await env.DB.prepare(`SELECT id FROM ingestion_jobs WHERE document_id = ?`)
    .bind(documentId)
    .all();
  const jobIds = ((jobRows.results ?? []) as any[]).map((r: any) => r.id as string);

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM keywords WHERE unit_id IN (
        SELECT su.id FROM semantic_units su
        JOIN structure_nodes sn ON su.source_node_id = sn.id
        WHERE sn.document_id = ?
       )`
    ).bind(documentId),
    env.DB.prepare(
      `DELETE FROM relations WHERE source_id IN (
        SELECT su.id FROM semantic_units su
        JOIN structure_nodes sn ON su.source_node_id = sn.id
        WHERE sn.document_id = ?
       )`
    ).bind(documentId),
    env.DB.prepare(
      `DELETE FROM relations WHERE target_id IN (
        SELECT su.id FROM semantic_units su
        JOIN structure_nodes sn ON su.source_node_id = sn.id
        WHERE sn.document_id = ?
       )`
    ).bind(documentId),
    env.DB.prepare(
      `DELETE FROM concept_unit WHERE unit_id IN (
        SELECT su.id FROM semantic_units su
        JOIN structure_nodes sn ON su.source_node_id = sn.id
        WHERE sn.document_id = ?
       )`
    ).bind(documentId),
    env.DB.prepare(`DELETE FROM semantic_units WHERE source_node_id IN (SELECT id FROM structure_nodes WHERE document_id = ?)`).bind(documentId),
    env.DB.prepare(`DELETE FROM structure_nodes WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM ingestion_jobs WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(documentId),
  ]);

  await env.slitherer_rag_storage.delete(`structures/${documentId}.json`);
  await env.slitherer_rag_storage.delete(`structures/${documentId}.meta.json`).catch(() => {});
  for (const jobId of jobIds) {
    await env.slitherer_rag_storage.delete(`jobs/${jobId}.json`).catch(() => {});
  }
}
