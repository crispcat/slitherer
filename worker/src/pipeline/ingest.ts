import type { Env, StructureDocument, StructureNode } from "../types";
import { sha256 } from "../utils/hash";
import {
  countUnitsByStatus,
  createIngestionJob,
  findCandidateUnits,
  getAllUnits,
  getIngestionJob,
  getSemanticUnitsBySourceNode,
  getUnitsByStatus,
  updateIngestionJob,
  upsertDocument,
  upsertSemanticUnit,
  upsertStructureNode,
} from "../utils/db";
import { detectSemanticUnits } from "./units";
import { extractMetadata } from "./metadata";
import { extractRelationships } from "./relationships";
import { embedUnits, upsertEmbeddings } from "./embeddings";
import { populateConceptsAndKeywords, populateRelations } from "./graph";

const LEAF_TYPES = new Set(["rule", "table", "note", "image"]);

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

export type IngestPhase = "units" | "metadata" | "relations" | "embeddings" | "done";

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
 * The pipeline runs as four sequential, whole-document phases rather than
 * interleaving Phases 3-6 per node:
 *   1. units      — Phase 3, detect/split semantic units for every leaf node.
 *   2. metadata   — Phase 4 + keywords/concepts (Phase 7), for every unit.
 *   3. relations  — Phase 5 + graph relations (Phase 7), for every unit.
 *   4. embeddings — Phase 6, for every unit.
 * Each phase only starts once the previous phase has processed the entire
 * document, so e.g. relationship extraction can consider ANY unit in the
 * book as a candidate target, not just already-processed ones.
 */
export async function processIngestionBatch(env: Env, doc: StructureDocument, jobId: string, batchSize = 3) {
  const job = await getIngestionJob(env, jobId);
  if (!job) throw new Error(`Unknown ingestion job ${jobId}`);
  if ((job as any).status === "done") return { done: true, phase: "done", progress: 1 };

  const detail: IngestJobDetail = JSON.parse((job as any).detail);

  switch (detail.phase) {
    case "units":
      await stepUnitsPhase(env, doc, detail, batchSize);
      break;
    case "metadata":
      await stepMetadataPhase(env, detail, batchSize);
      break;
    case "relations":
      await stepRelationsPhase(env, detail, batchSize);
      break;
    case "embeddings":
      await stepEmbeddingsPhase(env, detail, batchSize);
      break;
  }

  const done = detail.phase === "done";
  await updateIngestionJob(env, jobId, detail.phase, done ? "done" : "running", JSON.stringify(detail));

  const remaining = done
    ? 0
    : detail.phase === "units"
      ? detail.nodeIds.length - detail.cursor
      : await countUnitsByStatus(env, statusForPhase(detail.phase));

  return { done, phase: detail.phase, unitsProcessed: detail.unitsProcessed, remaining };
}

function statusForPhase(phase: IngestPhase): string {
  switch (phase) {
    case "metadata":
      return "pending";
    case "relations":
      return "metadata_done";
    case "embeddings":
      return "relations_done";
    default:
      return "pending";
  }
}

async function stepUnitsPhase(env: Env, doc: StructureDocument, detail: IngestJobDetail, batchSize: number) {
  const end = Math.min(detail.cursor + batchSize, detail.nodeIds.length);

  for (let i = detail.cursor; i < end; i++) {
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
    detail.phase = "metadata";
    detail.cursor = 0;
  }
}

async function stepMetadataPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const batch = await getUnitsByStatus(env, "pending", batchSize);
  for (const unit of batch) {
    unit.metadata = await extractMetadata(env, unit);
    unit.summary = unit.metadata.summary;
    unit.status = "metadata_done";
    await upsertSemanticUnit(env, unit);
    await populateConceptsAndKeywords(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "relations";
  }
}

async function stepRelationsPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const batch = await getUnitsByStatus(env, "metadata_done", batchSize);
  for (const unit of batch) {
    // Full knowledge base is already populated by this point, so candidates
    // can come from anywhere in the document, forward or backward references.
    const candidates = await findCandidateUnits(env, unit, 25);
    const relations = await extractRelationships(env, unit, candidates);
    await populateRelations(env, unit, relations);
    unit.status = "relations_done";
    await upsertSemanticUnit(env, unit);
  }
  if (batch.length === 0) {
    detail.phase = "embeddings";
  }
}

async function stepEmbeddingsPhase(env: Env, detail: IngestJobDetail, batchSize: number) {
  const batch = await getUnitsByStatus(env, "relations_done", batchSize);
  if (batch.length > 0) {
    const vectors = await embedUnits(env, batch);
    await upsertEmbeddings(env, batch, vectors);
    for (const unit of batch) {
      unit.status = "graphed";
      unit.embeddingId = unit.id;
      await upsertSemanticUnit(env, unit);
    }
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
export async function rebuildAllRelationships(env: Env, batchSize = 10, cursor = 0) {
  const all = await getAllUnits(env);
  const end = Math.min(cursor + batchSize, all.length);
  for (let i = cursor; i < end; i++) {
    const unit = all[i];
    const candidates = await findCandidateUnits(env, unit, 25);
    const relations = await extractRelationships(env, unit, candidates);
    await populateRelations(env, unit, relations);
  }
  return { done: end >= all.length, cursor: end, total: all.length };
}
