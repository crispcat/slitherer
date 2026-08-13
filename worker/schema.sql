-- Phase 7 — Knowledge Graph schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structure_nodes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  page INTEGER,
  section_path TEXT NOT NULL, -- JSON array
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_structure_nodes_parent ON structure_nodes(parent_id);

CREATE TABLE IF NOT EXISTS semantic_units (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  document_id TEXT,
  source_node_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- Rule, DataTableHeader, DataTableRow, ColumnListTable, ColumnListItem, Image
  name TEXT,
  page INTEGER,
  section TEXT NOT NULL,        -- JSON array section path
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  metadata_json TEXT,           -- raw metadata extraction output (defines/references/requires/exceptions/modifies/modified_by/overrides/related_to/incompatible_with/creates/consumes/supersedes/example_of/part_of/aliases)
  metadata_terms_text TEXT,     -- flattened metadata terms for FTS5 index (Phase 2)
  section_path_text TEXT,       -- section array joined with " > " for FTS5 index (Phase 2)
  aliases_text TEXT,            -- aliases joined with ", " for FTS5 index (Phase 2)
  parent_unit_id TEXT,          -- parent unit (section/header)
  source_order INTEGER NOT NULL DEFAULT 0, -- position of this unit within its source structure node
  subject_embedding_id TEXT,    -- Vectorize vector id in slitherer-rag-subjects index
  content_embedding_id TEXT,    -- Vectorize vector id in slitherer-rag-content index
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> summary_done -> metadata_done -> embedding_done -> done
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_unit_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_semantic_units_source_node ON semantic_units(source_node_id);
CREATE INDEX IF NOT EXISTS idx_semantic_units_status ON semantic_units(status);
CREATE INDEX IF NOT EXISTS idx_semantic_units_hash ON semantic_units(content_hash);
CREATE INDEX IF NOT EXISTS idx_semantic_units_document ON semantic_units(document_id);

-- Phase 2: FTS5 external content table for lexical search
-- FTS5 stores only the inverted index; content is read from semantic_units via rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_unit_search USING fts5(
  name,
  aliases_text,
  summary,
  content,
  section_path_text,
  metadata_terms_text,
  content='semantic_units',
  content_rowid='rowid'
);

-- FTS5 sync triggers: keep the FTS index updated atomically with base table changes
CREATE TRIGGER IF NOT EXISTS semantic_units_ai AFTER INSERT ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(rowid, name, aliases_text, summary, content, section_path_text, metadata_terms_text)
  VALUES (new.rowid, new.name, new.aliases_text, new.summary, new.content, new.section_path_text, new.metadata_terms_text);
END;

CREATE TRIGGER IF NOT EXISTS semantic_units_ad AFTER DELETE ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(semantic_unit_search, rowid, name, aliases_text, summary, content, section_path_text, metadata_terms_text)
  VALUES ('delete', old.rowid, old.name, old.aliases_text, old.summary, old.content, old.section_path_text, old.metadata_terms_text);
END;

CREATE TRIGGER IF NOT EXISTS semantic_units_au AFTER UPDATE ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(semantic_unit_search, rowid, name, aliases_text, summary, content, section_path_text, metadata_terms_text)
  VALUES ('delete', old.rowid, old.name, old.aliases_text, old.summary, old.content, old.section_path_text, old.metadata_terms_text);
  INSERT INTO semantic_unit_search(rowid, name, aliases_text, summary, content, section_path_text, metadata_terms_text)
  VALUES (new.rowid, new.name, new.aliases_text, new.summary, new.content, new.section_path_text, new.metadata_terms_text);
END;

-- Phase 3: Concept tables (replace relations for related-rule discovery)

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  description TEXT,
  embedding_id TEXT,
  source_unit_ids TEXT,         -- JSON array of unit IDs used to generate the description
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS concept_aliases (
  concept_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  language TEXT,
  source TEXT,                  -- how this alias was discovered
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (concept_id, normalized_alias),
  FOREIGN KEY (concept_id) REFERENCES concepts(id)
);

CREATE TABLE IF NOT EXISTS concept_mentions (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  raw_term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  mention_type TEXT NOT NULL,   -- defines | mentions
  confidence REAL NOT NULL,
  resolution_method TEXT NOT NULL,  -- exact_alias, normalized_alias, embedding, llm_validation, manual
  created_at TEXT NOT NULL,
  FOREIGN KEY (concept_id) REFERENCES concepts(id),
  FOREIGN KEY (unit_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_concept ON concept_mentions(concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_unit ON concept_mentions(unit_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  phase TEXT NOT NULL,   -- vision|summary|metadata|embedding|concepts|done
  status TEXT NOT NULL,  -- running|done|error
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Query pipeline tables

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  messages TEXT NOT NULL,    -- JSON array of {role, content}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  step TEXT NOT NULL,        -- router|decompose|retrieve|sufficiency|answer
  input TEXT NOT NULL,       -- JSON: step input
  output TEXT NOT NULL,      -- JSON: step output
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_query_logs_conversation ON query_logs(conversation_id);

-- Phase 10: Candidate logs for retrieval diagnostics
-- Records per-stage candidate data and provenance for debugging and analysis.
CREATE TABLE IF NOT EXISTS candidate_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  query_text TEXT NOT NULL,       -- the original question
  iteration INTEGER NOT NULL,     -- which retrieval iteration (0-based)
  stage TEXT NOT NULL,            -- hybrid_retrieval|concept_expansion|hierarchy_expansion|rerank|evidence_selection
  unit_id TEXT,                   -- candidate unit ID (null for aggregate logs)
  unit_name TEXT,
  unit_type TEXT,
  vector_score REAL,              -- RRF-fused score from hybrid retrieval
  rerank_score REAL,              -- reranker score
  final_score REAL,               -- Phase 6 weighted final score
  provenance TEXT,                -- JSON: structured provenance sources
  selected INTEGER DEFAULT 0,    -- 1 if this candidate was selected as evidence
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_logs_conversation ON candidate_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_candidate_logs_query ON candidate_logs(query_text);

-- Debug logs (ingestion + retrieval pipeline events)

CREATE TABLE IF NOT EXISTS debug_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,        -- info|warn|error
  source TEXT NOT NULL,       -- ingestion|retrieval|router|units|summary|metadata|relations|etc.
  message TEXT NOT NULL,
  data TEXT,                  -- JSON: optional structured payload
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debug_logs_created ON debug_logs(created_at);

-- Drop deprecated unit_issues table (issue detection removed)
DROP TABLE IF EXISTS unit_issues;

-- Note: The rowid INTEGER PRIMARY KEY change requires dropping and recreating the
-- semantic_units table. For existing databases, run:
--   DROP TABLE IF EXISTS semantic_unit_search;
--   DROP TABLE IF EXISTS semantic_units;
--   Then re-run this schema and re-ingest.
-- The ALTER TABLE migrations for subject_embedding_id, content_embedding_id,
-- metadata_terms_text, section_path_text, aliases_text have already been applied
-- to the remote database. New databases get these columns from the CREATE TABLE statement.
