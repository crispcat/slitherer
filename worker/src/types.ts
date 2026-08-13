export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE_SUBJECTS: VectorizeIndex;
  VECTORIZE_CONTENT: VectorizeIndex;
  VECTORIZE_CONCEPTS_IDX: VectorizeIndex;
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
  "Image",
  "DataTableHeader",
  "DataTableRow",
  "ColumnListTable",
  "ColumnListItem",
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
  metadataTermsText?: string;   // flattened metadata terms for FTS5 (Phase 2)
  sectionPathText?: string;     // section path joined with " > " for FTS5 (Phase 2)
  aliasesText?: string;         // aliases joined with ", " for FTS5 (Phase 2)
  subjectEmbeddingId?: string;
  contentEmbeddingId?: string;
  status: "pending" | "summary_done" | "metadata_done" | "embedding_done" | "done";
  updatedAt: string;
}

// ---- Phase 4: metadata ----
export interface UnitMetadata {
  defines: string[];
  mentions: string[];
  aliases: string[];
}

// ---- Phase 3: concepts ----

export interface Concept {
  id: string;
  documentId: string;
  canonicalName: string;
  description?: string;
  embeddingId?: string;
  sourceUnitIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConceptAlias {
  conceptId: string;
  alias: string;
  normalizedAlias: string;
  language?: string;
  source?: string;
  confidence: number;
}

export interface ConceptMention {
  id: string;
  conceptId: string;
  unitId: string;
  rawTerm: string;
  normalizedTerm: string;
  mentionType: string;
  confidence: number;
  resolutionMethod: "exact_alias" | "normalized_alias" | "embedding" | "llm_validation" | "manual";
  createdAt: string;
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
  /** Phase 8: The original user query, preserved as-is. */
  originalQuery: string;
  /** The translated Russian query (used for retrieval). */
  russianQuery: string;
  /** Phase 8: Extracted entities — proper nouns, abbreviations, numbers, dice notation,
   *  item names, acronyms, and game terminology that should be preserved across translation. */
  entities?: string[];
  /** Present when rag=false — the direct chat response. */
  chatResponse?: string;
}

export interface DecomposeResult {
  subQueries: string[];
  /** Dynamic rerank threshold — precise questions get higher (0.4-0.5),
   *  exploratory questions get lower (0.2-0.3).
   *  Phase 6: This is now ignored by the retrieval pipeline — server-controlled
   *  threshold is used instead. Kept for backward compatibility. */
  rerankThreshold: number;
  /** Phase 7: Whether this is a list/enumeration query (e.g. "list all weapons").
   *  List queries skip the normal evidence budget cap. */
  isListQuery?: boolean;
  /** Phase 9: Query complexity classification — "simple" or "complex".
   *  Complex queries use iterative retrieval as the primary mechanism. */
  queryComplexity?: "simple" | "complex";
}

/** Phase 9: Categorized sufficiency gap types. */
export type GapType =
  | "missing_exception"
  | "missing_prerequisite"
  | "missing_interaction"
  | "missing_table_dimension"
  | "missing_definition"
  | "contradictory_evidence"
  | "missing_step"
  | "missing_dependency"
  | "missing_category_member"
  | "other";

export interface SufficiencyGap {
  type: GapType;
  description: string;
  /** Which specific entity/concept the gap is about. */
  target?: string;
  /** Suggested follow-up query to fill this gap. */
  followUpQuery?: string;
}

export interface SufficiencyResult {
  sufficient: boolean;
  gaps: string[];
  /** Phase 9: Categorized gaps with type, description, and targeted follow-up. */
  categorizedGaps?: SufficiencyGap[];
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

