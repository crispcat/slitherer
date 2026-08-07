# AI Rulebook Knowledge Engine
## Implementation Plan v1.0 (As-Built)

> This document is the **as-built specification** for the v1.0 MVP. It has been
> updated to reflect what was actually implemented, replacing the original
> design proposal. The original proposal suggested a Go-based stack with seven
> separate workers and a single LLM-driven parsing pass; the as-built system is
> a Python + TypeScript stack on Cloudflare with a deterministic-first parser,
> a hybrid (deterministic + LLM) semantic pipeline, a table double-tree
> unitizer, and a single chunked/resumable Worker. Every phase below describes
> the implemented behavior, inputs, outputs, and key mechanisms.

## Goal

Build a semantic knowledge engine for a single (~200-page) RPG rulebook using
Cloudflare.

Target rulebook `deorim_rules.docx` is stored under `rulebooks/` directory.

This is **not** a traditional chunk-based RAG. The system understands mechanics,
relationships, exceptions, and interactions that are distributed throughout the
document.

The ingestion pipeline performs as much work as possible up front so that
runtime queries are fast, inexpensive, and accurate.

---

# Objectives

The system:

- Understands relationships between mechanics.
- Answers questions requiring information from multiple sections.
- Minimizes hallucinations.
- Always provides citations.
- Is inexpensive to operate.
- Supports incremental document updates.
- Is extensible for future features.

Non-goals (v1):

- MediaWiki generation
- Multi-document support
- Fine-tuning models

---

# Technology Stack

## Cloudflare

- **Workers** — single Worker hosts both ingestion and query endpoints.
- **Workers AI** — LLM extraction, table structure, answer generation,
  embeddings, and reranking.
- **Vectorize** — semantic unit embeddings (cosine, 1024-dim).
- **D1** — knowledge graph, structure tree, ingestion jobs.
- **R2** — original structure.json, per-job structure snapshots.

## Implementation languages

- **Python** (`parser/`) — Phases 1-2. Deterministic, no AI/LLM. Runs locally.
- **TypeScript** (`worker/`) — Phases 3-9. Runs on Cloudflare Workers.

## Models (configured in `worker/wrangler.toml`)

| Binding | Model | Used for |
|---------|-------|----------|
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Phase 6 embeddings (1024-dim, 8192 token input) |
| `EXTRACTION_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | Phase 3 orphan resolution, Phase 4 metadata, Phase 5 LLM relations |
| `ANSWER_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Phase 3 table row/column tree, Phase 9 answer generation |
| `RERANK_MODEL` | `@cf/baai/bge-reranker-base` | Phase 8 reranking |

The larger 70b model is reserved for the harder structural reasoning tasks
(table double-tree) and final answer generation; the fast 8b model handles
high-volume per-unit extraction.

---

# System Overview

Two pipelines run inside one Worker:

1. **Ingestion Pipeline** (`/ingest*` endpoints)
   - Converts the source document into structured knowledge.
   - Detects/splits semantic units (incl. table double-tree unitization).
   - Extracts metadata, relationships, embeddings.
   - Builds the D1 knowledge graph.

2. **Query Pipeline** (`/query` endpoint)
   - Retrieves relevant semantic units via Vectorize.
   - Expands through parents/siblings and the knowledge graph.
   - Reranks candidates.
   - Generates a citation-backed answer.

Ingestion is **chunked and resumable**: a client poll loop calls
`POST /ingest/step` repeatedly, each call advancing one batch within a single
Worker invocation's CPU budget. Job state is persisted in D1
(`ingestion_jobs`) and the structure snapshot in R2.

---

# Phase 1 — Document Conversion

## Input

- DOCX

## Output

- Markdown (the canonical source)

Implemented in `parser/docx_to_markdown.py`. **Deterministic, no LLM.**

The converter walks the DOCX body in document order (paragraphs + tables) and
emits Markdown preserving:

- Heading hierarchy
- Tables (GitHub-flavored Markdown tables)
- Lists (bulleted / numbered paragraph styles)
- Bold/italic formatting on runs (key terms)
- Paragraph structure and original case
- Page numbers, via Word's `<w:lastRenderedPageBreak/>` markers, emitted as
  HTML comments: `<!-- page: N -->`

### Heading detection

This document has **no Word heading styles**, so headings are detected from
numbering conventions rather than styles:

- Roman numerals (`II. TITLE`) → level 1 (chapter)
- Numeric dotted prefixes (`2.1. Title`, `2.1.1. TITLE`) → level = dot count + 1
  (section / subsection), capped at 4
- Numbered *list* items use a closing paren (`1)`) so they do not collide with
  heading detection
- Title length guards (< 80 chars for roman, < 120 for numeric) prevent prose
  that happens to start with a number from being misread as a heading

---

# Phase 2 — Structural Parsing

## Input

- Markdown

## Output

- Hierarchical `structure.json` (the Phase 2 node tree consumed by the Worker)

Implemented in `parser/markdown_to_structure.py`. **Deterministic, no LLM.**
(The original proposal suggested using an LLM here; in practice the LLM is
deferred to Phase 3, where it operates on already-chunked leaves.)

Each node contains:

- `id` — stable, sequential, zero-padded (`CHAPTER-00001`, `RULE-00042`,
  `TABLE-00005`, …)
- `parent` — parent node id (or null for the document root)
- `type` — node type (see below)
- `path` — section path (array of ancestor titles)
- `page` — page number from the most recent `<!-- page: N -->` marker
- `content` — raw text (stripped)
- `children` — ordered list of child node ids

## Node Types

```
document > chapter > section > subsection > group > (rule | table | note | image)
```

`group` is a **structural container** added beyond the original node-type list.
A standalone line ending with `:` whose next non-empty line is a list item
(bold / numbered / bullet) becomes a `group` node; subsequent list items become
its children. This gives the tree an explicit `category → entries` hierarchy
and prevents two failure modes:

- Short category labels (e.g. "Основные:") becoming orphan semantic units.
- Later category labels bleeding into the last entry of the previous group.

`group` nodes are **not leaves**, so Phase 3 skips them and processes their
children as individual units.

### Leaf-size guards

Structural leaf nodes are split when they grow too large so downstream
semantic detection stays within a reasonable budget:

- `MAX_TABLE_ROWS = 30`, `MAX_TABLE_CHARS = 4000` — large data tables are
  flushed early as separate `table` nodes.
- `MAX_RULE_CHARS = 4000` — a rule leaf that exceeds this forces a new leaf.

### Decorative grids

A pipe-delimited block with **no `---` separator row** is treated as a
decorative grid (e.g. skills laid out in a table for layout, not data). Each
non-empty cell is emitted as its own `rule` leaf so every skill/perk becomes an
independent unit. Real data tables (with a separator) are kept as `table`
nodes for the Phase 3 double-tree pipeline.

### Colon-introduced lists

Numbered/bullet items following a `:`-ending line are merged into the
introducing leaf (tracked via `in_list_after_intro`). Bold-term "lists"
(`**Аврианцы.** ...`) are **not** merged — they are separate entities that the
LLM can link later. A group auto-closes when the next non-empty line after a
blank line is not a list item, preventing groups from absorbing unrelated
content.

---

# Phase 3 — Semantic Unit Detection

## Input

- Phase 2 leaf nodes (`rule`, `table`, `note`, `image`)

## Output

- Semantic units (typed, identified, hashed)

Implemented in `worker/src/pipeline/units.ts` (rules/notes) and
`worker/src/pipeline/table_tree.ts` (tables).

Do **not** split by token count. Identify meaningful semantic units.

## Semantic unit types

`Rule`, `Attribute`, `Skill`, `Trait`, `Ability`, `Action`, `StatusEffect`,
`Item`, `Spell`, `Example`, `Situation`, `Modifier`, `Definition`,
`Equipment`, `Weapon`, `Formula`, `Table`.

## Identifiers

Each semantic unit receives a permanent identifier of the form
`<TYPE>-<uuid>` (e.g. `RULE-3f2a1b...`). IDs are **UUID-suffixed, not
sequential**, because Cloudflare Workers isolates are ephemeral — a fresh
isolate is used for every request and after a CPU-limit crash, so an in-memory
counter would reset and collide on D1 primary keys. `crypto.randomUUID()`
guarantees global uniqueness across invocations.

Each unit also carries:

- `sourceNodeId` — the Phase 2 leaf it came from
- `sourceOrder` — position within the source node (for adjacency relations)
- `parentUnitId` / `secondaryParentUnitId` — primary (row-tree) and secondary
  (column-tree) parent units, used by table unitization and orphan linking
- `contentHash` — SHA-256 of content, used for incremental updates

## 3a. Rule / note unitization (deterministic + LLM orphan resolution)

The pipeline over-splits then merges, rather than asking the LLM to split a
node that already contains two mechanics:

1. **Chunking** (`chunkRuleContent`) — splits source on bold headings,
   numbered/bullet items, and `N–M` ranges. Over-splitting is intentional: the
   LLM can merge chunks, but cannot split a chunk that already contains two
   mechanics.
2. **Cohesive merge** (`mergeCohesiveChunks`) — consecutive non-heading
   fragments are merged into the preceding heading block. Numbered/bullet
   items that follow a colon-introduced list are merged into the parent block
   instead of starting new units.
3. **Orphan resolution** (LLM) — short/detached fragments (stat modifiers like
   `+1З, +1Э`, bonuses, penalties, conditions) that have no standalone meaning
   are identified by a heuristic (`isOrphanCandidate`: content < 60 chars, or
   unnamed stat-like lines; short bold headings are *not* orphans). The LLM is
   then asked, for each orphan, whether to:
   - **merge** it into a preceding unit, or
   - **link** it as a child unit (kept separate, `parentUnitId` set).

   Merge chains are resolved to a final non-merged parent; linked children's
   logical parent is resolved past any merged units to avoid pointing at a unit
   that was physically merged away. Accepted decisions and reasons are logged.

A node can yield more than one semantic unit; extracted units become children
of the original node's identity (via `sourceNodeId` + `parentUnitId`).

## 3b. Table unitization (double-tree pipeline)

Implemented in `worker/src/pipeline/table_tree.ts`. Tables are not flattened —
they are decomposed via a **row tree + column tree** ("double tree") so each
`(row, column-group)` cell becomes an independently retrievable unit while
preserving the table's section/header hierarchy.

The pipeline:

1. **`buildRowSkeleton`** (deterministic) — parses the markdown table into a
   2D grid, classifies each row as:
   - `structural` — merged row (all cells identical); could be a description,
     section header, or title.
   - `header` — non-merged row immediately before a `---` separator (standard
     markdown table header), or the first row after a separator when the
     pre-separator row was merged.
   - `data` — all other rows (one data node per row).
   - `visual` — only when the whole table is a single visual node.
   Each data node has exactly 1 row; parents link to the most recent
   structural/header node. Guarantees: every row covered, exactly one root,
   valid parent chain.

2. **`refineRowSkeleton`** (LLM, 70b) — receives the deterministic skeleton
   and the `[N]`-prefixed table, returns **only corrections** as a JSON array:
   - `new_role` reclassification (`section` / `description` / `header` /
     `data`); `visual` is blocked at this level (only the whole-table
     `{"action":"visual"}` is honored, guarded by fill-ratio < 0.7).
   - `new_parent` reparenting (e.g. chain a description row to the preceding
     name row, building `name → description` hierarchies).
   - `{"action":"visual"}` to reclassify the entire table as a grid/diagram.
   Corrections are validated (no root reclassification, no self-parenting, no
   backward parenting, no cycles). Retries once on failure; falls back to the
   skeleton.

3. **`detectColumnTree`** (LLM, 70b) — builds the column tree from scratch
   using the refined row skeleton as context. The prompt encodes the key
   decision — **SPLIT** (independent sub-tables side by side; each column or
   column-group is a separate list) vs **SIMPLE** (columns are properties of
   one entity per row) — with explicit examples for merged-title + independent
   lists, key-value pairs side by side, and multi-property rows. Validated:
   all columns must be covered. Fallback: one data node with all columns.

4. **`overrideColumnTree`** (deterministic) — applies language-agnostic,
   document-agnostic overrides only when there is a clear structural signal:
   - **Sparse grid override**: `fillRatio < 0.6` AND `colCount > 10` → force
     `VISUAL` (detects sparse diagram grids).
   - **Numeric-key + merged-description override**: if there is a merged
     description row (a `structural` row with all cells identical) AND **all**
     col-0 data values (excluding merged rows) are short integers (`0-999`)
     → force `SIMPLE` (one data node with all columns). Both signals together
     are a strong, portable indicator of a key-value/property table.
   - Non-numeric tables are **not** overridden to SPLIT, because that would
     break common `Name|Description`, `Item|Price`, `Question|Answer` patterns
     which are SIMPLE. The SPLIT-vs-SIMPLE decision for non-numeric tables is
     left to the LLM.

5. **`deduplicateColumnHeaders`** (deterministic) — removes duplicate header
   **and** data nodes covering the same columns (same type + same `cols`
   array), remapping children to the first instance. Fixes MULTI-MERGED tables
   where the LLM creates duplicate column hierarchies per section.

6. **`buildTableUnitsFromTree`** (deterministic) — creates semantic units from
   the double-tree, in this order:
   1. Row-tree non-data nodes (description/header/section/structural) →
      structural units, parented up the row tree.
   2. Column-tree non-data nodes (column headers) → header units, parented to
      the row-tree header unit (giving `row header → column header → data`).
      If a column header produces the same content as the row header unit
      (happens in SIMPLE tables where one column header covers all columns),
      the duplicate is skipped and the column node is mapped to the existing
      row header unit.
   3. Data units: one per row in each row-tree data node × column-tree data
      node. Each row becomes its own unit for independent retrieval/embedding.
      - Row-width column filtering: column indices beyond a row's width are
        filtered to valid columns only (prevents both data loss and
        duplication when multiple column data nodes exist for different
        sections of the table).
      - Per-row deduplication: `(rowIndex, validCols)` pairs are tracked to
        prevent duplicate units when multiple column data nodes resolve to the
        same columns for a row.
      - Parent linking: if the row node's parent is another **data** node
        (e.g. spell description → name), chain to that data row as primary
        parent and the column header as secondary. Otherwise the column header
        is primary and the row-tree parent is secondary. Data nodes are
        processed in tree-depth order so data→data chaining can reference
        already-created parent units.

### Structure type distribution (as measured on the 62-table rulebook)

| Type | Count | Description |
|------|-------|-------------|
| SPLIT | 18 | Column-split data (each cell independently retrievable) |
| SIMPLE | 25 | Full rows, one entity per row (numeric-key override) |
| SPLIT+HEADER | 16 | Independent lists with column header secondary parents |
| VISUAL | 1 | Sparse grid collapsed to single unit |
| MULTI-MERGED | 2 | Section headers + data within columns |

See `table_unitization_report.md` for the full per-table analysis.

### Single-table testing

`POST /ingest/table { node }` processes one table node and returns the
detected structure + units **without saving to DB**, for isolated testing:

```bash
node worker/scripts/ingest-table.mjs --url https://<worker> \
  --structure rulebooks/deorim_rules.structure.json --node-id TABLE-00005 \
  --api-key "$ADMIN_API_KEY"
```

---

# Phase 4 — Metadata Extraction

## Input

- A semantic unit (with optional parent unit context)

## Output

- Structured metadata + summary

Implemented in `worker/src/pipeline/metadata.ts` (LLM, 8b, JSON-schema mode).

### Parent context

If the unit has a `parentUnitId` (row-tree parent) and/or
`secondaryParentUnitId` (column-tree parent), the parent unit's name + first
800 chars of content are injected into the prompt as context. This is critical
for orphan/child units and table data cells whose meaning depends on their
parent (e.g. a modifier that belongs to a specific spell or age category, or a
table cell that only makes sense under its row/column header).

### Required fields

`defines`, `references`, `requires`, `exceptions`, `modifies`, `modified_by`,
`keywords`, `aliases`, `summary`.

The model is instructed to use only information present in the text, keep the
original language (Russian) for all extracted strings, and use empty arrays
where nothing applies. On failure, the unit falls back to a truncated content
summary so ingestion never blocks.

### Unresolved references

Reference-like strings that cannot be resolved to any candidate unit in
Phase 5 are stored back into `metadata.unresolved_references` (capped at 20)
for downstream reporting and iterative cleanup (see Phase 5).

---

# Phase 5 — Relationship Extraction

## Input

- A semantic unit + candidate units

## Output

- Relations (typed, confidence-scored) + unresolved reference list

Implemented in `worker/src/pipeline/relationships.ts`. **Hybrid**: deterministic
edges plus an LLM pass, deduplicated.

## Relation types

`defines`, `references`, `requires`, `excepts`, `modifies`, `modified_by`,
`overrides`, `related_to`, `incompatible_with`, `creates`, `consumes`,
`supersedes`, `example_of`, **`part_of`**.

`part_of` is added beyond the original list to capture the parent-child
hierarchy produced by table unitization and orphan linking.

## Edge sources (combined and deduplicated)

1. **Adjacency relations** (deterministic) — for units split from the same
   source node, each unit is linked `related_to` (confidence 0.85) to its
   immediate predecessor and successor by `sourceOrder`. This captures
   precedence/ordering that the split would otherwise lose.

2. **Parent relations** (deterministic) — `part_of` (0.95) from a unit to its
   `parentUnitId`, and `part_of` (0.9) to its `secondaryParentUnitId` when
   present. These encode the table double-tree and orphan-link hierarchy.

3. **Metadata-derived relations** (deterministic resolution) — the explicit
   metadata fields (`references`, `requires`, `modifies`, `modified_by`,
   `exceptions`) are resolved to candidate units via `resolveReference`:
   exact name match → `metadata.defines` match → section-path substring match
   → content/summary substring match. Each resolved reference becomes a typed
   edge (0.9). **Unresolved** reference strings are collected and, after
   filtering tiny noise fragments, written back to
   `metadata.unresolved_references` and logged.

4. **LLM relations** (8b, JSON-schema mode) — given the source unit and a
   candidate list (id, name, type, short summary, `[same source node]` flag),
   the model returns typed edges with confidence. Only `target_id`/`target_name`
   that match a real candidate are kept; confidence is clamped to `[0,1]`;
   unknown relation types default to `related_to`.

All four sources are merged, deduplicated on `(source, target, relation_type)`.

## Candidate selection (`findCandidateUnits`)

Because Phase 5 runs as a whole-document pass after every unit exists,
candidates can come from anywhere in the book (forward and backward
references). Candidates are gathered, up to a limit (default 25), in priority
order:

1. **Keyword candidates** — units sharing any of the source unit's keywords
   (via the `keywords` join table).
2. **Reference-name candidates** — units whose `name`, `metadata_json`,
   `content`, or `summary` match any explicit reference string from the
   source unit's metadata (defines/references/requires/modifies/modified_by/
   exceptions/aliases).
3. **Same-source-node siblings** — units from the same structure node, ordered
   by `source_order` (catches adjacency the split may have lost).
4. **Section-path candidates** — deepest section first, then chapter as
   fallback, via `section LIKE '%...%'`.

---

# Phase 6 — Embedding Generation

Implemented in `worker/src/pipeline/embeddings.ts`.

Do **not** embed only the original text. Construct an **enriched embedding
document** per unit:

```
Chapter: <chapter>
Section: <section path>
Unit Name: <name | id>
Type: <type>
Summary: <summary>
Keywords: <comma-joined>
Aliases: <comma-joined>
Defines: <comma-joined>
References: <comma-joined>
Requires: <comma-joined>
Exceptions: <comma-joined>
Modifies: <comma-joined>
Modified By: <comma-joined>
Original Text: <content>   (only if the full doc fits the token budget)
```

### Token budget

`bge-m3` supports 8192 input tokens; the embedder stays well under it
(`MAX_EMBED_TOKENS = 6000`, estimated at `bytes / 2.5`). If the combined
enriched document + original text fits, the full text is included; otherwise
only the structured metadata is embedded (the full content is still available
to answer generation). This keeps every unit within a single embedding call.

### Storage

Embeddings are upserted to Vectorize with metadata
(`type`, `section`, `page`, `name`). The vector id equals the unit id.

---

# Phase 7 — Knowledge Graph

Implemented in `worker/schema.sql` (D1 schema), `worker/src/pipeline/graph.ts`
(population), and `worker/src/utils/db.ts` (access).

## D1 schema

Beyond the original `concepts` / `semantic_units` / `relations` /
`concept_unit` / `keywords` tables, the as-built schema adds:

- **`documents`** — registers each ingested document (`id`, `source_path`,
  `ingested_at`).
- **`structure_nodes`** — persists the Phase 2 tree (`id`, `document_id`,
  `parent_id`, `type`, `page`, `section_path`, `content`, `content_hash`).
  Indexed by parent. Enables cleanup and incremental updates by document.
- **`ingestion_jobs`** — resumable job state (`id`, `document_id`, `phase`,
  `status`, `detail`, timestamps). `detail` is a JSON blob carrying the
  cursor/phase/unitsProcessed progress.

### `semantic_units` columns

`id`, `source_node_id`, `type`, `name`, `page`, `section` (JSON array),
`content`, `content_hash`, `summary`, `metadata_json`, `parent_unit_id`,
`secondary_parent_unit_id`, `source_order`, `embedding_id`, `status`,
`updated_at`.

- `parent_unit_id` / `secondary_parent_unit_id` — row-tree and column-tree
  parents (foreign keys to `semantic_units`). Indexed.
- `status` — the ingestion state machine:
  `pending → metadata_done → relations_done → embedded → graphed`.
  Indexed. Each pipeline phase selects the next batch by status.
- `content_hash` — drives incremental updates. Indexed.

### `relations` columns

`id`, `source_id`, `target_id`, `relation_type`, `confidence`. Indexed on
both `source_id` and `target_id` for graph expansion in either direction.

### Population

- **`populateConceptsAndKeywords`** runs right after Phase 4 metadata: clears
  and re-inserts the unit's keywords, and for each `metadata.defines` term
  upserts a concept (reusing an existing concept by unique `name`) and links
  it to the unit.
- **`populateRelations`** runs in the Phase 5 pass: clears the unit's outgoing
  relations and inserts the new edge set.

---

# Phase 8 — Retrieval Pipeline

Implemented in `worker/src/retrieval/query.ts`.

Processing steps:

1. Receive user question.
2. Generate query embedding (`bge-m3`).
3. Search Vectorize (`topKVector`, default 8).
4. Retrieve top semantic units (seeds).
5. **Parent/sibling expansion** (added beyond the original plan): for each
   seed, fetch **both** parents (row + column) and all children of each parent
   (row siblings + column siblings). This is essential for table units —
   retrieving a cell should also retrieve its row/column header and sibling
   cells so the answer has full row/column context. Each expanded unit is
   tagged with an `expansionRole` (`seed` / `row_parent` / `col_parent` /
   `row_sibling` / `col_sibling`).
6. Expand through the knowledge graph (`graphHops`, default 2): each hop
   follows relations in either direction and adds newly discovered units.
7. Dedupe (guaranteed by a Map keyed on unit id).
8. Rerank (`bge-reranker-base`) over enriched documents.
9. Return top `finalCount` (default 12).

Reranking falls back to original order with descending fake scores if the
reranker is unavailable, so retrieval never fails.

---

# Phase 9 — Answer Generation

Implemented in `worker/src/retrieval/answer.ts` (LLM, 70b).

The LLM follows these rules:

- Use only the supplied evidence. Never invent rules or fill gaps with
  assumptions.
- Every factual claim cites the unit id inline, like `(RULE-00042)`.
- If two units conflict, explicitly mention the conflict and which one takes
  precedence if stated (via an `overrides`/`supersedes` relation), otherwise
  say the conflict is unresolved.
- If the evidence is incomplete or ambiguous, say so explicitly instead of
  guessing.
- Answer in the same language as the question.

Evidence is formatted per unit as
`[ID] (type, section > path, page N)\n<content>`, joined by `---` separators.

### Citations

Used unit ids are extracted from the answer via the `[A-Z]+-\d{5}` /
UUID-style id pattern and intersected with the retrieved set. Each citation
includes `unitId`, `section` (joined ` > `), and `page`. The response also
returns `retrievedUnits` (id, type, name, section, page, vectorScore,
rerankScore) for transparency.

---

# Ingestion Architecture

The original proposal described seven separate workers (Ingestion, Parser,
Metadata, Relationship, Embedding, Graph, Query). The as-built system is a
**single Worker** with HTTP endpoints, driven by a client poll loop.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest/upload` | Store `structure.json` in R2, return `bucketKey` |
| POST | `/ingest` | Start/restart ingestion (`documentId`, `sourcePath`, `structure` \| `bucketKey`) → `jobId` |
| POST | `/ingest/step` | Advance one batch (`jobId`, `batchSize?`) |
| GET | `/ingest/status` | Job state |
| GET | `/ingest/orphans` | Units with unresolved metadata refs (QA review) |
| POST | `/ingest/cleanup` | Delete all D1/Vectorize/R2 data for a document |
| POST | `/ingest/table` | Single-table test (no DB write) |
| POST | `/ingest/rebuild-relations` | Re-run Phase 5 across the whole KB (incremental) |
| POST | `/query` | Full Phase 8/9 retrieval + answer |

## Staged, whole-document phases

`processIngestionBatch` runs four sequential, whole-document phases (not
interleaved per node):

1. **units** — Phase 3 for every leaf node. Tables are processed one per batch
   (the 70b table LLM calls take several seconds each); rules/notes use the
   configured `batchSize` (default 3, client default 5).
2. **metadata** — Phase 4 + concepts/keywords (Phase 7) for every unit.
3. **relations** — Phase 5 + graph relations (Phase 7) for every unit. Because
   this phase only starts once the entire document exists, relationship
   extraction sees the complete knowledge base as candidates — forward and
   backward references alike — so no separate rebuild pass is needed for a
   fresh ingest.
4. **embeddings** — Phase 6 for every unit.

Each phase selects its next batch by `status` (`pending` → `metadata_done` →
`relations_done`), so progress is resumable across Worker invocations and
crashes.

## Client driver

`worker/scripts/ingest.mjs` uploads `structure.json` to R2 first (always
automatic — no manual step or size caveat), then calls `/ingest` and loops
`/ingest/step`. It tracks stage/progress, persists a resumable state file
(`.ingest-state.json`), and retries transient errors with backoff while
logging full error details to `ingest.log`. Re-running the same command
resumes from the recorded job/phase; `--fresh` forces a new job;
`--status-only` prints current status.

## Full iteration cycle

`iterate.sh` runs the whole cycle in one command — clean local state, reparse
`structure.json`, clean the remote DB, deploy the worker, start a fresh
ingestion:

```bash
./iterate.sh              # blocks until ingestion completes
./iterate.sh --no-watch   # starts ingestion in background
```

---

# Incremental Updates

When the source document changes:

1. Re-run the parser on the updated DOCX.
2. `POST /ingest` again with the same `documentId` and the new `structure.json`.
3. `processIngestionBatch` hashes each structure node's content and **skips**
   re-running Phases 3-7 for any node whose existing semantic units all have a
   matching `content_hash`. Only changed nodes are reprocessed (and
   re-embedded/re-graphed).
4. For older units that should reconsider newly changed ones as candidates,
   `POST /ingest/rebuild-relations` re-runs Phase 5 across the whole knowledge
   base in batches.

Avoids rebuilding the entire knowledge base.

---

# API Security

- **`ADMIN_API_KEY`** (required, via `wrangler secret put`) — every `/ingest*`
  endpoint fails **closed** if it is not set or the bearer token does not
  match. Constant-time comparison avoids trivial timing side-channels.
- **`QUERY_API_KEY`** (optional) — if set, `/query` also requires a bearer
  token; otherwise `/query` is open (useful for a public-facing Q&A bot).
- For local `wrangler dev`, copy `worker/.dev.vars.example` to
  `worker/.dev.vars` (gitignored) and fill in your own values.

Every protected request must include `Authorization: Bearer <key>`.

---

# Storage Layout

## R2

- `structures/<documentId>.json` — uploaded structure document
- `structures/<documentId>.meta.json` — source path sidecar
- `jobs/<jobId>.json` — per-job structure snapshot (used by `/ingest/step`)

## Vectorize

- `slitherer-rag-units` — unit embeddings (1024-dim, cosine)

## D1 (`slitherer-rag-db`)

Tables: `documents`, `structure_nodes`, `semantic_units`, `concepts`,
`concept_unit`, `keywords`, `relations`, `ingestion_jobs`.

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`); apply with
`npm run db:migrate:remote`.

---

# Verification & Operations

```bash
# Parser
cd parser && .venv/bin/python docx_to_markdown.py ../rulebooks/deorim_rules.docx -o ../rulebooks/deorim_rules.md
.venv/bin/python markdown_to_structure.py ../rulebooks/deorim_rules.md -o ../rulebooks/deorim_rules.structure.json

# Worker
cd worker && npm run typecheck   # TypeScript type checking
cd worker && npm run deploy      # Deploy to Cloudflare Workers
cd worker && npm run db:migrate:remote   # Apply D1 schema

# Ingest
cd worker && ADMIN_API_KEY=<key> npm run ingest -- \
  --url https://<worker> --structure ../rulebooks/deorim_rules.structure.json \
  --document-id deorim_rules --source-path rulebooks/deorim_rules.docx

# Cleanup a failed/stale ingestion (API, not manual SQL)
curl -X POST https://<worker>/ingest/cleanup \
  -H 'content-type: application/json' -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"documentId":"<doc-id>"}'
rm -f worker/.ingest-state.json
```

See `README.md` and `AGENTS.md` for the full operations runbook.

---

# Design Principles

1. Never split by arbitrary token count.
2. Split by semantic meaning.
3. Preserve document hierarchy.
4. Perform expensive processing during ingestion.
5. Build explicit graph relationships.
6. Use embeddings only for discovery.
7. Use graph traversal (and parent/sibling expansion) to gather context.
8. Rerank before answer generation.
9. Generate answers strictly from retrieved evidence.
10. Every answer must include citations.
11. Deterministic-first: use heuristics for everything that can be decided
    structurally (row skeleton, column overrides, deduplication, adjacency,
    parent links); reserve the LLM for judgment calls (orphan merge/link,
    row refinement, column SPLIT-vs-SIMPLE, metadata, relations, answers).
12. Keep heuristics language-agnostic and document-agnostic — no hard-coded
    terms, units, attribute names, or version-specific vocabulary.

---

# MVP Deliverables (As-Built)

- DOCX → Markdown conversion (Phase 1, deterministic)
- Structural parser with `group` containers and leaf-size guards (Phase 2,
  deterministic)
- Semantic unit detection with deterministic chunking + LLM orphan resolution
  (Phase 3a)
- Table double-tree unitization: row skeleton → LLM refinement → LLM column
  tree → deterministic overrides → deduplication → unit building (Phase 3b)
- Metadata extraction with parent context and unresolved-reference tracking
  (Phase 4)
- Hybrid relationship extraction: adjacency + parent + metadata-derived + LLM,
  with candidate selection (Phase 5)
- Enriched embedding generation with token-budget management (Phase 6)
- D1 knowledge graph with documents/structure_nodes/ingestion_jobs tables and
  a status state machine (Phase 7)
- Hybrid retrieval: vector search → parent/sibling expansion → graph expansion
  → rerank (Phase 8)
- Citation-aware answer generation with conflict detection (Phase 9)
- Chunked, resumable ingestion driven by a client poll loop
- Incremental update pipeline via content hashing
- API security (fail-closed admin, optional query auth)
- Operations tooling: `iterate.sh`, `/ingest/table`, `/ingest/orphans`,
  `table_unitization_report.md`

The MVP is complete when users can ask questions involving multiple
interacting mechanics, and the system consistently retrieves all relevant
rules (including the right table cells and their row/column context),
resolves interactions using only retrieved evidence, and produces fully cited
answers.

---

# Future Improvements

## Multi-query Retrieval

Rewrite one question into multiple focused searches, merge and rerank.

## Conflict Detection

Automatically identify conflicting rules, duplicate definitions, circular
dependencies, and unreachable mechanics.

## Rule Timeline

Track introduced / modified / deprecated / overridden.

## Mechanic Summaries

Generate synthetic concept summaries by aggregating every semantic unit
connected to the same mechanic; these can improve retrieval quality.

## Heading-detection cleanup

The local heading heuristic also matches the book's table-of-contents entries
(they reuse the same numbering scheme), producing some duplicate early nodes.
Harmless for the pipeline; can be filtered by section-page monotonicity if it
becomes an issue.
