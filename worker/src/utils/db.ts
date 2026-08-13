import type { Env, ConversationMessage, SemanticUnit, StructureNode } from "../types";

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
       (id, document_id, source_node_id, type, name, page, section, content, content_hash, summary, metadata_json, metadata_terms_text, section_path_text, aliases_text, parent_unit_id, source_order, subject_embedding_id, content_embedding_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       metadata_terms_text = excluded.metadata_terms_text,
       section_path_text = excluded.section_path_text,
       aliases_text = excluded.aliases_text,
       parent_unit_id = excluded.parent_unit_id,
       source_order = excluded.source_order,
       subject_embedding_id = excluded.subject_embedding_id,
       content_embedding_id = excluded.content_embedding_id,
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
      u.metadataTermsText ?? null,
      u.sectionPathText ?? null,
      u.aliasesText ?? null,
      u.parentUnitId ?? null,
      u.sourceOrder ?? null,
      u.subjectEmbeddingId ?? null,
      u.contentEmbeddingId ?? null,
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
    metadataTermsText: row.metadata_terms_text ?? undefined,
    sectionPathText: row.section_path_text ?? undefined,
    aliasesText: row.aliases_text ?? undefined,
    subjectEmbeddingId: row.subject_embedding_id ?? undefined,
    contentEmbeddingId: row.content_embedding_id ?? undefined,
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

export async function getAllUnits(env: Env): Promise<SemanticUnit[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM semantic_units`).all();
  return (results ?? []).map(rowToUnit);
}

/** Fetch comprehensive data for a single unit: the unit itself, its metadata,
 *  concept mentions, and parent/child units.
 *  Used by the debug tree viewer side panel. */
export async function getUnitDetails(env: Env, unitId: string) {
  const unit = await env.DB.prepare(`SELECT * FROM semantic_units WHERE id = ?`).bind(unitId).first();
  if (!unit) return null;

  const [parentUnit, children, sourceNode, conceptMentions] = await Promise.all([
    unit.parent_unit_id ? env.DB.prepare(`SELECT id, name, type FROM semantic_units WHERE id = ?`).bind(unit.parent_unit_id).first() : Promise.resolve(null),
    env.DB.prepare(`SELECT id, name, type FROM semantic_units WHERE parent_unit_id = ?`).bind(unitId).all(),
    env.DB.prepare(`SELECT id, type, section_path, page FROM structure_nodes WHERE id = ?`).bind(unit.source_node_id).first(),
    env.DB.prepare(
      `SELECT cm.id, cm.concept_id, cm.raw_term, cm.mention_type, cm.confidence, cm.resolution_method,
              c.canonical_name, c.description
       FROM concept_mentions cm
       JOIN concepts c ON c.id = cm.concept_id
       WHERE cm.unit_id = ?`
    ).bind(unitId).all(),
  ]);

  return {
    unit: rowToUnit(unit as any),
    concepts: (conceptMentions.results ?? []).map((r: any) => ({
      id: r.id,
      conceptId: r.concept_id,
      canonicalName: r.canonical_name,
      description: r.description,
      rawTerm: r.raw_term,
      mentionType: r.mention_type,
      confidence: r.confidence,
      resolutionMethod: r.resolution_method,
    })),
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

/** Like getUnitsByStatus but filtered to specific pages (1-indexed).
 *  When pages is null/empty, behaves identically to getUnitsByStatus. */
export async function getUnitsByStatusAndPages(
  env: Env,
  status: string,
  limit: number,
  pages: number[] | null,
): Promise<SemanticUnit[]> {
  if (!pages || pages.length === 0) return getUnitsByStatus(env, status, limit);
  const placeholders = pages.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM semantic_units WHERE status = ? AND page IN (${placeholders}) LIMIT ?`
  )
    .bind(status, ...pages, limit)
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

/** Delete all data for a document across D1, Vectorize, and R2.
 *  Clears: semantic units, structure nodes, concepts (+ aliases + mentions),
 *  ingestion jobs, the document row, subject/content/concept vectors, and
 *  R2 legacy structure/job files (if any).
 *  Preserves: R2 page images (pages/{documentId}/) — reused on next ingest. */
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
    await env.VECTORIZE_SUBJECTS.deleteByIds(chunk);
    await env.VECTORIZE_CONTENT.deleteByIds(chunk);
  }

  // Get concept IDs for this document (to delete their vectors)
  const conceptRows = await env.DB.prepare(
    `SELECT id FROM concepts WHERE document_id = ?`
  )
    .bind(documentId)
    .all();
  const conceptIds = ((conceptRows.results ?? []) as any[]).map((r: any) => r.id as string);
  const validConceptIds = conceptIds.filter((id) => id.length <= 64);
  for (let i = 0; i < validConceptIds.length; i += 100) {
    const chunk = validConceptIds.slice(i, i + 100);
    await env.VECTORIZE_CONCEPTS_IDX.deleteByIds(chunk);
  }

  // Fetch job IDs before deleting the job rows (needed for R2 cleanup)
  const jobRows = await env.DB.prepare(`SELECT id FROM ingestion_jobs WHERE document_id = ?`)
    .bind(documentId)
    .all();
  const jobIds = ((jobRows.results ?? []) as any[]).map((r: any) => r.id as string);

  await env.DB.batch([
    // concept_mentions reference units, so delete them before units
    env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
    // concept_aliases reference concepts, so delete them before concepts
    env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
    env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM structure_nodes WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM ingestion_jobs WHERE document_id = ?`).bind(documentId),
    env.DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(documentId),
  ]);

  // Delete legacy R2 structure/job files if they exist (from the old
  // Python-parser pipeline). No current code writes these, but old
  // ingestion runs may have left them behind.
  await env.slitherer_rag_storage.delete(`structures/${documentId}.json`).catch(() => {});
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
 * Stage hierarchy: vision → summary → metadata → embedding → concepts
 * - "vision":   clears everything (semantic_units, embeddings, concepts); resets job to vision phase
 * - "units":    same as "vision" (legacy alias)
 * - "summary":  clears summaries, embeddings, metadata, concepts; resets status to "pending"
 * - "metadata": clears metadata, embeddings, concepts; resets status to "summary_done"
 * - "embedding": clears embeddings, concepts; resets status to "metadata_done"
 * - "concepts": clears concepts only; resets status to "embedding_done"
 *
 * Structure nodes, documents, and R2 structure files are preserved (no re-upload needed).
 */
export async function resetIngestionStage(
  env: Env,
  documentId: string,
  stage: string,
  pages?: number[] | null,
) {
  const hasPageScope = pages && pages.length > 0;
  // Build a SQL fragment + bind values for page filtering
  const pagePlaceholders = hasPageScope ? ` AND page IN (${pages!.map(() => "?").join(",")})` : "";
  const pageBinds = (extra: any[] = []) => hasPageScope ? [...extra, ...pages!] : extra;

  // Get unit IDs for the scope (all units or only units on the specified pages)
  const { results } = await env.DB.prepare(
    `SELECT id FROM semantic_units WHERE document_id = ?${pagePlaceholders}`
  )
    .bind(documentId, ...pageBinds())
    .all();
  const unitIds = ((results ?? []) as any[])
    .map((r: any) => r.id as string)
    .filter((id: string) => id.length <= 64); // Vectorize max ID is 64 bytes

  // For page-scoped resets: regenerate descriptions for concepts that had
  // `defines` mentions from units on the target pages. This must happen BEFORE
  // clearing concept mentions, because the regeneration function needs to know
  // which concepts were defined by the affected units. Surviving concepts
  // (still mentioned by units on other pages) get their descriptions updated
  // to reflect only the remaining defining units, and are re-embedded so the
  // concept Vectorize index is ready for the re-ingestion.
  if (hasPageScope) {
    const { regenerateDescriptionsForAffectedConcepts } = await import("../pipeline/concepts");
    await regenerateDescriptionsForAffectedConcepts(env, documentId, pages!);
  }

  // Helper: delete unit vectors from VECTORIZE_SUBJECTS + VECTORIZE_CONTENT
  async function deleteUnitVectors(ids: string[]) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      await env.VECTORIZE_SUBJECTS.deleteByIds(chunk);
      await env.VECTORIZE_CONTENT.deleteByIds(chunk);
    }
  }

  // Helper: delete ALL concept data (vectors + aliases + mentions + concept rows)
  // for the entire document. Used for document-wide resets.
  async function clearAllConceptData() {
    const conceptRows = await env.DB.prepare(
      `SELECT id FROM concepts WHERE document_id = ?`
    )
      .bind(documentId)
      .all();
    const conceptIds = ((conceptRows.results ?? []) as any[])
      .map((r: any) => r.id as string)
      .filter((id) => id.length <= 64);
    for (let i = 0; i < conceptIds.length; i += 100) {
      const chunk = conceptIds.slice(i, i + 100);
      await env.VECTORIZE_CONCEPTS_IDX.deleteByIds(chunk);
    }
  }

  // Helper: for page-scoped resets, only clear concept mentions for the affected
  // units, then delete orphaned concepts (concepts with no remaining mentions).
  // Concept vectors for orphaned concepts are also deleted. Non-orphaned
  // concepts are preserved — re-resolution will update them naturally.
  async function clearScopedConceptData() {
    if (!hasPageScope) {
      await clearAllConceptData();
      return;
    }
    // Delete concept mentions only for units on the affected pages
    await env.DB.prepare(
      `DELETE FROM concept_mentions WHERE unit_id IN (
        SELECT id FROM semantic_units WHERE document_id = ?${pagePlaceholders}
      )`
    )
      .bind(documentId, ...pageBinds())
      .run();

    // Find orphaned concepts (no mentions left from any unit) for this document
    const orphaned = await env.DB.prepare(
      `SELECT c.id FROM concepts c
       WHERE c.document_id = ?
         AND NOT EXISTS (SELECT 1 FROM concept_mentions m WHERE m.concept_id = c.id)`
    )
      .bind(documentId)
      .all();
    const orphanedIds = ((orphaned.results ?? []) as any[])
      .map((r: any) => r.id as string)
      .filter((id) => id.length <= 64);

    // Delete orphaned concept vectors
    for (let i = 0; i < orphanedIds.length; i += 100) {
      const chunk = orphanedIds.slice(i, i + 100);
      await env.VECTORIZE_CONCEPTS_IDX.deleteByIds(chunk);
    }
    // Delete orphaned concept aliases + concept rows
    if (orphanedIds.length > 0) {
      const placeholders = orphanedIds.map(() => "?").join(",");
      await env.DB.prepare(
        `DELETE FROM concept_aliases WHERE concept_id IN (${placeholders})`
      ).bind(...orphanedIds).run();
      await env.DB.prepare(
        `DELETE FROM concepts WHERE id IN (${placeholders})`
      ).bind(...orphanedIds).run();
    }
  }

  if (stage === "vision") {
    // Reset the vision phase: delete extracted units + downstream data for the
    // scope, then reset the job so pages can be re-enqueued to the vision Queue.
    // Keeps: documents, R2 page images, and the job row.
    await deleteUnitVectors(unitIds);
    await clearScopedConceptData();

    if (hasPageScope) {
      // Page-scoped: only delete units + concept mentions for the affected pages
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM concept_mentions WHERE unit_id IN (
            SELECT id FROM semantic_units WHERE document_id = ?${pagePlaceholders}
          )`
        ).bind(documentId, ...pageBinds()),
        env.DB.prepare(
          `DELETE FROM semantic_units WHERE document_id = ?${pagePlaceholders}`
        ).bind(documentId, ...pageBinds()),
      ]);
    } else {
      // Document-wide: delete all concepts + units
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
      ]);
    }

    // Reset job detail: phase back to "vision"
    const jobs = await env.DB.prepare(`SELECT id, detail FROM ingestion_jobs WHERE document_id = ?`)
      .bind(documentId)
      .all();
    for (const job of (jobs.results ?? []) as any[]) {
      let detail: any;
      try { detail = JSON.parse(job.detail); } catch { detail = {}; }
      detail.phase = "vision";
      if (!hasPageScope) {
        // Full vision reset: clear all progress
        detail.pagesProcessed = 0;
        detail.unitsProcessed = 0;
        detail.continuation = null;
      }
      // For page-scoped vision reset, keep existing progress — the re-enqueued
      // pages will be re-processed and the counts will be updated by the Queue handler.
      await env.DB.prepare(`UPDATE ingestion_jobs SET phase = ?, status = ?, detail = ?, updated_at = ? WHERE id = ?`)
        .bind("vision", "running", JSON.stringify(detail), new Date().toISOString(), job.id)
        .run();
    }
    return;
  }

  if (stage === "units") {
    // Full reset: delete everything except structure_nodes, documents, and R2 files
    // Page-scoped "units" reset doesn't make much sense (it deletes the job),
    // but we support it for consistency.
    await deleteUnitVectors(unitIds);
    await clearScopedConceptData();

    if (hasPageScope) {
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM concept_mentions WHERE unit_id IN (
            SELECT id FROM semantic_units WHERE document_id = ?${pagePlaceholders}
          )`
        ).bind(documentId, ...pageBinds()),
        env.DB.prepare(
          `DELETE FROM semantic_units WHERE document_id = ?${pagePlaceholders}`
        ).bind(documentId, ...pageBinds()),
      ]);
    } else {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(`DELETE FROM semantic_units WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(`DELETE FROM ingestion_jobs WHERE document_id = ?`).bind(documentId),
      ]);
    }
    return;
  }

  // For summary/metadata/embedding/concepts: we keep semantic_units rows but reset columns + downstream
  const batchStmts = [];

  // Helper: build a subquery that selects unit IDs for the scope
  const unitIdSubquery = hasPageScope
    ? `SELECT id FROM semantic_units WHERE document_id = ?${pagePlaceholders}`
    : `SELECT id FROM semantic_units WHERE document_id = ?`;

  if (stage === "summary") {
    // Delete Vectorize vectors — embeddings are downstream of summary
    await deleteUnitVectors(unitIds);
    await clearScopedConceptData();

    if (hasPageScope) {
      batchStmts.push(
        env.DB.prepare(
          `DELETE FROM concept_mentions WHERE unit_id IN (${unitIdSubquery})`
        ).bind(documentId, ...pageBinds()),
        // Reset units on the affected pages to "pending", clear summary + metadata + embeddings + FTS text
        env.DB.prepare(
          `UPDATE semantic_units SET
            summary = NULL,
            metadata_json = NULL,
            metadata_terms_text = NULL,
            aliases_text = NULL,
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'pending',
            updated_at = ?
           WHERE document_id = ?${pagePlaceholders}`
        ).bind(new Date().toISOString(), documentId, ...pageBinds()),
      );
    } else {
      batchStmts.push(
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(
          `UPDATE semantic_units SET
            summary = NULL,
            metadata_json = NULL,
            metadata_terms_text = NULL,
            aliases_text = NULL,
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'pending',
            updated_at = ?
           WHERE document_id = ?`
        ).bind(new Date().toISOString(), documentId),
      );
    }
  } else if (stage === "metadata") {
    // Delete Vectorize vectors — embeddings are downstream of metadata
    await deleteUnitVectors(unitIds);
    await clearScopedConceptData();

    if (hasPageScope) {
      batchStmts.push(
        env.DB.prepare(
          `DELETE FROM concept_mentions WHERE unit_id IN (${unitIdSubquery})`
        ).bind(documentId, ...pageBinds()),
        // Reset units on the affected pages back to summary_done, clear metadata + embeddings + FTS text
        env.DB.prepare(
          `UPDATE semantic_units SET
            metadata_json = NULL,
            metadata_terms_text = NULL,
            aliases_text = NULL,
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'summary_done',
            updated_at = ?
           WHERE document_id = ?${pagePlaceholders}
           AND status IN ('metadata_done', 'embedding_done', 'done')`
        ).bind(new Date().toISOString(), documentId, ...pageBinds()),
      );
    } else {
      batchStmts.push(
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(
          `UPDATE semantic_units SET
            metadata_json = NULL,
            metadata_terms_text = NULL,
            aliases_text = NULL,
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'summary_done',
            updated_at = ?
           WHERE document_id = ?
           AND status IN ('metadata_done', 'embedding_done', 'done')`
        ).bind(new Date().toISOString(), documentId),
      );
    }
  } else if (stage === "concepts") {
    // Concepts stage: clear mentions for the affected units.
    // For document-wide: also clear all concept rows + vectors (full rebuild).
    // For page-scoped: only clear mentions for those pages' units, delete
    // orphaned concepts. Non-orphaned concepts are preserved for re-resolution.
    await clearScopedConceptData();

    if (hasPageScope) {
      batchStmts.push(
        // Reset units on the affected pages back to embedding_done
        env.DB.prepare(
          `UPDATE semantic_units SET
            status = 'embedding_done',
            updated_at = ?
           WHERE document_id = ?${pagePlaceholders}
           AND status = 'done'`
        ).bind(new Date().toISOString(), documentId, ...pageBinds()),
      );
    } else {
      batchStmts.push(
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(
          `UPDATE semantic_units SET
            status = 'embedding_done',
            updated_at = ?
           WHERE document_id = ?
           AND status = 'done'`
        ).bind(new Date().toISOString(), documentId),
      );
    }
  } else if (stage === "embedding") {
    // Delete Vectorize vectors (both indexes)
    await deleteUnitVectors(unitIds);
    await clearScopedConceptData();

    if (hasPageScope) {
      batchStmts.push(
        env.DB.prepare(
          `DELETE FROM concept_mentions WHERE unit_id IN (${unitIdSubquery})`
        ).bind(documentId, ...pageBinds()),
        // Reset units on the affected pages back to metadata_done, clear embeddings
        env.DB.prepare(
          `UPDATE semantic_units SET
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'metadata_done',
            updated_at = ?
           WHERE document_id = ?${pagePlaceholders}
           AND status IN ('embedding_done', 'done')`
        ).bind(new Date().toISOString(), documentId, ...pageBinds()),
      );
    } else {
      batchStmts.push(
        env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id IN (SELECT id FROM semantic_units WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concept_aliases WHERE concept_id IN (SELECT id FROM concepts WHERE document_id = ?)`).bind(documentId),
        env.DB.prepare(`DELETE FROM concepts WHERE document_id = ?`).bind(documentId),
        env.DB.prepare(
          `UPDATE semantic_units SET
            subject_embedding_id = NULL,
            content_embedding_id = NULL,
            status = 'metadata_done',
            updated_at = ?
           WHERE document_id = ?
           AND status IN ('embedding_done', 'done')`
        ).bind(new Date().toISOString(), documentId),
      );
    }
  }

  if (batchStmts.length > 0) {
    await env.DB.batch(batchStmts);
  }

  // For non-vision stages (summary/metadata/embedding/concepts), update the
  // job's phase and status so processIngestionBatch doesn't short-circuit on
  // a previously-completed job (status="done").
  if (stage !== "vision" && stage !== "units") {
    const jobs = await env.DB.prepare(
      `SELECT id, detail FROM ingestion_jobs WHERE document_id = ?`
    )
      .bind(documentId)
      .all();
    for (const job of (jobs.results ?? []) as any[]) {
      let detail: any;
      try { detail = JSON.parse(job.detail); } catch { detail = {}; }
      detail.phase = stage;
      await updateIngestionJob(env, job.id, stage, "running", JSON.stringify(detail));
    }
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

// ---- Phase 10: Candidate logging for diagnostics ----

export interface CandidateLogEntry {
  id: string;
  conversationId?: string;
  queryText: string;
  iteration: number;
  stage: string;
  unitId?: string;
  unitName?: string;
  unitType?: string;
  vectorScore?: number;
  rerankScore?: number;
  finalScore?: number;
  provenance?: string;
  selected?: boolean;
}

export async function logCandidate(env: Env, entry: Omit<CandidateLogEntry, "id">) {
  const id = `CLOG-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO candidate_logs (id, conversation_id, query_text, iteration, stage, unit_id, unit_name, unit_type, vector_score, rerank_score, final_score, provenance, selected, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      entry.conversationId ?? null,
      entry.queryText,
      entry.iteration,
      entry.stage,
      entry.unitId ?? null,
      entry.unitName ?? null,
      entry.unitType ?? null,
      entry.vectorScore ?? null,
      entry.rerankScore ?? null,
      entry.finalScore ?? null,
      entry.provenance ?? null,
      entry.selected ? 1 : 0,
      now,
    )
    .run();
}

export async function getCandidateLogs(env: Env, queryText: string, limit = 200): Promise<CandidateLogEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM candidate_logs WHERE query_text = ? ORDER BY iteration, stage, created_at LIMIT ?`
  ).bind(queryText, limit).all();

  return (results ?? []).map((r: any) => ({
    id: r.id,
    conversationId: r.conversation_id ?? undefined,
    queryText: r.query_text,
    iteration: r.iteration,
    stage: r.stage,
    unitId: r.unit_id ?? undefined,
    unitName: r.unit_name ?? undefined,
    unitType: r.unit_type ?? undefined,
    vectorScore: r.vector_score ?? undefined,
    rerankScore: r.rerank_score ?? undefined,
    finalScore: r.final_score ?? undefined,
    provenance: r.provenance ?? undefined,
    selected: r.selected === 1,
  }));
}

export async function clearCandidateLogs(env: Env) {
  await env.DB.prepare(`DELETE FROM candidate_logs`).run();
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
