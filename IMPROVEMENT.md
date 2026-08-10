# RAG Retrieval Improvement Plan — Implementation Analysis

**Scope: Single-document for v1.** The system ingests and queries one document at a time. The `document_id` columns exist in the schema for future multi-document support, but retrieval does not filter by document. Multi-document design is out of scope for this plan.

## Priority Order

**Ingestion consolidation (do first):**

1. **Fix alias timing + redesign embeddings**
2. **Build FTS5 lexical index**
3. **Remove relations pipeline + build concept/mechanic layer + add table unit types**

**Retrieval redesign (after ingestion is consolidated):**

4. **Add hybrid lexical + semantic retrieval**
5. **Redesign candidate expansion and provenance**
6. **Improve reranking and multi-query aggregation**
7. **Evidence selection + hierarchical context reconstruction**
8. **Preserve original and translated queries**
9. **Improve the sufficiency loop**
10. **Add retrieval diagnostics**
11. **Optimize after correctness**

---

# Part I — Ingestion Consolidation

---

# Phase 1 — Fix Alias Timing + Redesign Embeddings

**Priority: P0 — highest-impact architectural change.**

## Current state

- **Ingestion order** (`worker/src/pipeline/ingest.ts`): vision → summary (+ embed) → metadata → relations
- The summary phase (`stepSummaryPhase`, line 329) generates a summary AND immediately embeds + upserts to Vectorize (lines 337-338)
- The metadata phase (`stepMetadataPhase`, line 347) extracts aliases but does **not** re-embed
- **Result**: embeddings are generated before aliases are available — the embedding never contains aliases
- **Single Vectorize index** (`slitherer-rag-units`) with one embedding per unit
- Embedding text (`buildEnrichedDocument` in `worker/src/pipeline/embeddings.ts`): `Name + Summary + Aliases + Content` (when fits budget). Hierarchy is intentionally excluded (see comment lines 22-30)
- Vectorize metadata: only `{ name }` (line 70-72 in `embeddings.ts`)

## What needs to change

### 1.1 Move embedding after metadata

Change the ingestion pipeline order to:

```text
Vision extraction
    ↓
Summary generation       (no embedding yet)
    ↓
Metadata + aliases
    ↓
Subject embedding         (new)
    ↓
Content embedding         (new)
    ↓
Concept extraction       (new — replaces relationship construction)
```

**Files to modify:**
- `worker/src/pipeline/ingest.ts` — split `stepSummaryPhase` to not embed; add embedding to `stepMetadataPhase` or create a new `stepEmbeddingPhase`
- `worker/schema.sql` — add `subject_embedding_id` and `content_embedding_id` columns to `semantic_units` (ALTER TABLE or drop+recreate)
- `worker/src/types.ts` — update `SemanticUnit` interface with new embedding ID fields
- `config/ingestion.yaml` — update phase descriptions and batch sizes

**Status flow change:** The `status` field currently goes `pending → summary_done → metadata_done → relations_done → done`. Change to `pending → summary_done → metadata_done → embedding_done → concepts_done → done`. The `relations_done` status is replaced by `embedding_done` and `concepts_done`.

**Failure handling:** Metadata extraction is a critical ingestion step — aliases and metadata fields feed into both the embedding text and the FTS5 index. If metadata extraction fails, do not silently skip it. Instead:
- Mark the unit's metadata status as `failed`
- Invoke retry logic (configurable max retries, e.g. 3 attempts with backoff)
- If all retries fail, halt the pipeline for that unit and log the error for manual review
- Do not generate embeddings or proceed to concept extraction for units with failed metadata — the embeddings would be missing aliases, and concept extraction depends on metadata fields

This is a heavy ingestion pipeline; every failed metadata generation should be treated as an error that blocks downstream phases, not silently degraded.

### 1.2 Split into two Vectorize indexes

Create two separate Vectorize indexes:

- `slitherer-rag-subjects` — subject embeddings (semantic subject discovery for units)
- `slitherer-rag-content` — content embeddings (exact rule retrieval for units)

**Files to modify:**
- `worker/wrangler.toml` — add two `[[vectorize]]` bindings:
  ```toml
  [[vectorize]]
  binding = "VECTORIZE_SUBJECTS"
  index_name = "slitherer-rag-subjects"

  [[vectorize]]
  binding = "VECTORIZE_CONTENT"
  index_name = "slitherer-rag-content"
  ```
- `worker/src/types.ts` — replace `VECTORIZE_INDEX: VectorizeIndex` with `VECTORIZE_SUBJECTS: VectorizeIndex` and `VECTORIZE_CONTENT: VectorizeIndex`
- Create the indexes: `npx wrangler vectorize create slitherer-rag-subjects --dimensions 1024 --metric cosine` and same for content

### 1.3 Subject embedding text

Built from:

```text
Document: <document name>
Path: <section path prepended with semantic tree path through all parents, ending at unit name>
Name: <unit name>
Summary: <summary>
Aliases: <aliases>
```

The **Path** field is a single uniform string formed by prepending the section path (from the `section` array) with the semantic tree path (constructed by walking `parentUnitId` up to the root), joining all names with ` > `, and ending with the unit's own name. This merges both the document section structure and the semantic unit hierarchy into the embedding. The document name is a separate field above it.

Do **not** include full content.

**New function:** `buildSubjectDocument(unit, documentName, parentPath)` in `embeddings.ts`

### 1.4 Content embedding text

Built from:

```text
Document: <document name>
Path: <section path prepended with semantic tree path through all parents, ending at unit name>
Name: <unit name>
Summary: <summary>
Aliases: <aliases>

Content:
<full unit content>
```

If content exceeds the embedding token budget, truncate only the content portion while preserving path, name, summary, aliases. Never fall back to summary-only because content is long.

**New function:** `buildContentDocument(unit, documentName, parentPath)` in `embeddings.ts`

### 1.5 Vectorize metadata — compact JSON blob

Store all metadata fields as a single compact JSON string in one Vectorize metadata key to stay within the 1KB per-vector limit:

```json
{
  "id": "RULE-abc123...",
  "meta": "{\"unit_id\":\"RULE-abc123\",\"document_id\":\"doc1\",\"type\":\"Rule\",\"name\":\"Recovery\",\"section_path\":\"Combat>Conditions>Stunned\",\"parent_unit_id\":\"RULE-parent\",\"page\":7,\"source_order\":3,\"content_hash\":\"sha256...\"}"
}
```

This avoids hitting the metadata key count/size limits while keeping all fields available for future pre-filtering (e.g. filtering by `document_id` or `type` directly from Vectorize results before fetching D1). The current pipeline always fetches full units from D1 after vector search, so this metadata is not used today — it enables future optimization where certain queries can skip or reduce D1 fetches.

**Files to modify:**
- `worker/src/pipeline/embeddings.ts` — new `upsertSubjectEmbeddings` and `upsertContentEmbeddings` functions, replace `upsertEmbeddings`

### 1.6 Keep D1 as authoritative source

Keep `content`, `summary`, `metadata_json`, and the complete hierarchy in D1 as the authoritative source. Vectorize is only for discovery.

### 1.7 Backfill / migration

Existing embeddings in the old `slitherer-rag-units` index must be re-generated. Run `--stage summary` (or a new `--stage embedding` stage) after deploying the code changes to re-embed all units into the two new indexes.

---

# Phase 2 — Build FTS5 Lexical Index

**Priority: P0 — ingestion-side index creation.**

## Current state

- D1 schema has no FTS5 tables
- No lexical search index exists
- `semantic_units` table has no `metadata_terms_text` or `section_path_text` columns

## What needs to change

### 2.1 Add metadata_terms_text column

Add a new D1 column on `semantic_units`:

```sql
ALTER TABLE semantic_units ADD COLUMN metadata_terms_text TEXT;
```

Computed during the metadata phase by flattening all metadata arrays (defines, references, requires, exceptions, modifies, modified_by, overrides, related_to, incompatible_with, creates, consumes, supersedes, example_of, part_of) into a single space-joined text string.

**Files to modify:**
- `worker/schema.sql` — add `metadata_terms_text` column to `semantic_units`
- `worker/src/pipeline/metadata.ts` — compute `metadataTermsText` from extracted metadata and store it
- `worker/src/types.ts` — add `metadataTermsText` to `SemanticUnit` interface

### 2.2 Add integer primary key to semantic_units

The `semantic_units` table currently uses `id TEXT PRIMARY KEY`. FTS5 external content tables need a stable integer rowid for `content_rowid` mapping. SQLite's implicit rowid on tables with a non-integer primary key is unstable (can change on VACUUM).

Add an explicit `INTEGER PRIMARY KEY` column and change `id` to `UNIQUE NOT NULL`:

```sql
-- New table schema (drop + recreate since ALTER TABLE can't change PRIMARY KEY):
CREATE TABLE IF NOT EXISTS semantic_units (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  document_id TEXT,
  source_node_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- Rule, DataTableHeader, DataTableRow, ColumnListTable, ColumnListItem, Image
  name TEXT,
  page INTEGER,
  section TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  summary TEXT,
  metadata_json TEXT,
  metadata_terms_text TEXT,       -- new (Phase 2.1)
  parent_unit_id TEXT,
  source_order INTEGER NOT NULL DEFAULT 0,
  subject_embedding_id TEXT,      -- new (Phase 1)
  content_embedding_id TEXT,      -- new (Phase 1)
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_unit_id) REFERENCES semantic_units(id)
);
```

The `id TEXT` column remains the application-level identifier — all existing code that references `id` continues to work unchanged. The `rowid` column is auto-assigned, stable (survives VACUUM), and used only for FTS5 content mapping.

**Migration:** Since `ALTER TABLE` cannot change the primary key, this requires dropping and recreating the `semantic_units` table. Re-ingest after schema migration.

**Files to modify:**
- `worker/schema.sql` — update `semantic_units` table definition
- `worker/src/types.ts` — add `rowid?: number` to `SemanticUnit` interface (optional, only needed for FTS sync)
- `worker/src/utils/db.ts` — update `rowToUnit` to include `rowid`, update `upsertSemanticUnit` if needed

### 2.3 Create FTS5 external content table

Use an **external content FTS5 table** with `content_rowid='rowid'`. FTS5 stores only the inverted index and references the base table rows via the stable integer rowid. The base table (`semantic_units`) remains the source of truth for all text.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS semantic_unit_search USING fts5(
  name,
  aliases,
  summary,
  content,
  section_path_text,
  metadata_terms_text,
  content='semantic_units',
  content_rowid='rowid'
);
```

**`section_path_text`**: the section array joined with ` > `. Computed from the existing `section` field. Not stored as a column on `semantic_units` — it's a virtual field computed at FTS index time. To make this work with an external content table, either:
- Add a `section_path_text` column to `semantic_units` (computed when the unit is stored), or
- Create a **view** that includes `section_path_text` as a computed column and point `content` to the view instead.

Recommended: add `section_path_text TEXT` as a real column on `semantic_units`, computed from the `section` array on insert/update. This keeps the FTS sync simple.

**Files to modify:**
- `worker/schema.sql` — add `section_path_text` column to `semantic_units`, add FTS5 virtual table

### 2.4 Keep FTS index in sync with triggers

External content FTS5 tables do not automatically sync with the base table. Use D1 triggers to keep the FTS index updated atomically with any base table modification:

```sql
-- After INSERT: add new row to FTS index
CREATE TRIGGER semantic_units_ai AFTER INSERT ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(rowid, name, aliases, summary, content, section_path_text, metadata_terms_text)
  VALUES (new.rowid, new.name, '', new.summary, new.content, new.section_path_text, new.metadata_terms_text);
END;

-- After DELETE: remove from FTS index
CREATE TRIGGER semantic_units_ad AFTER DELETE ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(semantic_unit_search, rowid, name, aliases, summary, content, section_path_text, metadata_terms_text)
  VALUES ('delete', old.rowid, old.name, '', old.summary, old.content, old.section_path_text, old.metadata_terms_text);
END;

-- After UPDATE: remove old + insert new
CREATE TRIGGER semantic_units_au AFTER UPDATE ON semantic_units BEGIN
  INSERT INTO semantic_unit_search(semantic_unit_search, rowid, name, aliases, summary, content, section_path_text, metadata_terms_text)
  VALUES ('delete', old.rowid, old.name, '', old.summary, old.content, old.section_path_text, old.metadata_terms_text);
  INSERT INTO semantic_unit_search(rowid, name, aliases, summary, content, section_path_text, metadata_terms_text)
  VALUES (new.rowid, new.name, '', new.summary, new.content, new.section_path_text, new.metadata_terms_text);
END;
```

**Note on `aliases`:** The `aliases` field comes from `metadata_json` (parsed). It's not a top-level column on `semantic_units`. Options:
- Add an `aliases_text TEXT` column to `semantic_units`, computed from `metadata_json.aliases` during metadata extraction
- Or exclude `aliases` from the FTS index and rely on `metadata_terms_text` (which already includes aliases as part of the flattened metadata)

Recommended: add `aliases_text TEXT` column, computed during the metadata phase, so the FTS trigger can reference it directly.

**Files to modify:**
- `worker/schema.sql` — add `aliases_text` column to `semantic_units`, add FTS5 triggers
- `worker/src/utils/db.ts` — update `upsertSemanticUnit` to populate `section_path_text`, `aliases_text`, `metadata_terms_text`
- `worker/src/pipeline/metadata.ts` — compute `aliasesText` and `metadataTermsText` from extracted metadata
- `worker/src/pipeline/ingest.ts` — compute `sectionPathText` from section array on unit storage

---

# Phase 3 — Remove Relations Pipeline + Build Concept Layer

**Priority: P0 — final ingestion consolidation step.**

## Current state

- `worker/src/pipeline/relationships.ts`: for each metadata term, embeds the bare term, queries Vectorize, takes top-K matches. Confidence = cosine similarity. No LLM validation.
- `relations` table schema: `id, source_id, target_id, relation_type, confidence`
- `Relation` type in `types.ts`: `id, source, target, relation_type, confidence`
- Relation types: defines, references, requires, excepts, modifies, modified_by, overrides, related_to, incompatible_with, creates, consumes, supersedes, example_of, part_of, parent_of, child_of
- No concept tables exist in D1
- No concept extraction in the ingestion pipeline
- Current unit types: `Rule`, `Table`, `Image` (in `SEMANTIC_UNIT_TYPES` in `types.ts`)
- Vision prompt (`config/ingestion.yaml`) distinguishes data tables from independent column lists but uses `Rule` for both — no dedicated types for structural table elements

## What needs to change

### 3.1 New unit types for table structures

Add four new unit types to `SEMANTIC_UNIT_TYPES`:

```typescript
export const SEMANTIC_UNIT_TYPES = [
  "Rule",
  "Table",
  "Image",
  "DataTableHeader",   // header row of a true data table (columns describe properties of the same entity)
  "DataTableRow",       // data row in a data table (one entity per row)
  "ColumnListTable",    // structural table where each column is an independent list of unrelated items
  "ColumnListItem",     // an item within a column list table
] as const;
```

**Type definitions:**

- **`DataTableHeader`** — the header of a true data table where rows have a meaningful relationship across columns (e.g. a weapon table: name | damage | type | weight). Each row is one entity described by its columns. Only use for simple tables with headers and data columns.
- **`DataTableRow`** — a single data row in a `DataTableHeader` table. One entity per row, with properties across columns.
- **`ColumnListTable`** — a structural layout where each column represents an independent list of items that are NOT related to each other across columns (e.g. "Weapons" in one column and "Spells" in another, or "Advantages" and "Disadvantages" side by side). Row N on the left has no relationship to row N on the right.
- **`ColumnListItem`** — a single item within a `ColumnListTable`. Each item belongs to one column only.

**Replace the old `Table` type:** The existing `Table` type is replaced by `DataTableHeader` and `ColumnListTable`. Existing `Table` units should be reclassified during re-ingestion. `Image` stays unchanged.

### 3.2 Update vision model prompt

Update the vision extraction prompt in `config/ingestion.yaml` to detect the new types:

```text
UNIT TYPES (7 types):
- "Rule" — any retrievable piece of rules content. The default for ALL non-table content: abilities, spells, weapons, traits, actions, definitions, modifiers, examples, category labels, etc.
- "DataTableHeader" — header of a true data table where each row is one entity and columns describe its properties (e.g. weapon table: name | damage | type | weight). Only use for simple tables with headers and data columns.
- "DataTableRow" — a single data row in a DataTableHeader. One entity per row.
- "ColumnListTable" — a structural layout where each column is an independent list of unrelated items (e.g. "Weapons" in one column, "Spells" in another; or "Advantages" and "Disadvantages" side by side). Row N on the left has NO relationship to row N on the right.
- "ColumnListItem" — a single item within a ColumnListTable. Each item belongs to one column only.
- "Image" — a visual element that carries rules information.
```

Update the extraction rules in the prompt:
- For data tables: the header is a `DataTableHeader` unit, each row is a `DataTableRow` child
- For independent column lists: the container is a `ColumnListTable` unit, each item is a `ColumnListItem` child
- Do NOT use `DataTableHeader` for complex nested tables or tables without clear headers

### 3.3 Deterministic type-checking rules

After vision extraction, apply deterministic checks to enforce type consistency:

1. **If a unit is `DataTableHeader`** → all its children must be `DataTableRow`. If any child has a different type, reclassify it to `DataTableRow`.
2. **If a unit is `ColumnListTable`** → all its children must be `ColumnListItem`. If any child has a different type, reclassify it to `ColumnListItem`.
3. **If a unit is `DataTableRow`** → its parent must be `DataTableHeader`. If the parent has a different type, reclassify the parent to `DataTableHeader`.
4. **If a unit is `ColumnListItem`** → its parent must be `ColumnListTable`. If the parent has a different type, reclassify the parent to `ColumnListTable`.

These checks run after vision extraction and before the summary phase, as part of the unit validation step in `worker/src/pipeline/units.ts`.

**Files to modify:**
- `worker/src/types.ts` — add new types to `SEMANTIC_UNIT_TYPES`
- `config/ingestion.yaml` — update vision prompt with new type definitions and extraction rules
- `worker/src/pipeline/units.ts` — add deterministic type-checking function, run after vision extraction
- `worker/src/pipeline/ingest.ts` — call type-checking after vision phase

### 3.4 Remove relations pipeline

Graph relations are removed entirely. The concept layer (below) replaces them for related-rule discovery. Hierarchy expansion (parent/sibling/child via `parent_unit_id`) is kept — it's deterministic and reliable.

**Files to modify (ingestion side):**
- `worker/src/pipeline/relationships.ts` — delete file (relationship extraction removed)
- `worker/src/pipeline/graph.ts` — delete file (graph population removed)
- `worker/src/pipeline/ingest.ts` — remove `stepRelationsPhase`, remove relations-related imports and logic (including deterministic parent_of/child_of relation insertion, lines 370-385 — these are redundant with `parent_unit_id`)
- `worker/src/types.ts` — remove `Relation`, `RelationType`, `RELATION_TYPES` (keep `UnitMetadata` — it's still used for concept extraction and FTS)
- `worker/src/utils/db.ts` — remove `insertRelation`, `clearRelationsForSource`, `getRelationsForUnits`
- `worker/schema.sql` — drop `relations` table (or keep as deprecated for migration)
- `config/ingestion.yaml` — remove relationship extraction config

**Note:** Removing graph expansion from the retrieval side (`query.ts`) is done in Phase 5 (Redesign Candidate Expansion) as part of the retrieval redesign. The retrieval pipeline continues to work with the old graph expansion code until then, but the relations table will be empty after this phase.

### 3.5 New D1 tables

```sql
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,           -- mechanic, condition, attribute, resource, action, effect, item, characteristic, other
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
  mention_type TEXT NOT NULL,   -- defines, references, requires, exception, modifies, etc.
  confidence REAL NOT NULL,
  resolution_method TEXT NOT NULL,  -- exact_alias, normalized_alias, embedding, llm_validation, manual
  created_at TEXT NOT NULL,
  FOREIGN KEY (concept_id) REFERENCES concepts(id),
  FOREIGN KEY (unit_id) REFERENCES semantic_units(id)
);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_concept ON concept_mentions(concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_mentions_unit ON concept_mentions(unit_id);
```

Concepts are **document-scoped** — each document has its own concept set. (Note: the system is single-document for v1 — multi-document support is out of scope. The `document_id` columns exist in the schema for future use, but retrieval does not filter by document.)

### 3.6 New ingestion phase

Pipeline becomes: vision → summary → metadata → embedding → **concepts** → done

The previous `relations` phase is removed. Concept extraction replaces it as the final ingestion phase. Add `concepts` to `IngestPhase` and `INGEST_STAGES` in `worker/src/pipeline/ingest.ts`. Remove `relations` from both.

### 3.7 Concept extraction pipeline

For each unit with metadata, extract raw concept mentions from metadata fields (defines, references, requires, exceptions, modifies, modified_by, overrides, related_to, incompatible_with, creates, consumes, supersedes, example_of, part_of, aliases). Each mention preserves the raw term, the unit it appeared in, and the mention type.

### 3.8 Concept type assignment

Each concept has a generic `type` from this set:

```text
mechanic, condition, attribute, resource, action, effect, item, characteristic, other
```

When a new concept is created, its type is assigned by an LLM call that receives the raw term, the unit content where it was first mentioned, and the metadata field it came from. The LLM picks the most appropriate generic category. Avoid hard-coded domain vocabulary beyond these categories.

When a mention resolves to an existing concept, the concept's existing type is used as a matching signal — a mention whose inferred type matches the candidate concept's type ranks higher. Type is not an absolute constraint because extraction can occasionally classify a mention incorrectly.

### 3.9 Concept normalization (resolution pipeline)

```text
raw mention
    ↓
deterministic normalization (lowercase, whitespace, Unicode, hyphenation, lemmatization for Russian)
    ↓
exact alias lookup (concept_aliases table, normalized_alias match)
    ↓ [if no match]
concept embedding search (top 5-10 from concept Vectorize index)
    ↓
contextual + type validation (compare mention type with candidate concept type)
    ↓ [if ambiguous]
LLM validation (only for medium-similarity ambiguous matches)
    ↓
existing concept OR new concept
```

**Resolution methods** (stored in `concept_mentions.resolution_method`):
- `exact_alias` — normalized term matches an existing alias (highest confidence)
- `normalized_alias` — normalized term with matching type matches an existing alias
- `embedding` — very high embedding similarity + matching type (auto-resolve)
- `llm_validation` — medium similarity, LLM confirms the match
- `manual` — manual correction

**Alias creation is reactive**: aliases are only added when a new mention resolves to an existing concept. On first appearance, a concept is created with itself as its only alias (e.g. concept "Оглушение" with alias "Оглушение"). When a later mention like "оглушён" resolves to that concept via embedding search + validation, "оглушён" is added as a new alias. Aliases accumulate across the document as more mentions are encountered and resolved. No proactive alias generation — the system learns aliases as it sees them.

**Canonical name**: preferably from the authoritative terminology used by the document. If the rulebook consistently calls the mechanic "Оглушение", use that as the canonical name. Other-language forms become aliases. The LLM should not invent a canonical name when an authoritative name exists.

**New files:**
- `worker/src/pipeline/concepts.ts` — concept extraction, normalization, description generation, embedding

### 3.10 Concept description generation

After all concepts are resolved and merged:

1. For each concept, collect the most informative associated units:
   - Units that `define` the concept
   - Units that introduce or explain it
   - Units describing its mechanics
   - Units that modify or constrain it
   - Important exceptions
   - A few representative examples

2. Give these units to an LLM and ask it to produce a short (1-3 sentence) canonical, self-contained description.

3. Store `source_unit_ids` (which units were used) so the description can be regenerated when those units change.

4. The description is a **retrieval representation**, not authoritative evidence. The actual semantic units remain the source of truth for answering questions.

### 3.11 Concept embedding

Third Vectorize index:

```toml
[[vectorize]]
binding = "VECTORIZE_CONCEPTS_IDX"
index_name = "slitherer-rag-concepts-idx"
```

Built from:

```text
Canonical name
Aliases
Type
Description
```

Do not include all units mentioning the concept.

### 3.12 Debug viewer integration

The debug tree viewer (`pages/debug/index.html`) and its API endpoints (`/debug/*` in `worker/src/index.ts`) must be updated to support concepts and remove the old relations UI.

**Replace relations with concepts in the unit side panel:**

The current side panel (`/debug/unit/:id` → `getUnitDetails` in `db.ts`) shows "Relations (Outgoing)" and "Relations (Incoming)" sections. Replace these with a "Concepts" section showing:
- Concept canonical name (clickable → opens concept detail view)
- Concept type
- Mention type (defines, references, requires, etc.)
- Resolution method (exact_alias, embedding, llm_validation, etc.)
- Confidence

**New concept browser view:**

Add a concept list panel to the debug viewer (similar to the source node dropdown). Shows all concepts for the document with:
- Canonical name
- Type
- Alias count
- Mention count

Clicking a concept opens a concept detail side panel showing:
- Canonical name, type, description
- All aliases (with language and source)
- All mentions (unit ID, raw term, mention type, resolution method, confidence)
- Source unit IDs used for description generation

**New debug API endpoints:**

```text
GET /debug/concepts?documentId=<id>     — list all concepts for a document
GET /debug/concept/:id                  — concept details: aliases, mentions, description, source units
GET /debug/unit/:id/concepts            — concepts linked to a specific unit (replaces relations in side panel)
```

**Remove from debug viewer:**
- Relations sections in the unit side panel (outgoing/incoming)
- `getUnitDetails` in `db.ts` — remove relations query, add concept mentions query
- Any graph/relation-related UI elements in `pages/debug/index.html`

**Files to modify:**
- `worker/schema.sql` — add three new tables, drop relations table
- `worker/src/types.ts` — add `Concept`, `ConceptAlias`, `ConceptMention` interfaces; remove `Relation`, `RelationType`, `RELATION_TYPES`
- `worker/src/pipeline/ingest.ts` — add `concepts` phase, remove `relations` phase
- `worker/src/pipeline/concepts.ts` — new file, full concept pipeline
- `worker/src/pipeline/relationships.ts` — delete file
- `worker/src/pipeline/graph.ts` — delete file
- `worker/src/utils/db.ts` — CRUD for concept tables, update `getUnitDetails` to replace relations with concept mentions, remove relation DB functions
- `worker/src/index.ts` — add `/debug/concepts`, `/debug/concept/:id`, `/debug/unit/:id/concepts` endpoints; remove relations from `/debug/unit/:id` response
- `pages/debug/index.html` — replace relations UI with concepts UI, add concept browser and concept detail panel
- `worker/wrangler.toml` — add concept Vectorize index binding
- `config/ingestion.yaml` — concept extraction prompts, thresholds, batch sizes; remove relationship extraction config

---

# Part II — Retrieval Redesign

---

# Phase 4 — Hybrid Retrieval

**Priority: P0 — first retrieval redesign step.**

## Current state

- Retrieval (`worker/src/retrieval/query.ts`) is Vectorize-only: `embed(subQuery) → VECTORIZE_INDEX.query(topK=10)` (line 38)
- No lexical search exists (FTS5 index created in Phase 2 but not yet used for retrieval)

## What needs to change

### 4.1 Execute three retrieval searches per sub-query

```text
subject Vectorize search   (VECTORIZE_SUBJECTS.query, topK 10-20)
content Vectorize search   (VECTORIZE_CONTENT.query, topK 10-20)
FTS5 lexical search        (BM25 ranking, topK 10-20)
```

**Files to modify:**
- `worker/src/retrieval/query.ts` — replace `retrieveForSubQuery` to run three searches in parallel, merge by `unit_id`
- `config/retrieval.yaml` — add `subjectTopK`, `contentTopK`, `lexicalTopK` config values

### 4.2 Fuse results with Reciprocal Rank Fusion

```text
RRF(unit) = Σ 1 / (k + rank)
```

with `k = 60` initially. Do not combine raw Vectorize cosine scores with FTS BM25 scores.

The output of fusion is the **candidate discovery set** (seeds for expansion), not the final ranking.

**New function:** `reciprocalRankFuse(results)` in `query.ts`

### 4.3 Config

Add to `config/retrieval.yaml`:

```yaml
retrieval:
  subjectTopK: 15
  contentTopK: 15
  lexicalTopK: 15
  rrfK: 60
```

---

# Phase 5 — Redesign Candidate Expansion

**Priority: P1.**

## Current state

- `retrieveForSubQuery` in `query.ts` (lines 27-123): vector search → parent/sibling/child expansion → graph expansion (2 hops)
- Parent/sibling/child expansion (lines 64-97): fetches ALL siblings and ALL children of every seed — no budget limits, no type awareness
- Graph expansion (lines 99-120): follows all relations from the growing candidate pool (not just seeds) — can explode
- Provenance is partial: `expansionRole` ("seed"|"parent"|"sibling"|"child") and `viaRelation` ("parent_expansion"|"graph_expansion") exist but are not structured

## What needs to change

### 5.1 Remove graph expansion from retrieval

Graph expansion (following typed unit-to-unit relations) is removed from the retrieval pipeline. The concept layer (Phase 3) replaces it for related-rule discovery.

**Files to modify:**
- `worker/src/retrieval/query.ts` — remove graph expansion logic (lines 99-120), remove `getRelationsForUnits` import
- `config/retrieval.yaml` — remove `graphHops`, `relationConfidenceThreshold`

### 5.2 Type-based hierarchy expansion

Hierarchy expansion (parent/sibling/child) is no longer applied to all seeds uniformly. Instead, expansion is **type-driven** — only table-related unit types trigger hierarchy expansion, and the expansion rules differ by type:

| Seed type | Expand parent? | Expand siblings? | Expand children? |
|---|---|---|---|
| `Rule` | No | No | No |
| `DataTableHeader` | Yes (1 parent) | No | Yes (all children — `DataTableRow`s) |
| `DataTableRow` | Yes (1 parent — the `DataTableHeader`) | Yes (all siblings — other rows in the table) | No |
| `ColumnListTable` | Yes (1 parent) | No | Yes (all children — `ColumnListItem`s) |
| `ColumnListItem` | Yes (1 parent — the `ColumnListTable`) | No | Yes (all children, if any) |
| `Image` | No | No | No |

**Rationale:**

- **`Rule` units** (the majority of units): no hierarchy expansion. These units rely on the subject/content vector indexes and concept expansion for finding related rules. Hierarchy expansion for rules would pull in parent sections and sibling rules that are structurally adjacent but often semantically unrelated, flooding the candidate pool with low-value candidates.

- **`DataTableHeader`**: expand all children (the rows) because a table header alone is useless without its data rows. If the header is a hit, the user likely needs the full table. Also expand the parent (e.g. the section containing the table) for context.

- **`DataTableRow`**: expand the parent (the header, which defines what the columns mean) and all siblings (other rows in the same table). A single row without its header is meaningless — you need the column labels. Sibling rows may contain related entries (e.g. other weapons in the same weapon table).

- **`ColumnListTable`**: expand all children (the items in each column). The table itself is just a structural container — the actual content is in the items. Also expand the parent for context.

- **`ColumnListItem`**: expand the parent (the `ColumnListTable`, which provides the column label / category context) and children (if any — items may have sub-items). Do NOT expand siblings — in a column list, items in the same column are independent entries, not related to each other. Sibling expansion would pull in every weapon/spell/advantage in the list, which is what concept expansion and list queries handle better.

- **`Image`**: no hierarchy expansion. Images are self-contained descriptions.

### 5.3 Concept expansion

At query time, search the concept index (`VECTORIZE_CONCEPTS_IDX`) to discover relevant concepts, then expand to all units mentioning those concepts via `concept_mentions` table. This is the `concept` expansion source type in the candidate provenance.

Concept expansion runs for **all seed types** (including `Rule`), since concepts are the primary mechanism for finding related rules across the document. This is especially important because `Rule` units no longer get hierarchy expansion — concept expansion is their main related-rule discovery path.

**Files to modify:**
- `worker/src/retrieval/query.ts` — add concept search + concept expansion, implement type-based hierarchy expansion

### 5.4 Provenance tracking

Every candidate must carry structured provenance tracking how it entered the candidate pool:

```typescript
interface CandidateProvenance {
  sources: {
    type: "vector_subject" | "vector_content" | "lexical" | "parent" | "sibling" | "child" | "concept";
    rank?: number;       // rank in the source search (for direct retrieval)
    score?: number;      // raw score from the source (for direct retrieval)
    subQueryIndex?: number;
    parentUnitId?: string;   // for parent/sibling/child expansion: the seed unit that triggered this expansion
    conceptId?: string;      // for concept expansion: the concept that led to this unit
  }[];
}
```

**Provenance is tracked for all expansion types, not just direct retrieval:**

- **Direct retrieval** (vector_subject, vector_content, lexical): `type` = the search method, `rank` and `score` = the position and score in that search, `subQueryIndex` = which sub-query found it.
- **Parent expansion**: `type: "parent"`, `parentUnitId` = the seed unit whose parent was fetched, `subQueryIndex` = the sub-query that found the seed.
- **Sibling expansion**: `type: "sibling"`, `parentUnitId` = the seed unit whose siblings were fetched (via the seed's parent), `subQueryIndex` = the sub-query that found the seed.
- **Child expansion**: `type: "child"`, `parentUnitId` = the seed unit whose children were fetched, `subQueryIndex` = the sub-query that found the seed.
- **Concept expansion**: `type: "concept"`, `conceptId` = the concept that led to this unit (via `concept_mentions`), `subQueryIndex` = the sub-query that found the concept.

A candidate can have multiple sources — e.g. if it was found by both subject vector search and lexical search, it has two provenance entries. This enables `directHit` and `retrieval_diversity` calculations (Phase 6).

**Example:** Seed unit `RULE-abc` found via subject vector search (rank 3, score 0.82) for sub-query 0 triggers concept expansion to `RULE-xyz` (mentions concept "Stunned"):
```typescript
// RULE-abc provenance:
sources: [{ type: "vector_subject", rank: 3, score: 0.82, subQueryIndex: 0 }]

// RULE-xyz provenance (found via concept expansion):
sources: [{ type: "concept", conceptId: "CONCEPT-stunned", subQueryIndex: 0 }]
```

**Example:** Seed `DataTableRow` found via content vector search triggers parent + sibling expansion:
```typescript
// DataTableRow provenance:
sources: [{ type: "vector_content", rank: 1, score: 0.91, subQueryIndex: 0 }]

// Parent (DataTableHeader) provenance:
sources: [{ type: "parent", parentUnitId: "DTROW-abc", subQueryIndex: 0 }]

// Sibling (another DataTableRow) provenance:
sources: [{ type: "sibling", parentUnitId: "DTROW-abc", subQueryIndex: 0 }]
```

**Files to modify:**
- `worker/src/retrieval/query.ts` — replace `RetrievedUnit` interface, track provenance through all expansion steps

### 5.5 Expansion budgets

Initial limits (configurable in `config/retrieval.yaml`):

```text
direct candidates (top-N seeds from RRF):  20
units per discovered concept:              10
total candidates before rerank (hard cap): 100
```

- **direct candidates** — after RRF fusion, take the top 20 ranked candidates as seeds for expansion. These are the direct retrieval hits.
- **units per discovered concept** — for each concept found via concept search, fetch at most 10 units that mention that concept (via `concept_mentions` table).
- **total candidates before rerank** — hard cap on the overall candidate pool size after all expansion + deduplication.

**Hierarchy expansion has no per-seed budget** — table types expand fully (all children, all siblings) because table rows are only useful as a complete set. The overall `maxCandidatesBeforeRerank` cap still applies as a safety net.

**Key changes from current behavior:**
1. Expansion is performed from **direct retrieval seeds only**, not from the growing candidate pool.
2. Hierarchy expansion is **type-driven** — only table types expand, `Rule` units do not.
3. Concept expansion runs for all seed types and is the primary related-rule discovery mechanism for `Rule` units.
4. Concept expansion fetches units linked to discovered concepts via `concept_mentions`, but never recursively expands from those units.

Apply deduplication immediately when adding candidates.

### 5.6 Config

Add to `config/retrieval.yaml`:

```yaml
expansion:
  directCandidates: 20          # top-N seeds from RRF fusion
  maxUnitsPerConcept: 10        # max units fetched per discovered concept
  maxCandidatesBeforeRerank: 100 # hard cap on total candidate pool
```

**Files to modify:**
- `worker/src/retrieval/query.ts` — rewrite expansion logic with type-based hierarchy expansion, concept expansion, budget enforcement
- `config/retrieval.yaml` — add expansion budget config values

---

# Phase 6 — Improve Reranking

**Priority: P1.**

## Current state

- `retrieve` in `query.ts` (lines 134-200): per-sub-query reranking, keeps **max** rerank score across sub-queries
- `RetrievedUnit` has `rerankScore` (single number) and `sourceSubQueries` (array of indices)
- Rerank threshold is set by the decomposition model (`decomposeResult.rerankThreshold`, constrained 0-1)
- `bge-reranker-base` model used for reranking

## What needs to change

### 6.1 Track all per-query scores

Replace the single `rerankScore` with a scores map:

```typescript
interface RetrievedUnit {
  unit: SemanticUnit;
  scores: {
    [subQueryIndex: number]: number;  // rerank score per sub-query
  };
  maxScore: number;             // highest rerank score across all sub-queries (used in ranking formula)
  meanScore: number;            // average rerank score across sub-queries that found this candidate (raw feature for future calibration)
  queryCoverage: number;       // fraction of sub-queries that found this candidate
  directHit: boolean;          // true if found by direct retrieval (vector/lexical), not expansion
  retrievalDiversity: number;  // 0.5 * method_diversity + 0.5 * query_diversity
  provenance: CandidateProvenance;
  // Raw features for future calibration:
  subjectVectorRank?: number;
  contentVectorRank?: number;
  lexicalRank?: number;
  expansionType?: string;
  conceptId?: string;          // for concept expansion
}
```

### 6.2 directHit

`directHit = true` if the candidate was retrieved directly by the initial retrieval stage (subject-vector, content-vector, or lexical search), before any parent/child/sibling/concept expansion. `directHit = false` for expansion-discovered candidates.

### 6.3 retrieval_diversity

Measures independent evidence from the initial retrieval stage only (not expansion paths):

```text
retrieval_diversity = 0.5 × method_diversity + 0.5 × query_diversity

method_diversity = unique_retrieval_methods_used / total_retrieval_methods (3: subject, content, lexical)
query_diversity  = unique_subqueries_that_found_candidate / total_subqueries
```

### 6.4 Ranking formula

```text
final_score =
    weight_rerank × max_rerank_score
  + weight_coverage × query_coverage
  + weight_direct_hit × directHit
  + weight_diversity × retrieval_diversity
```

All weights are configurable in `config/retrieval.yaml`:

```yaml
ranking:
  weightRerank: 0.70
  weightCoverage: 0.15
  weightDirectHit: 0.10
  weightDiversity: 0.05
```

These weights are initial heuristics — tune empirically against an evaluation dataset.

### 6.5 Remove rerank threshold from decomposer

The decomposition model should decide **what to search for**, not how to rank or filter. Remove `rerank_threshold` from the decomposer's JSON output.

**Change** `DecomposeResult` in `types.ts`: remove `rerankThreshold`.

**Change** `decompose.ts`: remove `rerank_threshold` from schema and output.

**Server-controlled rerank policy** (in `config/retrieval.yaml`):

```yaml
rerank:
  threshold: 0.4
  maxResults: 12
  fallbackTopK: 3   # if nothing passes threshold, keep top few
```

Apply: rerank all candidates → remove below threshold → keep at most `maxResults` → if nothing passes, keep top `fallbackTopK`.

**Files to modify:**
- `worker/src/types.ts` — update `RetrievedUnit`, `DecomposeResult`
- `worker/src/retrieval/query.ts` — per-query score tracking, new ranking formula, server-controlled threshold
- `worker/src/retrieval/decompose.ts` — remove `rerank_threshold` from output
- `worker/src/retrieval/pipeline.ts` — remove `rerankThreshold` passing
- `config/retrieval.yaml` — add `rerank.threshold`, `rerank.maxResults`, `rerank.fallbackTopK`, `ranking.weightRerank`, `ranking.weightCoverage`, `ranking.weightDirectHit`, `ranking.weightDiversity`; remove `defaultRerankThreshold`

---

# Phase 7 — Evidence Selection + Hierarchical Context Reconstruction

**Priority: P1.**

## Current state

- `generateAnswer` in `worker/src/retrieval/answer.ts` (lines 16-59): dumps ALL retrieved units into the answer prompt as evidence
- No evidence selection step — every unit that passes the rerank threshold goes to the answer model
- No hierarchical context reconstruction — the answer prompt has no parent summaries or sibling context
- Evidence format (line 33-34): `[unitId] (type, section, page)\n<content>` — flat list joined with `---`

## What needs to change

### 7.1 Evidence selection (deterministic, no LLM)

After reranking, select evidence using these rules (applied in order):

**1. Sort by final_score**

Start with all candidates that passed the rerank threshold, sorted descending by `final_score`.

**2. Remove near-duplicates**

If two candidates have the same `content_hash`, keep only the higher-scored one. Additionally, if two candidates have very high text overlap (e.g. one is a parent that contains the other's content verbatim), keep only the more specific one (prefer the child over the parent if the child's content is a subset, since the child is more focused). Detect overlap by checking if one unit's `parentUnitId` chain includes the other — if so, the child is more specific and preferred.

**3. Guarantee subquery coverage**

For each sub-query, track whether at least one selected evidence unit was found by that sub-query (check `provenance.sources[].subQueryIndex`). After the initial greedy selection by score, check which sub-queries have no evidence yet. For each uncovered sub-query, take the highest-scored candidate that was found by that sub-query (even if its score is lower than other already-selected candidates) and add it to the evidence set, up to the budget.

This prevents the situation where one sub-query dominates the evidence set with many high-scoring candidates while another sub-query's relevant candidates are excluded because their scores are slightly lower.

**4. Prefer direct retrieval over structural expansion**

When two candidates have comparable `final_score` (within a configurable delta, e.g. 0.05), prefer the one with `directHit = true`. This is implemented as a tiebreaker in the sort: sort by `final_score` descending, then by `directHit` descending (true before false). The `directHit` flag comes from provenance — a candidate is a direct hit if any of its provenance sources has type `vector_subject`, `vector_content`, or `lexical`.

Rationale: direct retrieval candidates matched the query semantically or lexically. Structural expansion candidates (parent/sibling/child) were included because of hierarchy, not because they matched the query. When scores are close, the direct hit is more likely to be relevant.

**5. Preserve complementary rules**

After the initial selection, check the metadata of selected evidence units. If a selected unit has metadata fields that reference other units (e.g. `requires`, `exceptions`, `modifies`), check whether the referenced units are in the candidate pool. If a referenced unit is in the pool but wasn't selected (because its score was below other candidates), add it to the evidence set — up to the budget — because it provides complementary information needed to interpret the selected unit.

Specifically, for each selected unit, look at its `metadata.requires`, `metadata.exceptions`, `metadata.modifies`, and `metadata.modified_by` fields. For each referenced term, check if any candidate unit's name or aliases match. If a matching candidate exists and isn't already selected, add it.

This prevents the situation where the answer model gets a rule about "Stunned" but not the exception that says "immunity to stun for 1 round after recovering," even though the exception was in the candidate pool with a slightly lower score.

**6. Hard evidence budget**

Select 5-10 semantic units initially (configurable in `config/retrieval.yaml`). The budget is a soft target during steps 3-5 (coverage and complementary rules may push slightly over), but never exceed the hard cap. If the budget is exceeded after complementary rule additions, drop the lowest-scored non-coverage-essential candidates first.

```yaml
evidence:
  budget: 8
  maxBudget: 10
  comparableScoreDelta: 0.05  # threshold for directHit tiebreaker
```

**List/enumeration queries:** The decomposer detects list queries (e.g. "list all weapons", "count all conditions", "what traits exist") and sets an `isListQuery: true` flag in `DecomposeResult`. When this flag is set, evidence selection skips the budget cap entirely and includes all candidates that passed the rerank threshold. This ensures enumeration queries get the complete set of matching units rather than a truncated top-10.

Add `isListQuery: boolean` to `DecomposeResult` in `types.ts`. The decomposer prompt should be updated to detect list/enumeration intent — queries that ask to list, count, enumerate, or name all instances of a category.

**New file:** `worker/src/retrieval/evidence.ts` — `selectEvidence(candidates, subQueries, budget, isListQuery)`

### 7.2 Hierarchical context reconstruction

For each selected evidence unit:

1. Fetch its parent
2. Include the parent's **summary** (not full content)
3. Include **sibling names** (not content) — unless a sibling was also selected as evidence, in which case include its content
4. Include children content only when a child was also selected as evidence
5. Preserve source order

**Answer context format:**

```text
[Section path]

[Section summary]

[Relevant unit]
<full content>

[Relevant parent context]
<parent summary, only if needed>

[Related rule]
<only if a sibling/child was also selected as evidence>
```

Do not dump every expanded node into the answer prompt.

**Files to modify:**
- `worker/src/retrieval/evidence.ts` — new file, `selectEvidence` function
- `worker/src/retrieval/answer.ts` — use `selectEvidence`, build hierarchical context instead of flat dump
- `worker/src/retrieval/pipeline.ts` — call evidence selection before answer generation, pass `isListQuery` flag
- `worker/src/retrieval/decompose.ts` — add `isListQuery` detection to decomposer prompt and output
- `worker/src/types.ts` — add `isListQuery: boolean` to `DecomposeResult`
- `worker/src/utils/db.ts` — may need batch parent/sibling fetch functions
- `config/retrieval.yaml` — add `evidence.budget`, `evidence.maxBudget`, `evidence.comparableScoreDelta`, context reconstruction config

### 7.3 Pipeline update

The retrieval pipeline becomes:

```text
candidate discovery
    ↓
expansion
    ↓
reranking
    ↓
evidence selection          ← new
    ↓
context reconstruction     ← new
    ↓
answer model
```

---

# Phase 8 — Preserve Original and Translated Queries

**Priority: P2.**

## Current state

- `route` in `worker/src/retrieval/router.ts` (lines 22-58): translates the query to Russian (`russian_query`), returns `RouterResult` with `russianQuery`
- The pipeline (`pipeline.ts` line 91) passes only `routerResult.russianQuery` to the decomposer
- Retrieval uses only the Russian query for embedding and search
- Original query is passed to `generateAnswer` (line 188) but not used for retrieval

## What needs to change

### 8.1 Preserve both queries

```typescript
interface RouterResult {
  rag: boolean;
  language: string;
  originalQuery: string;      // unchanged
  translatedQuery: string;    // Russian translation
  detectedLanguage: string;
  chatResponse?: string;
}
```

### 8.2 Separate NER step

A separate lightweight LLM call after routing extracts entities from the original query:

```json
{
  "entities": [
    { "text": "КК", "type": "abbreviation", "normalized": "Критический Кейс" },
    { "text": "2d6", "type": "dice_notation", "normalized": "2d6" },
    { "text": "Шило", "type": "proper_noun", "normalized": "Шило" }
  ]
}
```

**New file:** `worker/src/retrieval/entities.ts` — `extractEntities(env, query, language)`

Entities are used to boost lexical search (exact term matching) and concept resolution.

### 8.3 Run retrieval against both queries

For each sub-query, run retrieval against both the original and translated versions. Fuse their results before reranking.

Use the original query especially for:
- Proper nouns
- Abbreviations
- Game terminology
- Numbers
- Dice notation
- Item names
- Acronyms

Translation must never be destructive — the original query is always preserved and searched.

**Files to modify:**
- `worker/src/types.ts` — update `RouterResult`, add `Entity` interface
- `worker/src/retrieval/router.ts` — rename `russianQuery` to `translatedQuery`, keep `originalQuery`
- `worker/src/retrieval/entities.ts` — new file, entity extraction
- `worker/src/retrieval/pipeline.ts` — pass both queries, run entity extraction, pass entities to retrieval
- `worker/src/retrieval/query.ts` — run retrieval against both queries, fuse results
- `worker/src/retrieval/decompose.ts` — accept both queries, decompose the translated query (or both)
- `config/retrieval.yaml` — add entity extraction prompt, NER model config

---

# Phase 9 — Improve the Sufficiency Loop

**Priority: P2.**

## Current state

- `runQuery` in `pipeline.ts` (lines 108-180): up to `MAX_ITERATIONS` (3) iterations of retrieve → sufficiency check → follow-up
- `checkSufficiency` in `sufficiency.ts`: LLM evaluates if evidence is sufficient, generates follow-up queries
- Follow-up queries can be generic ("search more") — no constraint on gap types
- The loop treats all queries the same — a simple lookup and a complex multi-step reasoning query both get the same max iterations and same sufficiency prompt

## What needs to change

### 9.1 Two sufficiency modes

The sufficiency loop must distinguish between two query types:

**Simple lookup queries** (e.g. "what does Stunned do?"):
- First-pass retrieval (Phases 4-7) should be sufficient in most cases
- Sufficiency loop is a safety net — rarely needs to run
- Max 2 iterations (down from current 3)
- If the first pass doesn't find it, one targeted follow-up is enough

**Complex reasoning queries** (e.g. "create a character using the rules", "explain the full combat turn sequence"):
- These require gathering information across many rules through multiple targeted retrieval passes
- The sufficiency loop is the **primary mechanism** for iterative information gathering, not just a safety net
- Max 5 iterations (up from current 3)
- Each iteration: sufficiency check identifies what information is still missing → generates targeted follow-up queries → retrieves the missing pieces → adds to evidence pool → re-checks

The decomposer classifies query complexity and sets a `queryComplexity: "simple" | "complex"` flag in `DecomposeResult`. This flag controls the max iterations and sufficiency prompt behavior.

### 9.2 Categorized gaps + targeted follow-up queries

Update the sufficiency prompt to categorize gaps into explicit types:

```text
missing_exception          — a rule has an exception that wasn't retrieved
missing_prerequisite      — a rule references a prerequisite that wasn't retrieved
missing_interaction       — two rules interact but the interaction rule wasn't retrieved
missing_table_dimension   — a table was found but a needed column/row is missing
missing_definition        — a term is used but its definition wasn't retrieved
contradictory_evidence    — two retrieved rules contradict each other, need a tiebreaker rule
missing_step              — (complex queries) a step in a multi-step process is missing
missing_dependency        — (complex queries) a rule depends on another rule that wasn't retrieved
missing_category_member  — (complex queries) a category should have more members than were retrieved
```

The last three gap types are specifically for complex reasoning queries. For example, "create a character" might produce gaps like:
- `missing_step`: "character creation step 3 (skill selection) rules not found"
- `missing_dependency`: "starting health calculation depends on Constitution attribute rules, not yet retrieved"
- `missing_category_member`: "only 3 of the 6 character classes were found"

Follow-up queries must target the specific gap type. Do not generate generic "search more" queries.

Update `SufficiencyResult`:

```typescript
interface SufficiencyResult {
  sufficient: boolean;
  gaps: {
    type: "missing_exception" | "missing_prerequisite" | "missing_interaction" | 
          "missing_table_dimension" | "missing_definition" | "contradictory_evidence" |
          "missing_step" | "missing_dependency" | "missing_category_member";
    description: string;
    followUpQuery: string;
  }[];
  followUpQueries: string[];  // extracted from gaps
}
```

### 9.3 Evidence accumulation across iterations

For complex reasoning queries, evidence from previous iterations must be **accumulated**, not replaced. Each follow-up retrieval pass adds to the evidence pool:

```text
Iteration 1: initial retrieval → evidence set A
    ↓ sufficiency check: gaps identified
Iteration 2: targeted follow-up queries → evidence set B
    ↓ merge: A ∪ B → re-rerank → re-select evidence
    ↓ sufficiency check: gaps identified
Iteration 3: targeted follow-up queries → evidence set C
    ↓ merge: A ∪ B ∪ C → re-rerank → re-select evidence
    ↓ sufficiency check: sufficient
```

The evidence pool grows with each iteration. Reranking and evidence selection (Phase 6-7) re-run on the accumulated pool to ensure the best evidence is selected. The evidence budget still applies per iteration — the pool grows but the final evidence selection respects the budget (unless `isListQuery` is set).

### 9.4 Config

```yaml
sufficiency:
  simpleMaxIterations: 2
  complexMaxIterations: 5
  gapTypes:
    simple: [missing_exception, missing_prerequisite, missing_interaction, missing_table_dimension, missing_definition, contradictory_evidence]
    complex: [missing_exception, missing_prerequisite, missing_interaction, missing_table_dimension, missing_definition, contradictory_evidence, missing_step, missing_dependency, missing_category_member]
```

**Files to modify:**
- `worker/src/types.ts` — update `SufficiencyResult` with gap types, add `queryComplexity` to `DecomposeResult`
- `worker/src/retrieval/sufficiency.ts` — update prompt with two modes (simple/complex), parse categorized gaps
- `worker/src/retrieval/pipeline.ts` — use gap types for targeted follow-up, accumulate evidence across iterations, use `queryComplexity` to set max iterations
- `worker/src/retrieval/decompose.ts` — add `queryComplexity: "simple" | "complex"` classification to decomposer prompt and output
- `config/retrieval.yaml` — add sufficiency config (max iterations per mode, gap types per mode), update sufficiency prompts for both modes

---

# Phase 10 — Add Retrieval Diagnostics

**Priority: P2.**

## Current state

- `query_logs` table: `id, conversation_id, step, input, output, duration_ms, created_at`
- Each pipeline step logs its input/output as JSON
- No per-candidate diagnostic data — can't answer "why did this rule appear?" or "why did the correct rule not appear?"

## What needs to change

### 10.1 New `candidate_logs` table

```sql
CREATE TABLE IF NOT EXISTS candidate_logs (
  id TEXT PRIMARY KEY,
  query_log_id TEXT NOT NULL,         -- FK to query_logs retrieve step
  unit_id TEXT NOT NULL,
  sub_query_id INTEGER,

  subject_vector_rank INTEGER,
  subject_vector_score REAL,

  content_vector_rank INTEGER,
  content_vector_score REAL,

  lexical_rank INTEGER,
  lexical_score REAL,

  rrf_score REAL,

  expansion_source TEXT,              -- vector_subject, vector_content, lexical, parent, sibling, child, concept
  expansion_parent_id TEXT,
  expansion_concept_id TEXT,

  rerank_score REAL,
  final_score REAL,

  selected_for_context INTEGER DEFAULT 0,  -- boolean: was this selected as evidence?

  created_at TEXT NOT NULL,
  FOREIGN KEY (query_log_id) REFERENCES query_logs(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_logs_query ON candidate_logs(query_log_id);
CREATE INDEX IF NOT EXISTS idx_candidate_logs_unit ON candidate_logs(unit_id);
```

### 10.2 Summary in query_logs

Keep a summary count in the existing `query_logs` `output` for the retrieve step (e.g. `{ count: 15, selected: 8, bySource: { vector_content: 5, lexical: 3, ... } }`) for quick inspection.

### 10.3 Logging integration

Log every candidate at every stage of the retrieval pipeline. This makes it possible to answer:
- "Why did this rule appear?" — trace the expansion path
- "Why did the correct rule not appear?" — check if it was found but filtered, or never found

**Debug viewer integration:**

Add a query diagnostics view to the debug viewer that shows, for a given query log entry:
- All candidates with their per-stage scores (subject vector rank/score, content vector rank/score, lexical rank/score, RRF score)
- Expansion source and path for each candidate
- Rerank score and final score
- Whether the candidate was selected for context (highlighted)

New debug API endpoint:
```text
GET /debug/query/:queryLogId/candidates  — all candidate logs for a query, with unit names
```

**Files to modify:**
- `worker/schema.sql` — add `candidate_logs` table
- `worker/src/types.ts` — add `CandidateLog` interface
- `worker/src/utils/db.ts` — add `insertCandidateLog`, `insertCandidateLogs` (batch), `getCandidatesForQuery`
- `worker/src/retrieval/query.ts` — log candidates at each stage
- `worker/src/retrieval/pipeline.ts` — log evidence selection results
- `worker/src/index.ts` — add `/debug/query/:queryLogId/candidates` endpoint
- `pages/debug/index.html` — add query diagnostics view showing candidate scores and selection status

---

# Phase 11 — Optimize After Correctness

**Priority: P3.**

## Current state

- No caching of any kind (embeddings, reranker results, concept resolution)
- Embedding requests are batched per sub-query but not cached across queries
- D1 hierarchy reads are one-at-a-time (`getParentOfUnit`, `getChildrenOfUnit` per unit)

## What needs to change

Only after retrieval quality is acceptable:

- **Cache query embeddings** — same query → same embedding, avoid re-computing
- **Cache concept resolution** — same term → same concept, avoid re-searching
- **Cache reranker results** — identical (query, unit) pair → same score
- **Batch embedding requests** — combine multiple sub-queries into one embed call
- **Batch D1 hierarchy reads** — fetch parents/siblings/children for multiple table-type seeds in one query instead of N queries (hierarchy expansion is now type-driven, so only table-type seeds trigger these reads)
- **Avoid retrieving the same parent multiple times** — deduplicate parent fetches across seeds
- **Keep direct retrieval candidates separate from expanded candidates** — allows different processing pipelines
- **Reduce LLM calls** where evaluation shows no quality improvement

Do not optimize latency by removing retrieval stages before measuring their contribution.

**Files to modify:**
- `worker/src/retrieval/query.ts` — batch hierarchy reads
- `worker/src/utils/db.ts` — add batch parent/sibling fetch functions (`getParentsOfUnits`, `getChildrenOfUnits`)
- `worker/src/utils/cache.ts` — new file, simple in-memory or KV-based cache
- `config/retrieval.yaml` — cache TTL config, batch sizes

---

# Target Architecture

## Ingestion pipeline (Phases 1-3)

```text
PDF document
    │
    ▼
Vision extraction (page images → semantic units)
    │
    ▼
Summary generation (no embedding yet)
    │
    ▼
Metadata + aliases extraction
    │
    ├──→ metadata_terms_text (for FTS5 index)
    │
    ▼
Subject embedding → VECTORIZE_SUBJECTS
Content embedding → VECTORIZE_CONTENT
FTS5 index update → semantic_unit_search
    │
    ▼
Concept extraction
    ├──→ concept mentions (raw terms from metadata)
    ├──→ concept normalization (alias lookup → embedding search → LLM validation)
    ├──→ concept descriptions (LLM-generated from associated units)
    ├──→ concept embeddings → VECTORIZE_CONCEPTS_IDX
    └──→ concept_aliases (reactive, accumulated as mentions resolve)
    │
    ▼
Done
```

## Retrieval pipeline (Phases 4-11)

```text
                         USER QUERY
                             │
                    ┌────────┴────────┐
                    │                 │
              Original query    Translated query
                    │                 │
              Entity extraction      │
                    │                 │
                    └────────┬────────┘
                             │
                       Decomposition
                             │
                    ┌────────┴────────┐
                    │                 │
              Subject search      Content search
                    │                 │
                    ├────────┐ ┌──────┤
                    │        │ │      │
                    └────────┴─┴──────┘
                             │
                       Lexical FTS
                             │
                             ▼
                       RRF Fusion
                             │
                             ▼
                    Candidate units (seeds)
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       type-based         concept         concept
       hierarchy         search         expansion
       expansion       (index)              │
      (table types)         │              │
              └──────────────┼──────────────┘
                             ▼
                     Candidate pool
                             │
                             ▼
                         Reranker
                             │
                             ▼
                    Evidence selection
                             │
                             ▼
                Hierarchical context
                   reconstruction
                             │
                             ▼
                       Sufficiency
                         │       │
                       enough   gap
                         │       │
                         │   targeted retrieval
                         │       │
                         └───┬───┘
                             ▼
                      Answer generation
                             │
                             ▼
                         Citations
```

## Final storage model

```text
D1
├── documents
├── semantic_units          (+ rowid INTEGER PK, metadata_terms_text, section_path_text, aliases_text, subject_embedding_id, content_embedding_id)
├── concepts                (new)
├── concept_aliases         (new)
├── concept_mentions        (new)
├── ingestion_jobs
├── conversations
├── query_logs
├── candidate_logs          (new)
└── debug_logs

D1 FTS5
└── semantic_unit_search    (new)
    ├── name
    ├── aliases
    ├── summary
    ├── content
    ├── section_path_text
    └── metadata_terms_text

Vectorize
├── slitherer-rag-subjects       (unit subject embeddings)
├── slitherer-rag-content        (unit content embeddings)
└── slitherer-rag-concepts-idx   (concept node embeddings)
```

---

# Implementation Order & Dependencies

```text
─── Ingestion consolidation ───

Phase 1 (embeddings + alias timing)              ← no dependencies
    ↓
Phase 2 (FTS5 lexical index)                     ← depends on Phase 1 (metadata phase computes metadata_terms_text)
    ↓
Phase 3 (remove relations + concept layer)       ← depends on Phase 1 (embeddings + metadata exist)

─── Retrieval redesign ───

Phase 4 (hybrid retrieval)                       ← depends on Phase 1 (two indexes), Phase 2 (FTS5 index)
    ↓
Phase 5 (candidate expansion)                    ← depends on Phase 4 (three search sources), Phase 3 (concept tables + table unit types)
    ↓
Phase 6 (reranking)                              ← depends on Phase 5 (provenance), Phase 4 (three sources)
    ↓
Phase 7 (evidence + context)                     ← depends on Phase 6 (ranked candidates)
    ↓
Phase 8 (original + translated queries)          ← depends on Phase 4 (lexical search for entities)
    ↓
Phase 9 (sufficiency)                            ← depends on Phase 7 (better first-pass retrieval)
    ↓
Phase 10 (diagnostics)                           ← depends on Phase 5 (provenance), Phase 6 (scores)
    ↓
Phase 11 (optimization)                          ← depends on all above
```

All ingestion phases (1-3) must be completed before any retrieval phase (4-11) begins. This ensures the data model is fully consolidated before retrieval logic is redesigned against it.
