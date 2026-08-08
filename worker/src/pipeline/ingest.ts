import type { Env, StructureDocument, StructureNode } from "../types";
import { sha256 } from "../utils/hash";
import {
  countUnitsByStatus,
  createIngestionJob,
  getAllUnits,
  getIngestionJob,
  getSemanticUnitsBySourceNode,
  getUnitsByStatus,
  getUnitsByStatusParentFirst,
  updateIngestionJob,
  upsertDocument,
  upsertSemanticUnit,
  upsertStructureNode,
} from "../utils/db";
import { detectSemanticUnits } from "./units";
import { generateSummary } from "./summary";
import { extractMetadata } from "./metadata";
import { extractRelationships } from "./relationships";
import { embedUnits, upsertEmbeddings } from "./embeddings";
import { populateConceptsAndKeywords, populateRelations } from "./graph";
import { INGESTION } from "../config.gen";

const LEAF_TYPES = new Set<string>(INGESTION.ingestion.leafTypes.value);

/** DFS over the Phase-2 structure tree, returning leaf nodes in document order. */
function flattenLeafNodes(doc: StructureDocument): StructureNode[] {
  const out: StructureNode[] = [];
  const visit = (id: string) => {
    const node = doc.nodes[id];
    if (!node) return;
    if (LEAF_TYPES.has(node.type)) out.push(node);
    for (const childId of node.children) visit(childId);
  };
  visit(doc.root);
  return out;
}

export type IngestPhase = "units" | "summary" | "metadata" | "relations" | "done";

/** All valid stages that can be targeted with --stage. */
export const INGEST_STAGES = ["units", "summary", "metadata", "relations"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];

/** Order of phases — used to skip ahead when a target stage is requested. */
const PHASE_ORDER: IngestPhase[] = ["units", "summary", "metadata", "relations", "done"];

export interface IngestJobDetail {
  documentId: string;
  nodeIds: string[];
  phase: IngestPhase;
  cursor: number; // only meaningful during the "units" phase (index into nodeIds)
  unitsProcessed: number;
}

/** Registers a document + persists structure nodes, and initializes a resumable job. */
export async function startIngestion(env: Env, documentId: string, sourcePath: string, doc: StructureDocument, jobId: string) {
  await upsertDocument(env, documentId, sourcePath);

  const leafNodes = flattenLeafNodes(doc);
  for (const nodeId of Object.keys(doc.nodes)) {
    const node = doc.nodes[nodeId];
    const hash = await sha256(node.content);
    await upsertStructureNode(env, documentId, node, hash);
  }

  const detail: IngestJobDetail = {
    documentId,
    nodeIds: leafNodes.map((n) => n.id),
    phase: "units",
    cursor: 0,
    unitsProcessed: 0,
  };
  await createIngestionJob(env, jobId, documentId);
  await updateIngestionJob(env, jobId, "units", "running", JSON.stringify(detail));

  return { totalNodes: leafNodes.length };
}

/**
 * Advances an ingestion job by one batch. Call repeatedly (e.g. from a
 * client poll loop) until job.status === "done" to stay within a single
 * Worker invocation's CPU budget.
 *
 * The pipeline runs as four sequential, whole-document phases:
 *   1. units      — Phase 3, detect/split semantic units for every leaf node.
 *   2. summary    — Generate summary (70b) + embed using summary, for every
 *      unit. Processed parent-first so parent summaries are available when
 *      generating child summaries. Embeddings are upserted to Vectorize here
 *      so they're available for vector-search-based relationship extraction
 *      in the next phase.
 *   3. metadata   — Phase 4 + keywords/concepts (Phase 7), for every unit.
 *      Extracts all 14 relationship fields + keywords + aliases using the
 *      70b model. Processed parent-first. Uses the pre-generated summary as
 *      input context.
 *   4. relations  — Phase 5 + graph relations (Phase 7), for every unit.
 *      Vector-search-based: for each term in the unit's metadata fields,
 *      embed (term + summary) and search Vectorize for matches. Confidence
 *      = similarity score. No deterministic adjacency or parent edges —
 *      parent/child hierarchy is read directly from semantic_units columns
 *      at retrieval time.
 * Each phase only starts once the previous phase has processed the entire
 * document, so relationship extraction can search against ALL units in the
 * vector database, not just already-processed ones.
 */
export async function processIngestionBatch(
  env: Env,
  doc: StructureDocument,
  jobId: string,
  batchSize = INGESTION.ingestion.batchSizes.unitsDefault.value,
  targetStage?: IngestStage
) {
  const job = await getIngestionJob(env, jobId);
  if (!job) throw new Error(`Unknown ingestion job ${jobId}`);
  if ((job as any).status === "done") return { done: true, phase: "done", progress: 1 };

  const detail: IngestJobDetail = JSON.parse((job as any).detail);

  // If a target stage is specified, skip ahead to it by advancing the phase.
  // This is used when the client requests --stage <name> to run only one phase.
  if (targetStage) {
    const currentIdx = PHASE_ORDER.indexOf(detail.phase);
    const targetIdx = PHASE_ORDER.indexOf(targetStage);
    if (targetIdx > currentIdx) {
      // Skip to the target phase. For phases after "units", we need to ensure
      // all units are processed first — the summary/metadata/relations phases
      // query by status, so they'll pick up whatever's pending.
      // If skipping past "units", mark all structure nodes as processed.
      if (currentIdx === 0 && targetIdx > 0) {
        detail.cursor = detail.nodeIds.length;
        detail.unitsProcessed = detail.nodeIds.length;
      }
      detail.phase = targetStage;
      await updateIngestionJob(env, jobId, detail.phase, "running", JSON.stringify(detail));
    }
  }

  switch (detail.phase) {
    case "units":
      await stepUnitsPhase(env, doc, detail, batchSize);
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
  // If a target stage was specified, stop after that stage completes
  // (i.e. when the phase transitions PAST the target stage).
  const stageDone = targetStage && detail.phase !== targetStage && detail.phase !== "done"
    ? true
    : done;

  await updateIngestionJob(env, jobId, detail.phase, done ? "done" : "running", JSON.stringify(detail));

  const remaining = done
    ? 0
    : detail.phase === "units"
      ? detail.nodeIds.length - detail.cursor
      : await countUnitsByStatus(env, statusForPhase(detail.phase));

  return { done: stageDone || done, phase: detail.phase, unitsProcessed: detail.unitsProcessed, remaining };
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

async function stepUnitsPhase(env: Env, doc: StructureDocument, detail: IngestJobDetail, batchSize: number) {
  // Tables require LLM calls (70b model) that can take several seconds each.
  // Process tables one at a time to avoid exceeding the Worker wall-time limit.
  const start = detail.cursor;
  let end = Math.min(start + batchSize, detail.nodeIds.length);

  // If the first node in this batch is a table, process only one node.
  if (end > start + 1) {
    const firstNode = doc.nodes[detail.nodeIds[start]];
    if (firstNode?.type === "table") {
      end = start + 1;
    }
  }

  for (let i = start; i < end; i++) {
    const node = doc.nodes[detail.nodeIds[i]];
    if (!node) continue;

    // Incremental update check: skip re-processing if content is unchanged.
    const existing = await getSemanticUnitsBySourceNode(env, node.id);
    const hash = await sha256(node.content);
    if (existing.length > 0 && existing.every((u) => u.contentHash === hash)) {
      continue;
    }

    const units = await detectSemanticUnits(env, node);
    for (const unit of units) {
      await upsertSemanticUnit(env, unit); // status: "pending"
      detail.unitsProcessed += 1;
    }
  }

  detail.cursor = end;
  if (detail.cursor >= detail.nodeIds.length) {
    detail.phase = "summary";
    detail.cursor = 0;
  }
}

async function stepSummaryPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  // Parent-first ordering: process units whose parents are already past the
  // pending state, so parent summaries are available when generating child
  // summaries. Critical for table cells and orphan-linked children.
  // Uses the 70b model — process fewer units per batch to stay within CPU budget.
  const summaryBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.summary.value);
  const batch = await getUnitsByStatusParentFirst(env, "pending", summaryBatchSize);
  for (const unit of batch) {
    unit.summary = await generateSummary(env, unit);
    // Embed using the generated summary and upsert to Vectorize immediately.
    // Embeddings must exist before the relations phase (vector-search-based
    // relationship extraction searches against the full vector database).
    const vectors = await embedUnits(env, [unit]);
    await upsertEmbeddings(env, [unit], vectors);
    unit.embeddingId = unit.id;
    unit.status = "summary_done";
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "metadata";
  }
}

async function stepMetadataPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  // Parent-first ordering: parent metadata is available when processing children.
  // Uses the 70b model — process fewer units per batch.
  const metadataBatchSize = Math.min(batchSize, INGESTION.ingestion.batchSizes.metadata.value);
  const batch = await getUnitsByStatusParentFirst(env, "summary_done", metadataBatchSize);
  for (const unit of batch) {
    unit.metadata = await extractMetadata(env, unit);
    unit.status = "metadata_done";
    await upsertSemanticUnit(env, unit);
    await populateConceptsAndKeywords(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "relations";
  }
}

async function stepRelationsPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  // Vector-search-based relationship extraction: for each term in the unit's
  // metadata fields, embed (term + summary) and search Vectorize. Process one
  // unit at a time to stay within CPU/wall-time budget.
  const batch = await getUnitsByStatus(env, "metadata_done", 1);
  if (batch.length > 0) {
    const unit = batch[0];
    // All units are already embedded from the summary phase. Vector search
    // queries against the full Vectorize index — no need to load all units
    // from D1.
    const relations = await extractRelationships(env, unit);
    await populateRelations(env, unit, relations);
    unit.status = "relations_done";
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "done";
  }
}

/**
 * Utility for incremental updates: re-runs Phase 5 across every unit
 * currently in the knowledge base (e.g. after a batch of nodes changed and
 * you want old units to re-consider the updated ones as candidates too).
 * Not needed for a fresh ingest — the staged pipeline above already runs
 * Phase 5 once the full document exists.
 */
export async function rebuildAllRelationships(env: Env, batchSize = INGESTION.ingestion.batchSizes.rebuildRelations.value, cursor = 0) {
  const all = await getAllUnits(env);
  const end = Math.min(cursor + batchSize, all.length);
  for (let i = cursor; i < end; i++) {
    const unit = all[i];
    const relations = await extractRelationships(env, unit);
    await populateRelations(env, unit, relations);
  }
  return { done: end >= all.length, cursor: end, total: all.length };
}
