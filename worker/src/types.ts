export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE_INDEX: VectorizeIndex;
  slitherer_rag_storage: R2Bucket;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  EXTRACTION_MODEL: string;
  ANSWER_MODEL: string;
  RERANK_MODEL: string;
  /** Required (via `wrangler secret put ADMIN_API_KEY`) to call any /ingest* endpoint. */
  ADMIN_API_KEY: string;
  /** Optional (via `wrangler secret put QUERY_API_KEY`). If set, /query also requires it. */
  QUERY_API_KEY?: string;
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

export interface StructureDocument {
  root: string;
  nodes: Record<string, StructureNode>;
}

// ---- Phase 3: semantic units ----
export const SEMANTIC_UNIT_TYPES = [
  "Rule",
  "Attribute",
  "Skill",
  "Trait",
  "Ability",
  "Action",
  "StatusEffect",
  "Item",
  "Spell",
  "Example",
  "Situation",
  "Modifier",
  "Definition",
  "Equipment",
  "Weapon",
  "Formula",
  "Table",
] as const;
export type SemanticUnitType = (typeof SEMANTIC_UNIT_TYPES)[number];

export interface SemanticUnit {
  id: string;
  sourceNodeId: string;
  parentUnitId: string | null;
  secondaryParentUnitId: string | null;
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
  status: "pending" | "metadata_done" | "relations_done" | "embedded" | "graphed";
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
  keywords: string[];
  aliases: string[];
  summary: string;
  /** Reference-like strings extracted from metadata that could not be resolved
   *  to any candidate unit. Stored for downstream reporting and iterative cleanup. */
  unresolved_references?: string[];
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

export interface QueryResult {
  answer: string;
  citations: Citation[];
  usedUnitIds: string[];
}
