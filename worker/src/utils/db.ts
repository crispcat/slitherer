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
       (id, document_id, source_node_id, type, name, page, section, content, content_hash, summary, metadata_json, parent_unit_id, source_order, embedding_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       document_id = excluded.document_id,
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
      u.documentId ?? null,
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

/** Find units with parent_unit_id = NULL that belong to a specific section path.
 *  Used during incremental section closing to link orphan units to their section parent. */
export async function getOrphanUnitsBySection(env: Env, sectionPath: string[]): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM semantic_units WHERE section = ? AND parent_unit_id IS NULL`
  ).bind(JSON.stringify(sectionPath)).all();
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
    documentId: row.document_id ?? undefined,
    sourceNodeId: row.source_node_id,
    parentUnitId: row.parent_unit_id,
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
    `SELECT * FROM semantic_units WHERE parent_unit_id = ?`
  )
    .bind(parentId)
    .all();
  return (results ?? []).map(rowToUnit);
}

/** Fetch the parent of a unit. */
export async function getParentOfUnit(
  env: Env,
  unit: SemanticUnit
): Promise<SemanticUnit | null> {
  if (!unit.parentUnitId) return null;
  return getSemanticUnit(env, unit.parentUnitId);
}

export async function clearRelationsForSource(env: Env, unitId: string) {
  // Clear LLM-extracted relations but keep deterministic parent_of/child_of
  await env.DB.prepare(
    `DELETE FROM relations WHERE source_id = ? AND relation_type NOT IN ('parent_of', 'child_of')`
  ).bind(unitId).run();
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

/** Fetch comprehensive data for a single unit: the unit itself, its metadata,
 *  relations (outgoing + incoming), and parent/child units.
 *  Used by the debug tree viewer side panel. */
export async function getUnitDetails(env: Env, unitId: string) {
  const unit = await env.DB.prepare(`SELECT * FROM semantic_units WHERE id = ?`).bind(unitId).first();
  if (!unit) return null;

  const [relationsOut, relationsIn, parentUnit, children, sourceNode] = await Promise.all([
    env.DB.prepare(`SELECT id, target_id, relation_type, confidence FROM relations WHERE source_id = ?`).bind(unitId).all(),
    env.DB.prepare(`SELECT id, source_id, relation_type, confidence FROM relations WHERE target_id = ?`).bind(unitId).all(),
    unit.parent_unit_id ? env.DB.prepare(`SELECT id, name, type FROM semantic_units WHERE id = ?`).bind(unit.parent_unit_id).first() : Promise.resolve(null),
    env.DB.prepare(`SELECT id, name, type FROM semantic_units WHERE parent_unit_id = ?`).bind(unitId).all(),
    env.DB.prepare(`SELECT id, type, section_path, page FROM structure_nodes WHERE id = ?`).bind(unit.source_node_id).first(),
  ]);

  return {
    unit: rowToUnit(unit as any),
    relations: {
      outgoing: (relationsOut.results ?? []).map((r: any) => ({ id: r.id, target: r.target_id, type: r.relation_type, confidence: r.confidence })),
      incoming: (relationsIn.results ?? []).map((r: any) => ({ id: r.id, source: r.source_id, type: r.relation_type, confidence: r.confidence })),
    },
    parent: parentUnit as any,
    children: (children.results ?? []).map((r: any) => ({ id: r.id, name: r.name, type: r.type })),
    sourceNode: sourceNode as any,
  };
}

/** List all structure nodes that have semantic units, with unit counts.
 *  Used by the debug tree viewer to populate the source node dropdown. */
export async function getSourceNodesWithUnits(env: Env): Promise<{ id: string; type: string; sectionPath: string; page: number | null; unitCount: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT sn.id, sn.type, sn.section_path, sn.page, COUNT(su.id) as unit_count
     FROM structure_nodes sn
     JOIN semantic_units su ON su.source_node_id = sn.id
     GROUP BY sn.id
     ORDER BY sn.section_path`
  ).all();
  return (results ?? []).map((r: any) => ({
    id: r.id as string,
    type: r.type as string,
    sectionPath: r.section_path as string,
    page: r.page as number | null,
    unitCount: r.unit_count as number,
  }));
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
     LIMIT ?`
  )
    .bind(status, status, limit)
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
  // Get unit IDs directly via document_id column (no join needed)
  const { results } = await env.DB.prepare(
    `SELECT id FROM semantic_units WHERE document_id = ?`
  )
    .bind(documentId)
    .all();
  const unitIds = ((results ?? []) as any[]).map((r: any) => r.id as string);

  // Vectorize IDs must be <= 64 bytes. Filter out any oversized IDs
  // (from older ingestion runs) to avoid rejecting the entire batch.
  const validIds = unitIds.filter((id) => id.length <= 64);
  for (let i = 0; i < validIds.length; i += 100) {
    const chunk = validIds.slice(i, i + 100);
    await env.VECTORIZE_INDEX.deleteByIds(chunk);
  }

  const jobRows = await env.DB.prepare(`SELECT id FROM ingestion_jobs WHERE document_id = ?`)
    .bind(documentId)
    .all();
  const jobIds = ((jobRows.results ?? []) as any[]).map((r: any) => r.id as string);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
    env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
    env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM structure_nodes WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM ingestion_jobs WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(documentId),
  ]);

  // Delete R2 objects: structures, jobs.
  // Preserve: page images (pages/{documentId}/) — these are expensive to
  // re-render/upload and the ingest script skips re-uploading unchanged files
  // via hash check. Re-rendering is only needed if the source PDF changes.
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
 * Stage hierarchy: vision → summary → metadata → relations
 * - "vision":   clears everything (semantic_units, embeddings, relations); resets job to vision phase
 * - "units":    same as "vision" (legacy alias)
 * - "summary":  clears summaries, embeddings, metadata, relations; resets status to "pending"
 * - "metadata": clears metadata, relations; resets status to "summary_done"
 * - "relations": clears relations only; resets status to "metadata_done"
 *
 * Structure nodes, documents, and R2 structure files are preserved (no re-upload needed).
 */
export async function resetIngestionStage(env: Env, documentId: string, stage: string) {
  // Get all unit IDs for this document (needed for Vectorize deletion)
  const { results } = await env.DB.prepare(
    `SELECT id FROM semantic_units WHERE document_id = ?`
  )
    .bind(documentId)
    .all();
  const unitIds = ((results ?? []) as any[])
    .map((r: any) => r.id as string)
    .filter((id: string) => id.length <= 64); // Vectorize max ID is 64 bytes

  if (stage === "vision") {
    // Reset the vision phase: delete all extracted units + downstream data,
    // then reset the job so pages can be re-enqueued to the vision Queue.
    // Keeps: documents, R2 page images, and the job row.
    for (let i = 0; i < unitIds.length; i += 100) {
      const chunk = unitIds.slice(i, i + 100);
      await env.VECTORIZE_INDEX.deleteByIds(chunk);
    }

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
    ]);

    // Reset job detail: phase back to "vision", pagesProcessed=0, continuation=null
    const jobs = await env.DB.prepare(`SELECT id, detail FROM ingestion_jobs WHERE document_id = ?`)
      .bind(documentId)
      .all();
    for (const job of (jobs.results ?? []) as any[]) {
      let detail: any;
      try { detail = JSON.parse(job.detail); } catch { detail = {}; }
      detail.phase = "vision";
      detail.pagesProcessed = 0;
      detail.unitsProcessed = 0;
      detail.continuation = null;
      await env.DB.prepare(`UPDATE ingestion_jobs SET phase = ?, status = ?, detail = ?, updated_at = ? WHERE id = ?`)
        .bind("vision", "running", JSON.stringify(detail), new Date().toISOString(), job.id)
        .run();
    }
    return;
  }

  if (stage === "units") {
    // Full reset: delete everything except structure_nodes, documents, and R2 files
    // Delete Vectorize vectors
    for (let i = 0; i < unitIds.length; i += 100) {
      const chunk = unitIds.slice(i, i + 100);
      await env.VECTORIZE_INDEX.deleteByIds(chunk);
    }

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
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
      env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      // Reset all units to "pending" status, clear summary + metadata + embedding_id
      env.DB.prepare(
        `UPDATE semantic_units SET
          summary = NULL,
          metadata_json = NULL,
          embedding_id = NULL,
          status = 'pending',
          updated_at = ?
         WHERE document_id = ?`
      ).bind(new Date().toISOString(), documentId),
    );
  } else if (stage === "metadata") {
    batchStmts.push(
      env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      // Reset units that are at metadata_done or later back to summary_done, clear metadata
      env.DB.prepare(
        `UPDATE semantic_units SET
          metadata_json = NULL,
          status = 'summary_done',
          updated_at = ?
         WHERE document_id = ?
         AND status IN ('metadata_done', 'relations_done', 'done')`
      ).bind(new Date().toISOString(), documentId),
    );
  } else if (stage === "relations") {
    batchStmts.push(
      env.DB.prepare(`DELETE FROM relations WHERE source_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      env.DB.prepare(`DELETE FROM relations WHERE target_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
      // Reset units that are at relations_done or done back to metadata_done
      env.DB.prepare(
        `UPDATE semantic_units SET
          status = 'metadata_done',
          updated_at = ?
         WHERE document_id = ?
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

// ---- Debug logging ----

export async function logDebug(
  env: Env,
  level: "info" | "warn" | "error",
  source: string,
  message: string,
  data?: unknown
) {
  const id = `DLOG-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO debug_logs (id, level, source, message, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, level, source, message, data ? JSON.stringify(data) : null, now)
    .run();
}

export interface DebugLogEntry {
  id: string;
  level: string;
  source: string;
  message: string;
  data: string | null;
  createdAt: string;
}

export async function getDebugLogs(env: Env, since?: string, limit = 200): Promise<DebugLogEntry[]> {
  const stmt = since
    ? env.DB.prepare(`SELECT id, level, source, message, data, created_at FROM debug_logs WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`)
        .bind(since, limit)
    : env.DB.prepare(`SELECT id, level, source, message, data, created_at FROM debug_logs ORDER BY created_at DESC LIMIT ?`)
        .bind(limit);
  const result = await stmt.all();
  return (result.results as any[]).map((r) => ({
    id: r.id,
    level: r.level,
    source: r.source,
    message: r.message,
    data: r.data,
    createdAt: r.created_at,
  }));
}

export async function clearDebugLogs(env: Env) {
  await env.DB.prepare(`DELETE FROM debug_logs`).run();
}

/** Update a single semantic unit's editable fields (content, name, section, type, parentId). */
export async function updateUnit(
  env: Env,
  unitId: string,
  fields: { content?: string; name?: string | null; section?: string[]; type?: string; parentUnitId?: string | null }
) {
  const sets: string[] = ["updated_at = ?"];
  const binds: any[] = [new Date().toISOString()];
  if (fields.content !== undefined) {
    sets.push("content = ?");
    binds.push(fields.content);
  }
  if (fields.name !== undefined) {
    sets.push("name = ?");
    binds.push(fields.name);
  }
  if (fields.section !== undefined) {
    sets.push("section = ?");
    binds.push(JSON.stringify(fields.section));
  }
  if (fields.type !== undefined) {
    sets.push("type = ?");
    binds.push(fields.type);
  }
  if (fields.parentUnitId !== undefined) {
    sets.push("parent_unit_id = ?");
    binds.push(fields.parentUnitId);
  }
  binds.push(unitId);
  await env.DB.prepare(`UPDATE semantic_units SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}
