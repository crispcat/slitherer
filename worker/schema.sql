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
  id TEXT PRIMARY KEY,
  source_node_id TEXT NOT NULL,
  type TEXT NOT NULL,          -- Rule, Attribute, Skill, Trait, Ability, Action, StatusEffect, Item, Spell, Example, Situation, Modifier, Definition, Equipment, Weapon, Formula, Table
  name TEXT,
  page INTEGER,
  section TEXT NOT NULL,       -- JSON array section path
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  metadata_json TEXT,          -- raw Phase 4 extraction output (defines/references/requires/exceptions/modifies/modified_by/keywords/aliases)
  parent_unit_id TEXT,         -- primary parent (row tree: section/header)
  secondary_parent_unit_id TEXT, -- secondary parent (column tree: column header)
  source_order INTEGER NOT NULL DEFAULT 0, -- position of this unit within its source structure node (for adjacency relations)
  embedding_id TEXT,           -- Vectorize vector id
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> summary_done -> metadata_done -> relations_done -> done
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_unit_id) REFERENCES semantic_units(id),
  FOREIGN KEY (secondary_parent_unit_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_semantic_units_source_node ON semantic_units(source_node_id);
CREATE INDEX IF NOT EXISTS idx_semantic_units_status ON semantic_units(status);
CREATE INDEX IF NOT EXISTS idx_semantic_units_hash ON semantic_units(content_hash);
CREATE INDEX IF NOT EXISTS idx_semantic_units_secondary_parent ON semantic_units(secondary_parent_unit_id);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  aliases TEXT -- JSON array
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_concepts_name ON concepts(name);

CREATE TABLE IF NOT EXISTS concept_unit (
  concept_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  PRIMARY KEY (concept_id, unit_id),
  FOREIGN KEY (concept_id) REFERENCES concepts(id),
  FOREIGN KEY (unit_id) REFERENCES semantic_units(id)
);

CREATE TABLE IF NOT EXISTS keywords (
  unit_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (unit_id, keyword),
  FOREIGN KEY (unit_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL, -- defines, references, requires, excepts, modifies, modified_by, overrides, related_to, incompatible_with, creates, consumes, supersedes, example_of
  confidence REAL NOT NULL,
  FOREIGN KEY (source_id) REFERENCES semantic_units(id),
  FOREIGN KEY (target_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  phase TEXT NOT NULL,   -- units|summary|metadata|relations|done
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
