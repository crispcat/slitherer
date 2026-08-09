export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE_INDEX: VectorizeIndex;
  slitherer_rag_storage: R2Bucket;
  VISION_QUEUE: Queue<QueueMessage>;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  EXTRACTION_MODEL: string;
  REASONING_MODEL: string;
  ANSWER_MODEL: string;
  RERANK_MODEL: string;
  VISION_MODEL: string;
  /** Required (via `wrangler secret put ADMIN_API_KEY`) to call any /ingest* endpoint. */
  ADMIN_API_KEY: string;
  /** Optional (via `wrangler secret put QUERY_API_KEY`). If set, /query also requires it. */
  QUERY_API_KEY?: string;
}

/** Message enqueued to the vision-ingest Queue for each page. */
export interface QueueMessage {
  jobId: string;
  documentId: string;
  pageNumber: number;
}

// ---- Phase 2 structural node, as produced by the local Python parser ----
export interface StructureNode {
  id: string;
  type: "document" | "chapter" | "section" | "subsection" | "group" | "rule" | "table" | "image" | "note";
  parent: string | null;
  page: number;
  path: string[];
  content: string;
  children: string[];
}

// ---- Phase 3: semantic units ----
export const SEMANTIC_UNIT_TYPES = [
  "Rule",
  "Table",
  "Image",
] as const;
export type SemanticUnitType = (typeof SEMANTIC_UNIT_TYPES)[number];

export interface SemanticUnit {
  id: string;
  documentId: string;
  sourceNodeId: string;
  parentUnitId: string | null;
  sourceOrder: number; // position within the source structure node (for adjacency relations)
  type: SemanticUnitType;
  name: string | null;
  page: number;
  section: string[];
  content: string;
  contentHash: string;
  summary?: string;
  metadata?: UnitMetadata;
  embeddingId?: string;
  status: "pending" | "summary_done" | "metadata_done" | "relations_done" | "done";
  updatedAt: string;
}

// ---- Phase 4: metadata ----
export interface UnitMetadata {
  defines: string[];
  references: string[];
  requires: string[];
  exceptions: string[];
  modifies: string[];
  modified_by: string[];
  overrides: string[];
  related_to: string[];
  incompatible_with: string[];
  creates: string[];
  consumes: string[];
  supersedes: string[];
  example_of: string[];
  part_of: string[];
  aliases: string[];
}

// ---- Phase 5: relationships ----
export const RELATION_TYPES = [
  "defines",
  "references",
  "requires",
  "excepts",
  "modifies",
  "modified_by",
  "overrides",
  "related_to",
  "incompatible_with",
  "creates",
  "consumes",
  "supersedes",
  "example_of",
  "part_of",
  "parent_of",
  "child_of",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Relation {
  id: string;
  source: string;
  target: string;
  relation_type: RelationType;
  confidence: number;
}

// ---- Query pipeline ----
export interface Citation {
  unitId: string;
  section: string;
  page: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RouterResult {
  rag: boolean;
  language: string;
  russianQuery: string;
  /** Present when rag=false — the direct chat response. */
  chatResponse?: string;
}

export interface DecomposeResult {
  subQueries: string[];
  /** Dynamic rerank threshold — precise questions get higher (0.4-0.5),
   *  exploratory questions get lower (0.2-0.3). */
  rerankThreshold: number;
}

export interface SufficiencyResult {
  sufficient: boolean;
  gaps: string[];
  followUpQueries: string[];
}

export interface QueryResult {
  answer: string;
  citations: Citation[];
  usedUnitIds: string[];
  language: string;
  /** Debug info — only returned when debug=true. */
  debug?: QueryDebug;
}

export interface QueryDebug {
  router: RouterResult;
  decomposition: DecomposeResult;
  iterations: IterationDebug[];
  finalEvidenceCount: number;
}

export interface IterationDebug {
  iteration: number;
  subQueries: string[];
  candidatesFound: number;
  afterRerank: number;
  sufficiency?: SufficiencyResult;
}

// ---- Vision extraction pipeline ----

/** A unit as returned by the vision model (before verification). */
export interface VisionUnit {
  id: string;
  type: string;
  name: string | null;
  content: string;
  /** Name of the parent unit, as output by the model. */
  parentName: string | null;
  /** Resolved from parentName in post-processing. The parent unit's id, or null for root. */
  parentId: string | null;
  page: number | null;
  section: string[];
}

/** Continuation state passed between pages. */
export interface VisionContinuation {
  sectionPath: string[];
  lastUnitName: string | null;
  lastUnitContent: string;
  /** Recent container units (name + content) for cross-page parent linking. */
  lastContainers: { name: string; content: string }[];
}

/** Full response from the vision model for one page. */
export interface VisionPageResult {
  units: VisionUnit[];
  continuation: VisionContinuation;
}

