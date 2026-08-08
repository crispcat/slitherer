import type { Env, ConversationMessage, Relation, SemanticUnit, StructureNode } from "../types";

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
       (id, source_node_id, type, name, page, section, content, content_hash, summary, metadata_json, parent_unit_id, secondary_parent_unit_id, source_order, embedding_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       secondary_parent_unit_id = excluded.secondary_parent_unit_id,
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
      u.secondaryParentUnitId ?? null,
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
    secondaryParentUnitId: row.secondary_parent_unit_id ?? null,
    sourceOrder: row.source_order ?? 0,
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

/** Fetch all children of a unit (by primary or secondary parent). */
export async function getChildrenOfUnit(env: Env, parentId: string): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM semantic_units WHERE parent_unit_id = ? OR secondary_parent_unit_id = ?`
  )
    .bind(parentId, parentId)
    .all();
  return (results ?? []).map(rowToUnit);
}

/** Fetch both parents of a unit (row parent + column parent). */
export async function getParentsOfUnit(
  env: Env,
  unit: SemanticUnit
): Promise<{ row: SemanticUnit | null; col: SemanticUnit | null }> {
  const ids = [unit.parentUnitId, unit.secondaryParentUnitId].filter((x): x is string => x !== null);
  if (ids.length === 0) return { row: null, col: null };
  const units = await getUnitsByIds(env, ids);
  const row = unit.parentUnitId ? units.find((u) => u.id === unit.parentUnitId) ?? null : null;
  const col = unit.secondaryParentUnitId ? units.find((u) => u.id === unit.secondaryParentUnitId) ?? null : null;
  return { row, col };
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

export async function getAllUnits(env: Env): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units`).all();
  return (results ?? []).map(rowToUnit);
}

export async function getUnitsByStatus(env: Env, status: string, limit: number): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units WHERE status = ? LIMIT ?`)
    .bind(status, limit)
    .all();
  return (results ?? []).map(rowToUnit);
}

/** Fetch units with the given status whose parents (if any) are already past
 *  that status. This ensures parents are processed before children in any
 *  parent-aware phase (summary, metadata), so parent summaries/metadata are
 *  available when generating child data.
 *
 *  Falls back to any unit with the given status if no parent-ready units are
 *  found (prevents deadlock on dangling parent references or cycles). */
export async function getUnitsByStatusParentFirst(env: Env, status: string, limit: number): Promise<SemanticUnit[]> {
  // Try parent-ready units first: parents are null or already past this status.
  const { results } = await env.DB.prepare(
    `SELECT * FROM semantic_units
     WHERE status = ?
       AND (parent_unit_id IS NULL OR parent_unit_id IN (
         SELECT id FROM semantic_units WHERE status != ?
       ))
       AND (secondary_parent_unit_id IS NULL OR secondary_parent_unit_id IN (
         SELECT id FROM semantic_units WHERE status != ?
       ))
     LIMIT ?`
  )
    .bind(status, status, status, limit)
    .all();

  if ((results ?? []).length > 0) {
    return (results ?? []).map(rowToUnit);
  }

  // Fallback: no parent-ready units found (dangling refs or all parents still
  // in the same status). Return any unit with this status to avoid deadlock.
  return getUnitsByStatus(env, status, limit);
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

/**
 * Reset an ingestion stage to a clean state for a document.
 * Clears the outputs of the specified stage AND all downstream stages,
 * then resets unit statuses so the stage can be re-run.
 *
 * Stage hierarchy: units → summary → metadata → relations
 * - "units":    clears everything (semantic_units, embeddings, relations, concepts, keywords)
 * - "summary":  clears summaries, embeddings, metadata, relations, concepts, keywords; resets status to "pending"
 * - "metadata": clears metadata, relations, concepts, keywords; resets status to "summary_done"
 * - "relations": clears relations only; resets status to "metadata_done"
 *
 * Structure nodes, documents, and R2 structure files are preserved (no re-upload needed).
 */
export async function resetIngestionStage(env: Env, documentId: string, stage: string) {
  // Get all unit IDs for this document (needed for Vectorize deletion)
  const { results } = await env.DB.prepare(
    `SELECT su.id FROM semantic_units su
     JOIN structure_nodes sn ON su.source_node_id = sn.id
     WHERE sn.document_id = ?`
  )
    .bind(documentId)
    .all();
  const unitIds = ((results ?? []) as any[]).map((r: any) => r.id as string);

  if (stage === "units") {
    // Full reset: delete everything except structure_nodes, documents, and R2 files
    // Delete Vectorize vectors
    for (let i = 0; i < unitIds.length; i += 100) {
      const chunk = unitIds.slice(i, i + 100);
      await env.VECTORIZE_INDEX.deleteByIds(chunk);
    }

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
      env.DB.prepare(`DELETE FROM ingestion_jobs WHERE document_id = ?`).bind(documentId),
    ]);
    return;
  }

  // For summary/metadata/relations: we keep semantic_units rows but reset columns + downstream
  const batchStmts = [];

  if (stage === "summary") {
    // Delete Vectorize vectors (embeddings are produced in summary phase)
    for (let i = 0; i < unitIds.length; i += 100) {
      const chunk = unitIds.slice(i, i + 100);
      await env.VECTORIZE_INDEX.deleteByIds(chunk);
    }

    batchStmts.push(
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
      // Reset all units to "pending" status, clear summary + metadata + embedding_id
      env.DB.prepare(
        `UPDATE semantic_units SET
          summary = NULL,
          metadata_json = NULL,
          embedding_id = NULL,
          status = 'pending',
          updated_at = ?
         WHERE source_node_id IN (SELECT id FROM structure_nodes WHERE document_id = ?)`
      ).bind(new Date().toISOString(), documentId),
    );
  } else if (stage === "metadata") {
    batchStmts.push(
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
      // Reset units that are at metadata_done or later back to summary_done, clear metadata
      env.DB.prepare(
        `UPDATE semantic_units SET
          metadata_json = NULL,
          status = 'summary_done',
          updated_at = ?
         WHERE source_node_id IN (SELECT id FROM structure_nodes WHERE document_id = ?)
         AND status IN ('metadata_done', 'relations_done', 'done')`
      ).bind(new Date().toISOString(), documentId),
    );
  } else if (stage === "relations") {
    batchStmts.push(
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
      // Reset units that are at relations_done or done back to metadata_done
      env.DB.prepare(
        `UPDATE semantic_units SET
          status = 'metadata_done',
          updated_at = ?
         WHERE source_node_id IN (SELECT id FROM structure_nodes WHERE document_id = ?)
         AND status IN ('relations_done', 'done')`
      ).bind(new Date().toISOString(), documentId),
    );
  }

  if (batchStmts.length > 0) {
    await env.DB.batch(batchStmts);
  }
}

// ---- Conversation storage ----

export async function getConversation(env: Env, id: string): Promise<ConversationMessage[] | null> {
  const row = await env.DB.prepare(`SELECT messages FROM conversations WHERE id = ?`).bind(id).first();
  if (!row) return null;
  return JSON.parse(row.messages as string) as ConversationMessage[];
}

export async function saveConversation(env: Env, id: string, messages: ConversationMessage[]) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO conversations (id, messages, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`
  )
    .bind(id, JSON.stringify(messages), now, now)
    .run();
}

export async function appendConversationMessage(env: Env, id: string, message: ConversationMessage): Promise<ConversationMessage[]> {
  const existing = await getConversation(env, id);
  const messages = existing ?? [];
  messages.push(message);
  await saveConversation(env, id, messages);
  return messages;
}

export async function getLastConversationTurns(env: Env, id: string, count: number): Promise<ConversationMessage[]> {
  const messages = await getConversation(env, id);
  if (!messages) return [];
  return messages.slice(-count * 2); // count turns = count*2 messages
}

// ---- Query logging ----

export async function logQueryStep(
  env: Env,
  step: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  conversationId?: string
) {
  const id = `QLOG-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO query_logs (id, conversation_id, step, input, output, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, conversationId ?? null, step, JSON.stringify(input), JSON.stringify(output), durationMs, now)
    .run();
}
