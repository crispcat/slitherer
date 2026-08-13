import type { Env, SemanticUnit, VisionContinuation } from "../types";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";
import {
  countUnitsByStatus,
  createIngestionJob,
  getIngestionJob,
  getUnitsByStatus,
  getUnitsByStatusAndPages,
  logDebug,
  updateIngestionJob,
  upsertDocument,
  upsertSemanticUnit,
} from "../utils/db";
import { generateSummary } from "./summary";
import { extractMetadata, computeMetadataTermsText, computeAliasesText, computeSectionPathText } from "./metadata";
import {
  buildSubjectDocument,
  buildContentDocument,
  embedSubjectUnits,
  embedContentUnits,
  upsertSubjectEmbeddings,
  upsertContentEmbeddings,
} from "./embeddings";
import { extractConceptsForUnit, storeConceptResults, clearConceptMentionsForUnit } from "./concepts";
import { extractPage } from "./vision_extract";
import { normalizeUnits } from "./vision_verify";
import { getSemanticUnit } from "../utils/db";
import { INGESTION } from "../config.gen";

export type IngestPhase = "vision" | "summary" | "metadata" | "embedding" | "concepts" | "done";

/** All valid stages that can be targeted with --stage. */
export const INGEST_STAGES = ["vision", "summary", "metadata", "embedding", "concepts"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Order of phases — used to skip ahead when a target stage is requested. */
const PHASE_ORDER: IngestPhase[] = ["vision", "summary", "metadata", "embedding", "concepts", "done"];

export interface IngestJobDetail {
  documentId: string;
  phase: IngestPhase;
  totalPages: number;
  pagesProcessed: number;
  unitsProcessed: number;
  /** Specific page numbers to process (1-indexed). If null, all pages 1..totalPages are processed. */
  pages?: number[] | null;
  /** Continuation state passed between pages during the vision phase. */
  continuation?: VisionContinuation | null;
  /** Last page number that was processed (for consecutive-page continuation logic). */
  lastProcessedPage?: number | null;
}

/**
 * Registers a document and initializes a resumable job.
 * Pages are enqueued to the vision Queue by the caller (index.ts).
 */
export async function startIngestion(
  env: Env,
  documentId: string,
  sourcePath: string,
  totalPages: number,
  jobId: string,
  pages?: number[] | null,
) {
  await upsertDocument(env, documentId, sourcePath);

  const detail: IngestJobDetail = {
    documentId,
    phase: "vision",
    totalPages,
    pagesProcessed: 0,
    unitsProcessed: 0,
    pages: pages ?? null,
    continuation: null,
    lastProcessedPage: null,
  };
  await createIngestionJob(env, jobId, documentId);
  await updateIngestionJob(env, jobId, "vision", "running", JSON.stringify(detail));

  await logDebug(env, "info", "ingestion", `Started ingestion job ${jobId}`, {
    documentId,
    sourcePath,
    totalPages,
  });

  return { totalPages };
}

/**
 * Process a single page from the vision Queue.
 *
 * 1. Fetch the page image from R2 (pages/{documentId}/{pageNumber}.png)
 * 2. Extract units via the vision model (with continuation state from the job)
 * 3. Normalize units (inherit sections, map types)
 * 4. Store units in D1
 * 5. Update the job's continuation state for the next page
 *
 * With max_concurrency=1, the Queue processes pages sequentially in FIFO order,
 * so continuation state is always consistent.
 */
export async function processVisionPage(
  env: Env,
  jobId: string,
  documentId: string,
  pageNumber: number,
): Promise<{ unitsDetected: number; done: boolean }> {
  const job = await getIngestionJob(env, jobId);
  if (!job) throw new Error(`Unknown ingestion job ${jobId}`);
  const detail: IngestJobDetail = JSON.parse((job as any).detail);

  await logDebug(env, "info", "ingestion:vision", `Processing page ${pageNumber}/${detail.totalPages}`, {
    jobId,
    documentId,
    pageNumber,
  });

  // 1. Fetch page image from R2
  const imageObj = await env.slitherer_rag_storage.get(`pages/${documentId}/${pageNumber}.png`);
  if (!imageObj) {
    await logDebug(env, "error", "ingestion:vision", `Page image not found in R2`, {
      key: `pages/${documentId}/${pageNumber}.png`,
    });
    throw new Error(`Page image not found: pages/${documentId}/${pageNumber}.png`);
  }
  const imageBuffer = await imageObj.arrayBuffer();
  // Convert ArrayBuffer to base64 in chunks to avoid call stack overflow
  // (String.fromCharCode(...spread) overflows for large images)
  const bytes = new Uint8Array(imageBuffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const imageBase64 = btoa(binary);

  // 2. Extract units via vision model
  // Only pass continuation state if the previous page was processed
  // (i.e. this page is consecutive with the last processed page).
  // Gaps in the page sequence mean the continuation would be stale/misleading.
  const isConsecutive = detail.lastProcessedPage != null && pageNumber === detail.lastProcessedPage + 1;
  const continuation = isConsecutive ? (detail.continuation ?? null) : null;
  const result = await extractPage(
    env,
    imageBase64,
    pageNumber,
    continuation,
  );

  // 3. Normalize units (inherit sections from parent, map unknown types)
  const normalized = normalizeUnits(result.units);

  // 5b. Assign deterministic IDs based on (documentId, pageNumber, sourceOrder).
  // This ensures that re-processing the same page (e.g. Queue redelivery) produces
  // the same IDs, so upserts overwrite instead of creating duplicates.
  const oldToNewId = new Map<string, string>();
  for (let i = 0; i < normalized.length; i++) {
    const oldId = normalized[i].id;
    const type = normalized[i].type;
    // Determine ID prefix based on unit type
    let prefix = "RULE";
    if (type === "Image") prefix = "IMG";
    else if (type === "DataTableHeader" || type === "DataTableRow" || type === "ColumnListTable" || type === "ColumnListItem") prefix = "TABLE";
    const newId = `${prefix}-${(await sha256(`${documentId}:${pageNumber}:${i}`)).slice(0, 32)}`;
    oldToNewId.set(oldId, newId);
    normalized[i].id = newId;
  }
  // Re-resolve parentId references to the new IDs
  for (const unit of normalized) {
    if (unit.parentId && oldToNewId.has(unit.parentId)) {
      unit.parentId = oldToNewId.get(unit.parentId)!;
    }
  }

  // 4. Store units in D1
  // Clean up any existing concept mentions for units on this page (in case of
  // Queue redelivery — deterministic IDs mean the units themselves will be
  // upserted, but old concept mentions referencing these IDs need to be cleared).
  const unitIds = normalized.map((u) => u.id);
  if (unitIds.length > 0) {
    const placeholders = unitIds.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM concept_mentions WHERE unit_id IN (${placeholders})`
    ).bind(...unitIds).run();
  }

  const now = new Date().toISOString();
  for (let i = 0; i < normalized.length; i++) {
    const unit = normalized[i];
    const contentHash = await sha256(unit.content);
    const semanticUnit: SemanticUnit = {
      id: unit.id,
      documentId,
      sourceNodeId: `page-${pageNumber}`,
      parentUnitId: unit.parentId,
      sourceOrder: i,
      type: unit.type as any,
      name: unit.name,
      page: pageNumber,
      section: unit.section,
      content: unit.content,
      contentHash,
      sectionPathText: computeSectionPathText(unit.section),
      status: "pending",
      updatedAt: now,
    };
    await upsertSemanticUnit(env, semanticUnit);
  }

  // 5. Update job state
  detail.pagesProcessed += 1;
  detail.unitsProcessed += normalized.length;
  detail.continuation = result.continuation;
  detail.lastProcessedPage = pageNumber;

  // Vision is done when all enqueued pages have been processed.
  // If `pages` is set, compare against its length; otherwise compare against totalPages.
  const targetPages = detail.pages ? detail.pages.length : detail.totalPages;
  const visionDone = detail.pagesProcessed >= targetPages;
  if (visionDone) {
    detail.phase = "summary";
    detail.continuation = null;
    detail.lastProcessedPage = null;
    await logDebug(env, "info", "ingestion:vision", `Vision phase complete — transitioning to summary`, {
      totalProcessed: detail.unitsProcessed,
      totalPages: detail.totalPages,
    });
  }

  await updateIngestionJob(env, jobId, detail.phase, "running", JSON.stringify(detail));

  await logDebug(env, "info", "ingestion:vision", `Page ${pageNumber} complete`, {
    unitsDetected: normalized.length,
    pagesProcessed: detail.pagesProcessed,
    totalPages: detail.totalPages,
  });

  return {
    unitsDetected: normalized.length,
    done: visionDone,
  };
}

/**
 * Advances an ingestion job by one batch for the summary/metadata/embedding/concepts phases.
 * The vision phase is handled by the Queue (processVisionPage), not here.
 *
 * Call repeatedly (e.g. from a client poll loop) until job.status === "done".
 *
 * The pipeline runs as five sequential, whole-document phases:
 *   1. vision    — Queue-based: each page is processed by processVisionPage.
 *   2. summary   — Generate summary for every unit (no embedding yet).
 *      Uses parent name and children names as context (not parent summaries),
 *      so no parent-first ordering needed.
 *   3. metadata  — Metadata + aliases extraction, for every unit.
 *   4. embedding — Subject + content embeddings, upserted to two Vectorize indexes.
 *   5. concepts  — Concept extraction, resolution, and embedding, for every unit.
 */
export async function processIngestionBatch(
  env: Env,
  jobId: string,
  batchSize = INGESTION.ingestion.batchSizes.summary.value,
  targetStage?: IngestStage,
  pages?: number[] | null,
) {
  const job = await getIngestionJob(env, jobId);
  if (!job) throw new Error(`Unknown ingestion job ${jobId}`);
  // Allow targetStage to override a "done" job — resetIngestionStage should
  // have already set status to "running", but this is a safety net.
  if ((job as any).status === "done" && !targetStage) {
    return { done: true, phase: "done", progress: 1 };
  }

  const detail: IngestJobDetail = JSON.parse((job as any).detail);
  const hasPageScope = pages && pages.length > 0;

  // If a target stage is specified, set the phase to it. This handles both
  // skip-ahead (jumping forward to a later stage) and re-running an earlier
  // stage after resetIngestionStage reset the job.
  if (targetStage && detail.phase !== targetStage) {
    detail.phase = targetStage;
    await updateIngestionJob(env, jobId, detail.phase, "running", JSON.stringify(detail));
  }

  switch (detail.phase) {
    case "vision":
      // Vision phase is Queue-driven — nothing to do here.
      // Return current progress so the client can poll.
      break;
    case "summary":
      await stepSummaryPhase(env, detail, batchSize, pages);
      break;
    case "metadata":
      await stepMetadataPhase(env, detail, batchSize, pages);
      break;
    case "embedding":
      await stepEmbeddingPhase(env, detail, batchSize, pages);
      break;
    case "concepts":
      await stepConceptsPhase(env, detail, batchSize, pages);
      break;
  }

  // For page-scoped runs, "done" means no more units in scope for the current phase.
  // For document-wide runs, "done" means the phase advanced to "done".
  let done: boolean;
  let remaining: number;
  if (hasPageScope) {
    // Count units in scope that still need processing for the current phase
    const statusVal = statusForPhase(detail.phase);
    if (detail.phase === "done") {
      done = true;
      remaining = 0;
    } else if (detail.phase === "vision") {
      done = false; // vision is Queue-driven, polling handles completion
      remaining = detail.totalPages - detail.pagesProcessed;
    } else {
      // Check if there are any units in scope with the expected status
      const { getUnitsByStatusAndPages } = await import("../utils/db");
      const inScope = await getUnitsByStatusAndPages(env, statusVal, 1, pages!);
      done = inScope.length === 0;
      remaining = inScope.length;
    }
  } else {
    done = detail.phase === "done";
    remaining = done
      ? 0
      : detail.phase === "vision"
        ? detail.totalPages - detail.pagesProcessed
        : await countUnitsByStatus(env, statusForPhase(detail.phase));
  }

  // For page-scoped target stage runs, stageDone when no more in-scope units
  const stageDone = targetStage
    ? (hasPageScope ? done : (detail.phase !== targetStage && detail.phase !== "done" ? true : done))
    : done;

  // Only mark the job as "done" for document-wide runs that completed fully.
  // Page-scoped runs should not mark the whole job as done.
  const jobStatus = (!hasPageScope && done) ? "done" : "running";
  await updateIngestionJob(env, jobId, detail.phase, jobStatus, JSON.stringify(detail));

  await logDebug(env, "info", `ingestion:${detail.phase}`, `Batch complete`, {
    jobId,
    phase: detail.phase,
    unitsProcessed: detail.unitsProcessed,
    remaining,
    done: stageDone || done,
    pages: hasPageScope ? pages : undefined,
  });

  return {
    done: stageDone || done,
    phase: detail.phase,
    unitsProcessed: detail.unitsProcessed,
    pagesProcessed: detail.pagesProcessed,
    totalPages: detail.totalPages,
    remaining,
  };
}

function statusForPhase(phase: IngestPhase): string {
  switch (phase) {
    case "summary":
      return "pending";
    case "metadata":
      return "summary_done";
    case "embedding":
      return "metadata_done";
    case "concepts":
      return "embedding_done";
    default:
      return "pending";
  }
}

async function stepSummaryPhase(env: Env, detail: IngestJobDetail, batchSize: number, pages?: number[] | null) {
  const summaryBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.summary.value);
  const batch = await getUnitsByStatusAndPages(env, "pending", summaryBatchSize, pages ?? null);
  for (const unit of batch) {
    unit.summary = await generateSummary(env, unit);
    unit.status = "summary_done";
    unit.updatedAt = new Date().toISOString();
    // No embedding here — embeddings are generated in the embedding phase after metadata
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0 && !pages) {
    detail.phase = "metadata";
    await logDebug(env, "info", "ingestion:summary", `Summary phase complete — transitioning to metadata`);
  }
}

async function stepMetadataPhase(env: Env, detail: IngestJobDetail, batchSize: number, pages?: number[] | null) {
  const metadataBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.metadata.value);
  const batch = await getUnitsByStatusAndPages(env, "summary_done", metadataBatchSize, pages ?? null);
  for (const unit of batch) {
    const metadata = await extractMetadataWithRetry(env, unit);
    unit.metadata = metadata;
    // Compute FTS5 text fields from metadata + section
    unit.metadataTermsText = computeMetadataTermsText(metadata);
    unit.aliasesText = computeAliasesText(metadata);
    unit.sectionPathText = computeSectionPathText(unit.section);
    unit.status = "metadata_done";
    unit.updatedAt = new Date().toISOString();
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0 && !pages) {
    detail.phase = "embedding";
    await logDebug(env, "info", "ingestion:metadata", `Metadata phase complete — transitioning to embedding`);
  }
}

/** Extract metadata with retry logic. Metadata extraction is a critical step —
 *  aliases and metadata fields feed into both the embedding text and the FTS5 index.
 *  If all retries fail, the error is thrown and the pipeline halts for this unit. */
async function extractMetadataWithRetry(env: Env, unit: SemanticUnit): Promise<import("../types").UnitMetadata> {
  const maxRetries = INGESTION.llm.defaultMaxRetries.value;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await extractMetadata(env, unit);
    } catch (err) {
      lastErr = err;
      await logDebug(env, "warn", "ingestion:metadata", `Metadata extraction failed (attempt ${attempt + 1}/${maxRetries + 1})`, {
        unitId: unit.id,
        error: String(err),
      });
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s...
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  await logDebug(env, "error", "ingestion:metadata", `Metadata extraction failed after ${maxRetries + 1} attempts — halting pipeline for unit`, {
    unitId: unit.id,
    error: String(lastErr),
  });
  throw new Error(`Metadata extraction failed for unit ${unit.id} after ${maxRetries + 1} attempts: ${String(lastErr)}`);
}

/** Collect parent names by walking parentUnitId up to the root. */
async function collectParentNames(env: Env, unit: SemanticUnit): Promise<string[]> {
  const names: string[] = [];
  let currentId = unit.parentUnitId;
  const visited = new Set<string>(); // guard against cycles
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = await getSemanticUnit(env, currentId);
    if (!parent) break;
    if (parent.name) names.unshift(parent.name);
    currentId = parent.parentUnitId;
  }
  return names;
}

/** Get the document name for a unit's document. */
async function getDocumentName(env: Env, documentId: string | undefined): Promise<string> {
  if (!documentId) return "";
  const row = await env.DB.prepare(`SELECT source_path FROM documents WHERE id = ?`).bind(documentId).first();
  if (!row) return "";
  const path = row.source_path as string;
  // Extract filename without extension
  const filename = path.split("/").pop() ?? path;
  return filename.replace(/\.[^.]+$/, "");
}

async function stepEmbeddingPhase(env: Env, detail: IngestJobDetail, batchSize: number, pages?: number[] | null) {
  const embeddingBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.embedding.value);
  const batch = await getUnitsByStatusAndPages(env, "metadata_done", embeddingBatchSize, pages ?? null);
  if (batch.length === 0 && !pages) {
    detail.phase = "concepts";
    await logDebug(env, "info", "ingestion:embedding", `Embedding phase complete — transitioning to concepts`);
    return;
  }

  // Get document name once for the whole batch
  const documentName = await getDocumentName(env, batch[0].documentId);

  // Collect parent names for each unit (needed for the Path field in embeddings)
  const parentNamesMap = new Map<string, string[]>();
  for (const unit of batch) {
    const parentNames = await collectParentNames(env, unit);
    parentNamesMap.set(unit.id, parentNames);
  }

  // Build subject documents and embed
  const subjectDocs = batch.map((u) => buildSubjectDocument(u, documentName, parentNamesMap.get(u.id) ?? []));
  const subjectVectors = await embedSubjectUnits(env, batch, subjectDocs);
  await upsertSubjectEmbeddings(env, batch, subjectVectors);

  // Build content documents and embed
  const contentDocs = batch.map((u) => buildContentDocument(u, documentName, parentNamesMap.get(u.id) ?? []));
  const contentVectors = await embedContentUnits(env, batch, contentDocs);
  await upsertContentEmbeddings(env, batch, contentVectors);

  // Update unit status and embedding IDs
  const now = new Date().toISOString();
  for (const unit of batch) {
    unit.subjectEmbeddingId = unit.id;
    unit.contentEmbeddingId = unit.id;
    unit.status = "embedding_done";
    unit.updatedAt = now;
    await upsertSemanticUnit(env, unit);
  }
}

async function stepConceptsPhase(env: Env, detail: IngestJobDetail, batchSize: number, pages?: number[] | null) {
  const conceptsBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.concepts.value);
  const batch = await getUnitsByStatusAndPages(env, "embedding_done", conceptsBatchSize, pages ?? null);
  for (const unit of batch) {
    // Clear old mentions for this unit before re-extracting
    await clearConceptMentionsForUnit(env, unit.id);

    const result = await extractConceptsForUnit(env, unit, unit.documentId ?? "doc1");
    await storeConceptResults(env, result);

    unit.status = "done";
    unit.updatedAt = new Date().toISOString();
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0 && !pages) {
    detail.phase = "done";
    await logDebug(env, "info", "ingestion:concepts", `Concepts phase complete — ingestion done`, {
      totalUnits: detail.unitsProcessed,
    });
  }
}

/**
 * Second pass over the whole knowledge base.
 * Rebuilds all concepts using the concept extraction pipeline.
 */
export async function rebuildAllConcepts(env: Env, batchSize: number, cursor: number) {
  const { getAllUnits } = await import("../utils/db");
  const allUnits = await getAllUnits(env);
  const batch = allUnits.slice(cursor, cursor + batchSize);
  let processed = 0;
  for (const unit of batch) {
    await clearConceptMentionsForUnit(env, unit.id);
    const result = await extractConceptsForUnit(env, unit, unit.documentId ?? "doc1");
    await storeConceptResults(env, result);
    processed++;
  }
  const nextCursor = cursor + batch.length;
  const done = nextCursor >= allUnits.length;
  await logDebug(env, "info", "ingestion:concepts", `Rebuild batch complete`, {
    cursor,
    processed,
    nextCursor,
    done,
  });
  return { processed, nextCursor, done };
}
