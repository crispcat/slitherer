import type { Env, SemanticUnit, VisionContinuation } from "../types";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";
import {
  countUnitsByStatus,
  createIngestionJob,
  getIngestionJob,
  getUnitsByStatus,
  insertRelation,
  logDebug,
  updateIngestionJob,
  upsertDocument,
  upsertSemanticUnit,
} from "../utils/db";
import { generateSummary } from "./summary";
import { extractMetadata } from "./metadata";
import { extractRelationships } from "./relationships";
import { embedUnits, upsertEmbeddings } from "./embeddings";
import { populateRelations } from "./graph";
import { extractPage } from "./vision_extract";
import { normalizeUnits } from "./vision_verify";
import { INGESTION } from "../config.gen";

export type IngestPhase = "vision" | "summary" | "metadata" | "relations" | "done";

/** All valid stages that can be targeted with --stage. */
export const INGEST_STAGES = ["vision", "summary", "metadata", "relations"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Order of phases — used to skip ahead when a target stage is requested. */
const PHASE_ORDER: IngestPhase[] = ["vision", "summary", "metadata", "relations", "done"];

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
  const result = await extractPage(
    env,
    imageBase64,
    pageNumber,
    detail.continuation ?? null,
  );

  // 3. Normalize units (inherit sections from parent, map unknown types)
  const normalized = normalizeUnits(result.units);

  // 5b. Assign deterministic IDs based on (documentId, pageNumber, sourceOrder).
  // This ensures that re-processing the same page (e.g. Queue redelivery) produces
  // the same IDs, so upserts overwrite instead of creating duplicates.
  const oldToNewId = new Map<string, string>();
  for (let i = 0; i < normalized.length; i++) {
    const oldId = normalized[i].id;
    const prefix = normalized[i].type === "Table" ? "TABLE" : "RULE";
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
  // First, clean up any existing relations for units on this page (in case of
  // Queue redelivery — deterministic IDs mean the units themselves will be
  // upserted, but old relations referencing these IDs need to be cleared).
  const unitIds = normalized.map((u) => u.id);
  if (unitIds.length > 0) {
    const placeholders = unitIds.map(() => "?").join(",");
    await env.DB.prepare(
      `DELETE FROM relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
    ).bind(...unitIds, ...unitIds).run();
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
      status: "pending",
      updatedAt: now,
    };
    await upsertSemanticUnit(env, semanticUnit);
  }

  // 5. Update job state
  detail.pagesProcessed += 1;
  detail.unitsProcessed += normalized.length;
  detail.continuation = result.continuation;

  // Vision is done when all enqueued pages have been processed.
  // If `pages` is set, compare against its length; otherwise compare against totalPages.
  const targetPages = detail.pages ? detail.pages.length : detail.totalPages;
  const visionDone = detail.pagesProcessed >= targetPages;
  if (visionDone) {
    detail.phase = "summary";
    detail.continuation = null;
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
 * Advances an ingestion job by one batch for the summary/metadata/relations phases.
 * The vision phase is handled by the Queue (processVisionPage), not here.
 *
 * Call repeatedly (e.g. from a client poll loop) until job.status === "done".
 *
 * The pipeline runs as four sequential, whole-document phases:
 *   1. vision    — Queue-based: each page is processed by processVisionPage.
 *   2. summary   — Generate summary + embed using summary, for every unit.
 *      Uses parent name and children names as context (not parent summaries),
 *      so no parent-first ordering needed. Embeddings upserted to Vectorize.
 *   3. metadata  — Phase 4 metadata extraction, for every unit.
 *   4. relations — Phase 5 + graph relations (Phase 7), for every unit.
 */
export async function processIngestionBatch(
  env: Env,
  jobId: string,
  batchSize = INGESTION.ingestion.batchSizes.summary.value,
  targetStage?: IngestStage,
) {
  const job = await getIngestionJob(env, jobId);
  if (!job) throw new Error(`Unknown ingestion job ${jobId}`);
  if ((job as any).status === "done") return { done: true, phase: "done", progress: 1 };

  const detail: IngestJobDetail = JSON.parse((job as any).detail);

  // If a target stage is specified, skip ahead to it by advancing the phase.
  if (targetStage) {
    const currentIdx = PHASE_ORDER.indexOf(detail.phase);
    const targetIdx = PHASE_ORDER.indexOf(targetStage);
    if (targetIdx > currentIdx) {
      detail.phase = targetStage;
      await updateIngestionJob(env, jobId, detail.phase, "running", JSON.stringify(detail));
    }
  }

  switch (detail.phase) {
    case "vision":
      // Vision phase is Queue-driven — nothing to do here.
      // Return current progress so the client can poll.
      break;
    case "summary":
      await stepSummaryPhase(env, detail, batchSize);
      break;
    case "metadata":
      await stepMetadataPhase(env, detail, batchSize);
      break;
    case "relations":
      await stepRelationsPhase(env, detail, batchSize);
      break;
  }

  const done = detail.phase === "done";
  const stageDone = targetStage && detail.phase !== targetStage && detail.phase !== "done"
    ? true
    : done;

  await updateIngestionJob(env, jobId, detail.phase, done ? "done" : "running", JSON.stringify(detail));

  const remaining = done
    ? 0
    : detail.phase === "vision"
      ? detail.totalPages - detail.pagesProcessed
      : await countUnitsByStatus(env, statusForPhase(detail.phase));

  await logDebug(env, "info", `ingestion:${detail.phase}`, `Batch complete`, {
    jobId,
    phase: detail.phase,
    unitsProcessed: detail.unitsProcessed,
    remaining,
    done: stageDone || done,
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
    case "relations":
      return "metadata_done";
    default:
      return "pending";
  }
}

async function stepSummaryPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const summaryBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.summary.value);
  const batch = await getUnitsByStatus(env, "pending", summaryBatchSize);
  for (const unit of batch) {
    unit.summary = await generateSummary(env, unit);
    unit.status = "summary_done";
    unit.updatedAt = new Date().toISOString();
    // Embed using the generated summary and upsert to Vectorize immediately.
    const vectors = await embedUnits(env, [unit]);
    await upsertEmbeddings(env, [unit], vectors);
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "metadata";
    await logDebug(env, "info", "ingestion:summary", `Summary phase complete — transitioning to metadata`);
  }
}

async function stepMetadataPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const metadataBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.metadata.value);
  const batch = await getUnitsByStatus(env, "summary_done", metadataBatchSize);
  for (const unit of batch) {
    const metadata = await extractMetadata(env, unit);
    unit.metadata = metadata;
    unit.status = "metadata_done";
    unit.updatedAt = new Date().toISOString();
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "relations";
    await logDebug(env, "info", "ingestion:metadata", `Metadata phase complete — transitioning to relations`);
  }
}

async function stepRelationsPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const relationsBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.relations.value);
  const batch = await getUnitsByStatus(env, "metadata_done", relationsBatchSize);
  for (const unit of batch) {
    const relations = await extractRelationships(env, unit);
    await populateRelations(env, unit, relations);

    // Deterministic parent_of/child_of relations from the unit hierarchy
    if (unit.parentUnitId) {
      await insertRelation(env, {
        id: nextId("REL"),
        source: unit.parentUnitId,
        target: unit.id,
        relation_type: "parent_of",
        confidence: 1.0,
      });
      await insertRelation(env, {
        id: nextId("REL"),
        source: unit.id,
        target: unit.parentUnitId,
        relation_type: "child_of",
        confidence: 1.0,
      });
    }

    unit.status = "relations_done";
    unit.updatedAt = new Date().toISOString();
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "done";
    await logDebug(env, "info", "ingestion:relations", `Relations phase complete — ingestion done`, {
      totalUnits: detail.unitsProcessed,
    });
  }
}

/**
 * Second pass over Phase 5 across the whole knowledge base.
 * Rebuilds all relationships using vector-search-based extraction.
 */
export async function rebuildAllRelationships(env: Env, batchSize: number, cursor: number) {
  const { getAllUnits } = await import("../utils/db");
  const allUnits = await getAllUnits(env);
  const batch = allUnits.slice(cursor, cursor + batchSize);
  let processed = 0;
  for (const unit of batch) {
    const relations = await extractRelationships(env, unit);
    await populateRelations(env, unit, relations);
    processed++;
  }
  const nextCursor = cursor + batch.length;
  const done = nextCursor >= allUnits.length;
  await logDebug(env, "info", "ingestion:relations", `Rebuild batch complete`, {
    cursor,
    processed,
    nextCursor,
    done,
  });
  return { processed, nextCursor, done };
}
