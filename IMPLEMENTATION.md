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
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Summary-phase embeddings, retrieval query embeddings (1024-dim, 8192 token input) |
| `EXTRACTION_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | Phase 3 orphan resolution, Phase 8 router (RAG/chat + language + translation), chat responses |
| `ANSWER_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Phase 3 table tree, summary generation, metadata extraction, Phase 8 decomposition, sufficiency check, answer generation |
| `RERANK_MODEL` | `@cf/baai/bge-reranker-base` | Phase 8 per-sub-query reranking |

The 70b model handles all high-quality reasoning tasks: table double-tree
structure, summary generation, metadata extraction (all 14 relationship
fields), query decomposition, sufficiency evaluation, and answer generation.
The fast 8b model is used for Phase 3 orphan resolution and Phase 8 routing
(high-volume, low-latency classification/translation).

---

# System Overview

Two pipelines run inside one Worker:

1. **Ingestion Pipeline** (`/ingest*` endpoints)
   - Converts the source document into structured knowledge.
   - Detects/splits semantic units (incl. table double-tree unitization).
   - Generates summaries (70b, parent-context-enriched) and embeds them.
   - Extracts all 14 metadata relationship fields (70b).
   - Constructs relationships via vector search (confidence = similarity score).
   - Builds the D1 knowledge graph.

2. **Query Pipeline** (`/query` and `/query/*` endpoints)
   - Routes user message: RAG vs chat, language detection, translation to Russian.
   - Decomposes the query into focused sub-queries (1-5) with a dynamic rerank threshold.
   - Retrieves candidates per sub-query via Vectorize + parent/sibling + graph expansion.
   - Reranks each candidate against the sub-query that found it (per-sub-query reranking).
   - Checks sufficiency via a structured checklist; iterates with follow-up queries if gaps remain.
   - Generates a citation-backed answer in the user's language.
   - Supports streaming (SSE) and complete (JSON) response modes.
   - Conversation history stored in D1; every step logged to D1 `query_logs`.

Ingestion is **chunked and resumable**: a client poll loop calls
`POST /ingest/step` repeatedly, each call advancing one batch within a single
Worker invocation's CPU budget. Job state is persisted in D1
(`ingestion_jobs`) and the structure snapshot in R2.

---

# Ingestion Data Flow

What data gets extracted, created, upserted, and modified at every stage, and why.

```
DOCX (rulebooks/deorim_rules.docx)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 1 — Document Conversion (Python, local)          │
│  parser/docx_to_markdown.py                             │
│                                                         │
│  INPUT:   DOCX file                                     │
│  EXTRACTS: heading hierarchy, tables, lists, bold/      │
│    italic, page numbers (<!-- page: N -->)              │
│  CREATES:  rulebooks/deorim_rules.md                    │
│  WHY: Canonical text representation. No LLM —           │
│    deterministic conversion preserving document          │
│    structure.                                           │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 2 — Structural Parsing (Python, local)           │
│  parser/markdown_to_structure.py                        │
│                                                         │
│  INPUT:   Markdown file                                 │
│  EXTRACTS: node tree with types:                        │
│    document > chapter > section > subsection >          │
│    group > (rule | table | note | image)                │
│    Each node: id, parent, type, path, page,             │
│    content, children                                    │
│  CREATES:  structure.json file                          │
│    - group containers (colon-introduced lists)          │
│    - leaf-size guards (MAX_TABLE_ROWS=30,               │
│      MAX_TABLE_CHARS=4000, MAX_RULE_CHARS=4000)         │
│    - decorative grid splitting (no --- separator)       │
│  WHY: Give the Worker a deterministic tree of           │
│    leaves to process. LLM deferred to Phase 3           │
│    where it operates on already-chunked leaves.         │
└─────────────────────────────────────────────────────────┘
  │
  │  structure.json uploaded to R2 via /ingest/upload
  │  POST /ingest starts the job
  ▼
┌─────────────────────────────────────────────────────────┐
│  INGESTION SETUP (Worker)                               │
│  ingest.ts → startIngestion()                           │
│                                                         │
│  READS:   structure.json from R2                        │
│  CREATES: D1 documents row (id, source_path,            │
│    ingested_at)                                         │
│  UPSERTS: D1 structure_nodes rows — every node in       │
│    the tree (id, document_id, parent_id, type, page,    │
│    section_path, content, content_hash)                 │
│  CREATES: D1 ingestion_jobs row (id, document_id,       │
│    phase="units", status="running", detail JSON)        │
│  WHY: Register the document, persist the full tree      │
│    for cleanup/incremental updates, start the           │
│    resumable job state machine.                         │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 3 — Semantic Unit Detection (Worker)             │
│  ingest.ts → stepUnitsPhase()                           │
│  units.ts (rules/notes) + table_tree.ts (tables)        │
│                                                         │
│  READS:   D1 structure_nodes (leaf nodes via cursor)    │
│  CHECKS:  content_hash vs existing units — skips        │
│    unchanged nodes (incremental update)                 │
│                                                         │
│  FOR EACH LEAF NODE:                                    │
│                                                         │
│  3a. Rules/notes (units.ts):                            │
│    EXTRACTS: chunks via bold/numbered/bullet splits     │
│    MERGES:   consecutive non-heading fragments          │
│    LLM (8b):  orphan resolution — merge short           │
│      fragments into preceding unit OR link as           │
│      child (sets parentUnitId)                          │
│    CREATES:  SemanticUnit objects with:                 │
│      id (UUID-suffixed), sourceNodeId, type,            │
│      name, content, contentHash, sourceOrder,           │
│      parentUnitId, secondaryParentUnitId,               │
│      status="pending"                                   │
│                                                         │
│  3b. Tables (table_tree.ts):                            │
│    EXTRACTS: row skeleton (deterministic)               │
│    LLM (70b): refineRowSkeleton — reclassify rows,      │
│      reparent for section hierarchies                   │
│    LLM (70b): detectColumnTree — SPLIT vs SIMPLE        │
│    DETERMINISTIC: overrideColumnTree (sparse grid,      │
│      numeric-key detection)                             │
│    DETERMINISTIC: deduplicateColumnHeaders              │
│    DETERMINISTIC: buildTableUnitsFromTree — one unit    │
│      per (row, column-group) cell, with parent links    │
│    CREATES:  SemanticUnit objects (same fields as 3a)   │
│                                                         │
│  UPSERTS: D1 semantic_units rows (status="pending")     │
│  MODIFIES: D1 ingestion_jobs (cursor advances)          │
│  WHY: Split the document into meaningful semantic       │
│    units — not arbitrary token chunks. Each unit        │
│    is independently retrievable. Table cells get        │
│    row/column parent links for context expansion.       │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "units" → "summary"
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 4a — Summary Generation + Embedding (Worker)     │
│  ingest.ts → stepSummaryPhase()                         │
│  summary.ts + embeddings.ts                             │
│                                                         │
│  READS:   D1 semantic_units (status="pending",          │
│    parent-first order via                                │
│    getUnitsByStatusParentFirst)                         │
│  READS:   D1 semantic_units (parent units — to get      │
│    parent.summary ?? parent.content, first 800 chars)   │
│                                                         │
│  FOR EACH UNIT (batch size ≤ 2):                        │
│                                                         │
│  Step 1 — Summary (summary.ts):                         │
│    LLM (70b): generates 1-3 sentence summary            │
│    INPUT:  unit.type, unit.name, unit.section,          │
│      parent context (parent summary/content),           │
│      unit.content (full)                                │
│    OUTPUT: summary string                               │
│    WHY: Parent-context-enriched summary that is         │
│      self-contained. Critical for table cells           │
│      whose content alone is meaningless.                │
│                                                         │
│  Step 2 — Embedding (embeddings.ts):                    │
│    EXTRACTS: buildEnrichedDocument(unit) →              │
│      "Name: <name>\nSummary: <summary>\n                │
│       Aliases: <aliases>\n<content>"                    │
│      (aliases empty at this point — extracted in 4b)    │
│      (content included only if fits 6000 token budget)  │
│    LLM (bge-m3): embeds the document → 1024-dim vector  │
│    WHY: Clean "what is this unit" signal. No            │
│      relationship descriptors or structural             │
│      context — those are handled by graph               │
│      expansion at retrieval time.                       │
│                                                         │
│  UPSERTS: Vectorize vectors (id=unit.id, values=vector, │
│    metadata: type, section, page, name)                 │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.summary = generated summary                   │
│    - unit.embeddingId = unit.id                         │
│    - unit.status = "summary_done"                       │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │
│  WHY: Embeddings must exist before Phase 5              │
│    (vector-search-based relationship extraction          │
│    searches against the full vector database).           │
│    Parent-first order ensures parent summaries          │
│    are available when generating child summaries.       │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "summary" → "metadata"
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 4b — Metadata Extraction (Worker)                │
│  ingest.ts → stepMetadataPhase()                        │
│  metadata.ts + graph.ts (concepts/keywords)             │
│                                                         │
│  READS:   D1 semantic_units (status="summary_done",     │
│    parent-first order)                                  │
│  READS:   D1 semantic_units (parent units — parent      │
│    summary ?? parent.content, first 800 chars)          │
│                                                         │
│  FOR EACH UNIT (batch size ≤ 2):                        │
│                                                         │
│  Step 1 — Metadata (metadata.ts):                       │
│    LLM (70b): extracts structured metadata              │
│    INPUT:  unit.type, unit.name, unit.section,          │
│      unit.summary (pre-generated in 4a),                │
│      parent context (parent summary/content),           │
│      unit.content (full original text)                  │
│    OUTPUT: UnitMetadata JSON with all 14 relationship   │
│      fields + keywords + aliases:                       │
│      defines, references, requires, exceptions,         │
│      modifies, modified_by, overrides, related_to,      │
│      incompatible_with, creates, consumes,              │
│      supersedes, example_of, part_of,                   │
│      keywords, aliases                                  │
│    WHY: These fields become probe terms for             │
│      vector-search-based relationship extraction        │
│      in Phase 5. Keywords/aliases aid search.           │
│                                                         │
│  Step 2 — Concepts & Keywords (graph.ts):               │
│    CLEARS:  D1 keywords rows for this unit              │
│    INSERTS: D1 keywords rows (unit_id, keyword)         │
│      for each metadata.keywords entry                   │
│    UPSERTS: D1 concepts rows — for each                 │
│      metadata.defines term: reuse existing              │
│      concept by name OR create new CONCEPT-<uuid>       │
│      (id, name, description=unit.summary,               │
│      aliases=metadata.aliases)                          │
│    INSERTS: D1 concept_unit links (concept_id,          │
│      unit_id)                                           │
│    WHY: Concepts map canonical terms → units.           │
│      Keywords enable SQL candidate selection.           │
│                                                         │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.metadata = extracted metadata JSON            │
│    - unit.status = "metadata_done"                      │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "metadata" → "relations"
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 5 — Relationship Extraction (Worker)             │
│  ingest.ts → stepRelationsPhase()                       │
│  relationships.ts + graph.ts (relations)                │
│                                                         │
│  READS:   D1 semantic_units (status="metadata_done",    │
│    one at a time)                                       │
│  SEARCHES: Vectorize (for each metadata term probe)     │
│                                                         │
│  FOR EACH UNIT (one at a time):                         │
│                                                         │
│  Vector-search relations:                               │
│    COLLECTS: all (term, relationType) probes from       │
│      all 14 metadata fields                             │
│    DEDUP:   unique terms (same term may appear          │
│      in multiple fields)                                │
│    EMBEDS:  each unique term as "term + unit.summary"   │
│      → 1024-dim vector (bge-m3)                         │
│    SEARCHES: Vectorize for each term vector             │
│      (topK=100, returnMetadata)                         │
│    FILTERS: matches with similarity score               │
│      < 0.5 (SIMILARITY_THRESHOLD) discarded             │
│    CREATES: typed relations — one per (term,            │
│      match, relationType) with                          │
│      confidence = similarity score from vector          │
│      search                                             │
│    SKIPS:   self-matches (match.id === unit.id)         │
│    WHY: Vector search catches fuzzy/semantic            │
│      matches ("оглушён" → "оглушение") that             │
│      exact string matching misses. Confidence           │
│      = real match quality, not a fixed constant.        │
│      No deterministic adjacency or parent edges —       │
│      parent/child hierarchy is read directly from       │
│      semantic_units columns at retrieval time.          │
│                                                         │
│  DEDUP:    relations deduplicated on                    │
│      (source, target, relation_type)                    │
│                                                         │
│  CLEARS:  D1 relations rows where source_id = unit.id  │
│  INSERTS: D1 relations rows (id, source_id,             │
│    target_id, relation_type, confidence)                │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.status = "relations_done"                     │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │
│  WHY: Build a typed, confidence-scored knowledge        │
│    graph. Vector search sees the FULL vector            │
│    database (all units embedded in 4a) so              │
│    forward + backward references are both               │
│    discoverable.                                        │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "relations" → "done"
  ▼
                    ╔═══════════════════════╗
                    ║  INGESTION COMPLETE   ║
                    ╚═══════════════════════╝
```

## Storage state after ingestion

| Store | What's in it | Written by |
|---|---|---|
| **D1 `documents`** | One row per ingested document | Setup |
| **D1 `structure_nodes`** | Full Phase 2 tree (all nodes) | Setup |
| **D1 `semantic_units`** | One row per unit: id, type, name, content, contentHash, summary, metadata_json, parent links, sourceOrder, embeddingId, status | Phase 3 (create), 4a (summary+embeddingId), 4b (metadata), 5 (status) |
| **D1 `concepts`** | One row per defined term (name, description, aliases) | Phase 4b |
| **D1 `concept_unit`** | Links concepts → units that define them | Phase 4b |
| **D1 `keywords`** | One row per (unit, keyword) pair | Phase 4b |
| **D1 `relations`** | Typed edges: source_id, target_id, relation_type, confidence | Phase 5 |
| **D1 `ingestion_jobs`** | Job state machine (phase, status, detail cursor) | Setup + every batch |
| **Vectorize** | One 1024-dim vector per unit (name+summary+aliases+content) | Phase 4a |
| **R2** | structure.json upload + per-job structure snapshot | Setup |

## Key data dependencies (why the order matters)

1. **Phase 4a must run before Phase 5** — vector-search relationship extraction searches Vectorize, so all units must be embedded first.
2. **Phase 4a must be parent-first** — child summaries use parent summaries as context, so parents must be processed first.
3. **Phase 4b must run after Phase 4a** — metadata extraction uses the pre-generated summary as input context.
4. **Phase 4b must be parent-first** — child metadata uses parent summary/metadata as context.
5. **Phase 5 must run after all units are embedded** — vector search needs the full vector database to find forward and backward references.

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

# Phase 4a — Summary Generation

## Input

- A semantic unit (with optional parent unit context)

## Output

- Concise summary (1-3 sentences)
- Embedding vector (stored in Vectorize)

Implemented in `worker/src/pipeline/summary.ts` (LLM, **70b**, JSON-schema mode)
and `worker/src/pipeline/embeddings.ts` (embedding).

### Parent context

If the unit has a `parentUnitId` (row-tree parent) and/or
`secondaryParentUnitId` (column-tree parent), the parent unit's name + first
800 chars of its **summary** (falling back to raw content if no summary exists
yet) are injected into the prompt. This is critical for orphan/child units and
table data cells whose meaning depends on their parent.

### Parent-first processing order

The summary phase processes parents before children:
`getUnitsByStatusParentFirst` selects `pending` units whose parents are either
null or already past the `pending` status. This ensures the parent's summary is
available when generating a child's summary. Falls back to any pending unit if
no parent-ready units are found (prevents deadlock).

### Embedding

Immediately after generating the summary, the unit is embedded using the lean
embedding document (name + summary + aliases + content, see Phase 6) and
upserted to Vectorize. Embeddings must exist before the relations phase, which
uses vector search for relationship construction.

### Fallback

On LLM failure, the summary falls back to a truncated content slice (240 chars)
so ingestion never blocks.

---

# Phase 4b — Metadata Extraction

## Input

- A semantic unit with its pre-generated summary (with optional parent context)

## Output

- Structured metadata: all 14 relationship fields + keywords + aliases

Implemented in `worker/src/pipeline/metadata.ts` (LLM, **70b**, JSON-schema mode).

### Parent context

Same parent-context injection as Phase 4a: parent name + first 800 chars of
parent **summary** (falling back to content). The unit's own pre-generated
summary is also included in the prompt as context.

### Parent-first processing order

Same as Phase 4a: `getUnitsByStatusParentFirst` selects `summary_done` units
whose parents are already past `summary_done`.

### Metadata fields (all 14 relationship types + search aids)

`defines`, `references`, `requires`, `exceptions`, `modifies`, `modified_by`,
`overrides`, `related_to`, `incompatible_with`, `creates`, `consumes`,
`supersedes`, `example_of`, `part_of`, `keywords`, `aliases`.

Each relationship field is a list of named mechanics, terms, or units that the
current unit relates to in the specified way. These fields become the probe
terms for vector-search-based relationship extraction in Phase 5.

The model is instructed to use only information present in the text, keep the
original language (Russian) for all extracted strings, and use empty arrays
where nothing applies. On failure, the unit gets empty arrays so ingestion
never blocks.

---

# Phase 5 — Relationship Extraction

## Input

- A semantic unit with metadata (all 14 relationship fields)
- The full Vectorize index (all units already embedded in Phase 4a)

## Output

- Relations (typed, confidence-scored)

Implemented in `worker/src/pipeline/relationships.ts`. **Purely vector-search-based**:
for each term in the unit's metadata fields, embed the term + summary and search
Vectorize for matches. Confidence = vector similarity score.

## Relation types

`defines`, `references`, `requires`, `excepts`, `modifies`, `modified_by`,
`overrides`, `related_to`, `incompatible_with`, `creates`, `consumes`,
`supersedes`, `example_of`, `part_of`.

## Why no deterministic edges

The previous implementation included deterministic adjacency edges
(`related_to` between siblings from the same source node) and parent edges
(`part_of` to parentUnitId/secondaryParentUnitId). These have been removed:

- **Parent/child hierarchy** is already encoded directly in the
  `semantic_units` table (`parent_unit_id`, `secondary_parent_unit_id`
  columns). Retrieval's parent/sibling expansion (Phase 8, step 4.5) reads
  these columns directly — it does not use the relations table. Duplicating
  them as graph edges would be redundant.
- **Adjacency edges** had fixed confidence (0.85), which contradicts the
  principle that confidence should reflect real match quality. Units from
  the same source node share section/keywords and will be found by vector
  search through metadata terms when they are genuinely related.

## Vector-search relations

For every term in every metadata field (`defines`, `references`, `requires`,
`exceptions`, `modifies`, `modified_by`, `overrides`, `related_to`,
`incompatible_with`, `creates`, `consumes`, `supersedes`, `example_of`,
`part_of`):
- Construct a short embedding from the term + the unit's summary
- Search Vectorize for matches (topK=100 — cast a wide net)
- Filter matches by `SIMILARITY_THRESHOLD` (0.5)
- Each match above threshold becomes a typed relation with
  **confidence = similarity score** from the vector search
- Self-matches are excluded; terms are deduplicated across fields

Vector search catches fuzzy/semantic matches that exact string matching
misses (e.g. "оглушён" → "оглушение"), and the similarity score provides a
meaningful confidence value rather than a fixed constant.

Results are deduplicated on `(source, target, relation_type)`.

---

# Phase 6 — Embedding Generation

Implemented in `worker/src/pipeline/embeddings.ts`. Embeddings are generated
during the **summary phase** (Phase 4a), immediately after the summary is
produced, so they're available for vector-search-based relationship extraction
in Phase 5.

The embedding is a clean **"what is this unit"** signal. It contains only
fields that describe the unit itself, not its relationships or structural
location — those are handled by graph expansion and parent/sibling expansion
at retrieval time.

```
Name: <name>                        (only when the unit has a real name)
Summary: <summary>                  (parent-context-enriched from Phase 4a)
Aliases: <comma-joined>             (only when aliases exist; available after Phase 4b)
<content>                           (only if it fits the token budget)
```

Note: aliases are extracted in Phase 4b (metadata), which runs *after* the
summary+embedding phase. So the initial embedding does not include aliases.
The reranking step in Phase 8 uses the same `buildEnrichedDocument` function,
which *will* include aliases (loaded from D1) at query time. This is acceptable:
the embedding is for discovery, reranking is for precision.

### Deliberately excluded from the embedding

- **Chapter / section / type** — structural context, handled by parent/sibling
  expansion. Type is stored as Vectorize metadata for future pre-filtering.
- **Keywords** — already used for SQL candidate selection; redundant in the
  embedding.
- **Defines / references / requires / exceptions / modifies / modified_by /
  overrides / related_to / incompatible_with / creates / consumes / supersedes /
  example_of / part_of** — relationship descriptors that become vector-search
  probes in Phase 5. Including them here would double-count with graph expansion
  and dilute the embedding's core semantic signal (Design Principle: "Use
  embeddings only for discovery").

### Token budget

`bge-m3` supports 8192 input tokens; the embedder stays well under it
(`MAX_EMBED_TOKENS = 6000`, estimated at `bytes / 2.5`). If the combined
prefix + original text fits, the full text is included; otherwise only the
name + summary + aliases are embedded (the full content is still available to
answer generation). This keeps every unit within a single embedding call.

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
  `pending → summary_done → metadata_done → relations_done → done`.
  Indexed. Each pipeline phase selects the next batch by status.
- `content_hash` — drives incremental updates. Indexed.

### `relations` columns

`id`, `source_id`, `target_id`, `relation_type`, `confidence`. Indexed on
both `source_id` and `target_id` for graph expansion in either direction.

### Population

- **`populateConceptsAndKeywords`** runs right after Phase 4b metadata: clears
  and re-inserts the unit's keywords, and for each `metadata.defines` term
  upserts a concept (reusing an existing concept by unique `name`) and links
  it to the unit.
- **`populateRelations`** runs in the Phase 5 pass: clears the unit's outgoing
  relations and inserts the new edge set.

---

# Phase 8 — Agentic Retrieval Pipeline

The retrieval pipeline is **agentic and iterative**: a conversational model
routes the query, decomposes it into focused sub-queries, retrieves evidence,
checks sufficiency, and iterates until it has enough information to answer.

Implemented across:
- `worker/src/retrieval/router.ts` — Step 1: router
- `worker/src/retrieval/decompose.ts` — Step 2: query decomposition
- `worker/src/retrieval/query.ts` — Step 3+4: multi-sub-query retrieval + rerank
- `worker/src/retrieval/sufficiency.ts` — Step 5: sufficiency check
- `worker/src/retrieval/answer.ts` — Step 6: answer generation
- `worker/src/retrieval/pipeline.ts` — orchestrator (iterative loop)

## Architecture

```
User question (+ optional conversation history)
  │
  ▼
Step 1: Router (8b)
  - RAG-vs-chat classification
  - Language detection
  - Translation to Russian (rulebook language)
  → { rag, language, russianQuery, chatResponse? }
  If rag=false → direct chat response (8b), return.
  │
  ▼
Step 2: Query decomposition (70b)
  - Break russianQuery into 1-5 focused sub-queries
  - Decide dynamic rerank threshold (0.2-0.5 based on question type)
  → { subQueries[], rerankThreshold }
  │
  ▼
Step 3: Parallel retrieval (per sub-query)
  For each sub-query (in parallel):
    3a. Vector search (topK=100, filter similarity < 0.5)
    3b. Parent/sibling expansion (D1 column reads)
    3c. Graph expansion (2 hops, confidence ≥ 0.5)
    Track which sub-query found each candidate.
  │
  ▼
Step 4: Aggregate + per-sub-query rerank + filter
  - Merge candidates from all sub-queries (dedupe by unit id)
  - Rerank each candidate against the sub-query that found it
  - If found by multiple sub-queries → keep max rerank score
  - Filter by dynamic rerank threshold
  → retrievedUnits[]
  │
  ▼
Step 5: Sufficiency check (70b)
  - Structured checklist: coverage, interactions, contradictions, completeness
  - Evidence grouped by sub-query (helps identify missing aspects)
  → { sufficient, gaps[], followUpQueries[] }
  If insufficient AND iterations < max (3):
    → run followUpQueries through Step 3-4, merge, re-check
  If sufficient OR max iterations reached:
    → proceed to Step 6
  │
  ▼
Step 6: Answer generation (70b)
  - Generate cited answer from evidence
  - Include sub-queries and identified gaps in context
  - Answer in user's detected language
  → { answer, citations, usedUnitIds, language }
```

## Step 1 — Router (`router.ts`, 8b)

The router does triple duty in a single 8b LLM call:

1. **RAG-vs-chat classification** — questions about game mechanics need
   retrieval; greetings, thanks, "rephrase that" requests don't.
2. **Language detection** — identifies the user's language (e.g. "ru", "uk",
   "en"). The answer will be generated in this language.
3. **Translation to Russian** — the rulebook is in Russian, so embeddings and
   reranking work best when the query is in Russian. If the question is already
   in Russian, the translation is a no-op.

If `rag=false`, the router also generates a direct chat response (or the
orchestrator generates one via `generateChatResponse`). This handles
meta-requests like "rephrase your previous answer" using conversation history.

**Fallback**: if the 8b router fails (LLM error), defaults to `rag=true`,
`language="ru"`, `russianQuery=question`. Safer to do unnecessary retrieval
than miss a real rules question.

**Conversation history**: the router receives the last 6 turns (3 user + 3
assistant) from D1 `conversations` table, enabling follow-up questions like
"and what about higher levels?" to be understood in context.

## Step 2 — Query decomposition (`decompose.ts`, 70b)

Breaks the Russian query into 1-5 focused sub-queries for vector search.

A complex question like "How does оглушение interact with провал проверок and
can лечение remove it?" decomposes into:
1. "оглушение состояние и эффекты"
2. "провал проверок и оглушение"
3. "лечение и снятие оглушения"

Simple questions produce a single sub-query (the original unchanged). The
model decides when decomposition is warranted.

**Dynamic rerank threshold**: the decomposer also outputs a `rerankThreshold`
(0.0-1.0) based on question type:
- Precise lookup ("what is the DC for X?") → 0.4-0.5 (only highly relevant)
- Exploratory ("tell me about combat") → 0.2-0.3 (broader set)
- Interaction questions → 0.3-0.4 (medium)

**Max sub-queries**: 5.

**Fallback**: if decomposition fails (LLM error), the orchestrator returns an
error (forces client retry — Q7 decision).

**Conversation history**: the decomposer receives the last 6 turns for context,
enabling follow-up decomposition.

## Step 3 — Parallel retrieval (`query.ts`)

Each sub-query runs independently and in parallel:

### 3a. Vector search
- Embed the sub-query (`bge-m3`, 1024-dim)
- Search Vectorize (`topK=100`)
- Filter: drop matches with similarity < 0.5
- Retrieve full semantic units from D1

**Why topK=100**: cast a wide net. We filter by similarity threshold, not fixed
count. Better to retrieve broadly and filter precisely than to retrieve narrowly
and miss relevant units.

### 3b. Parent/sibling expansion
For each seed unit, fetch both parents (row + column) and all children of each
parent (row siblings + column siblings). This is essential for table units —
retrieving a cell should also retrieve its row/column header and sibling cells
so the answer has full row/column context.

Each expanded unit is tagged with an `expansionRole` (`seed` / `row_parent` /
`col_parent` / `row_sibling` / `col_sibling`).

This is structural context that the embedding doesn't carry — it's read directly
from D1 `semantic_units` columns (`parentUnitId`, `secondaryParentUnitId`).

### 3c. Graph expansion (2 hops, confidence-filtered)
- Read D1 `relations` for the current frontier
- Filter: relations with confidence < 0.5 are skipped
- Add newly discovered units to the candidate pool
- Repeat for 2 hops

Pulls in related mechanics via typed graph edges. If we found the "оглушение"
unit, graph expansion pulls in units that `reference`, `modify`, or `except`
оглушение — even if they didn't match the vector search.

**Follow-up rounds start fresh** (Q8 decision): each follow-up iteration is an
independent retrieval. Already-retrieved unit ids are passed as `existingIds`
to skip them, but graph expansion starts from the new sub-query's seeds, not
from the previous round's frontier.

### Candidate tracking
Each candidate tracks which sub-query(ies) found it (`sourceSubQueries`).
A candidate may be found by multiple sub-queries.

## Step 4 — Aggregate + per-sub-query rerank + filter

### Aggregation
Merge candidates from all sub-queries, deduplicate by unit id. Each candidate
tracks which sub-query(ies) found it.

### Per-sub-query reranking
Each candidate is reranked against the sub-query that found it — **not** against
the full original question.

**Why per-sub-query**: sub-queries are focused probes. A unit that precisely
answers one sub-aspect (e.g. "лечение снимает оглушение") should score HIGH
against its sub-query, not be penalized for not covering the other two aspects
it was never supposed to answer. Reranking against the full question would
score it moderately (covers 1/3 of the query) while a shallow unit mentioning
all three topics would score higher — that's backwards.

**Multi-sub-query candidates**: if a candidate was found by multiple
sub-queries, it gets reranked against each and keeps its **max** score. This
naturally surfaces units relevant to multiple aspects of the question.

**Score comparability**: `bge-reranker-base` outputs normalized scores (0-1).
A highly relevant (query, doc) pair scores 0.7-0.95 regardless of which query.
We're threshold-filtering (drop below threshold), not producing a perfect
global ranking. Small cross-query score differences don't change what passes.

### Filter
Drop candidates with `rerankScore < rerankThreshold` (dynamic, from Step 2).
Sort by descending rerank score.

**No cap on candidate pool** (Q9 decision): candidates are already filtered by
similarity threshold (0.5) before reranking, so the pool is manageable.

## Step 5 — Sufficiency check (`sufficiency.ts`, 70b)

The agentic core — makes retrieval iterative rather than single-pass.

### Structured checklist
The model evaluates evidence against a systematic checklist:

1. **Coverage**: Does the evidence cover every mechanic, term, or concept
   mentioned in the question?
2. **Interactions**: If the question asks about interactions, is there evidence
   describing how they interact (not just definitions of each)?
3. **Contradictions**: Are there contradictions? If so, is there evidence that
   resolves them (e.g. an `overrides`/`supersedes` relation)?
4. **Completeness**: Is there any aspect of the question that the evidence
   doesn't address at all?

If ALL items pass → `sufficient: true`.
If any item fails → `sufficient: false`, describe the gaps, generate focused
follow-up queries (in Russian) to fill those gaps.

### Evidence grouped by sub-query
The sufficiency check sees evidence grouped by source sub-query (Q13 decision),
helping the model identify which aspect is missing coverage.

### Iterative loop
- **Max iterations**: 3 (initial + 2 follow-ups, Q11 decision). Configurable
  via API parameter.
- Each follow-up round runs new sub-queries through Step 3-4, merges with
  existing evidence (dedupe by unit id, keep best rerankScore), and re-checks
  sufficiency.
- If the model says sufficient → break and proceed to answer.
- If the model produces no follow-up queries → break and use what we have.
- If max iterations reached → break and use what we have.

### Fallback
If the sufficiency check LLM call fails, assumes `sufficient: true` (uses
current evidence rather than looping indefinitely).

## Step 6 — Answer generation (`answer.ts`, 70b)

Generates a citation-backed answer from the accumulated evidence.

### Rules
- Use only supplied evidence. Never invent rules or fill gaps with assumptions.
- Every factual claim cites the unit id inline, like `(RULE-00042)`.
- If two units conflict, mention the conflict and which takes precedence (via
  `overrides`/`supersedes` relation), otherwise say it's unresolved.
- If evidence is incomplete or ambiguous, say so explicitly.
- Answer in the user's detected language (from Step 1).

### Context
The answer model receives sub-queries and identified gaps (Q14 decision),
helping it acknowledge what it couldn't find.

### Evidence format
`[ID] (type, section > path, page N)\n<content>`, joined by `---` separators.

### Citations
Used unit ids are extracted from the answer via the `[A-Z]+-\d{5}` / UUID-style
id pattern and intersected with the retrieved set. Each citation includes
`unitId`, `section` (joined ` > `), and `page`.

### Streaming
Two modes (Q15 decision):
- **Complete**: standard JSON response (for bot integrations)
- **Stream**: Server-Sent Events with token chunks (for interactive UI)

## Conversation history

Conversations are stored server-side in D1 `conversations` table (Q2 decision),
keyed by `conversationId`. The client sends `conversationId` with each request;
the server loads history and appends new messages after each query.

**History depth**: last 6 turns (3 user + 3 assistant, Q3 decision) passed to
the router and decomposer. The sufficiency checker and answer generator don't
need history — they work with the current question + evidence.

## Query logging

Every pipeline step is logged to both console.log (visible in `wrangler tail`)
and D1 `query_logs` table (Q19 decision):

| Field | Content |
|-------|---------|
| `id` | `QLOG-<uuid>` |
| `conversation_id` | Optional conversation context |
| `step` | `router` / `decompose` / `retrieve` / `sufficiency` / `answer` |
| `input` | JSON: step input |
| `output` | JSON: step output |
| `duration_ms` | Step execution time |
| `created_at` | Timestamp |

Useful for tuning thresholds, prompts, and analyzing retrieval quality.

## API endpoints

### All-in-one

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/query` | Full agentic pipeline (router → decompose → retrieve → sufficiency loop → answer) |

**Request body**: `{ question, conversationId?, stream?, debug?, graphHops?, maxIterations? }`

**Response (complete mode)**: `{ answer, citations, usedUnitIds, language, debug?, retrievedUnits[] }`

**Response (stream mode)**: Server-Sent Events — `data` events with answer chunks, `result` event with final result.

### Step-by-step (for client-side orchestration)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/query/router` | Step 1 only — returns `{ rag, language, russianQuery, chatResponse? }` |
| POST | `/query/decompose` | Step 2 only — returns `{ subQueries[], rerankThreshold }` |
| POST | `/query/retrieve` | Step 3+4 only — returns `{ retrievedUnits[] }` |
| POST | `/query/sufficiency` | Step 5 only — returns `{ sufficient, gaps[], followUpQueries[] }` |
| POST | `/query/answer` | Step 6 only — returns `{ answer, citations, usedUnitIds, language }` |

Each step endpoint logs to D1 `query_logs` and returns `durationMs`.

**Why both**: client-side orchestration avoids the Workers 30s wall-time limit
for complex multi-iteration queries (Q1 decision). Each step is a separate
Worker invocation. The all-in-one `/query` endpoint is convenient for simple
queries and bot integrations.

## Debug output

When `debug=true` is passed to `/query`, the response includes a `debug` object:

```json
{
  "debug": {
    "router": { "rag": true, "language": "uk", "russianQuery": "..." },
    "decomposition": { "subQueries": ["..."], "rerankThreshold": 0.35 },
    "iterations": [
      {
        "iteration": 1,
        "subQueries": ["..."],
        "candidatesFound": 15,
        "afterRerank": 12,
        "sufficiency": { "sufficient": false, "gaps": ["..."], "followUpQueries": ["..."] }
      },
      {
        "iteration": 2,
        "subQueries": ["..."],
        "candidatesFound": 8,
        "afterRerank": 18,
        "sufficiency": { "sufficient": true, "gaps": [], "followUpQueries": [] }
      }
    ],
    "finalEvidenceCount": 18
  }
}
```

## Cost estimate

| Step | Model | Calls | ~Latency |
|------|-------|-------|----------|
| Router | 8b | 1 | ~1s |
| Decompose | 70b | 1 | ~3s |
| Retrieve (3 sub-queries, parallel) | bge-m3 | 3 embeds + 3 Vectorize queries | ~2s |
| Parent/sibling + graph expansion | — | D1 reads | ~1s |
| Rerank (3 sub-query groups) | bge-reranker | 3 (over ~10-20 candidates each) | ~3s |
| Sufficiency (round 1) | 70b | 1 | ~3s |
| Retrieve (follow-up, if needed) | bge-m3 | 1-2 embeds + queries | ~1s |
| Rerank (follow-up) | bge-reranker | 1 | ~1s |
| Sufficiency (round 2) | 70b | 1 | ~3s |
| Answer | 70b | 1 | ~5s |
| **Total (with 1 follow-up)** | | ~12 LLM calls | **~23s** |

Simple question (no decomposition, no follow-up): ~13s.

---

# Phase 9 — Answer Generation

See Phase 8, Step 6 above. Answer generation is now integrated into the agentic
retrieval pipeline rather than being a separate phase.

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
| POST | `/ingest/cleanup` | Delete all D1/Vectorize/R2 data for a document |
| POST | `/ingest/table` | Single-table test (no DB write) |
| POST | `/ingest/rebuild-relations` | Re-run Phase 5 across the whole KB (incremental) |
| POST | `/query` | Full agentic retrieval pipeline + answer (stream or complete) |
| POST | `/query/router` | Step 1: RAG-vs-chat + language + translation |
| POST | `/query/decompose` | Step 2: query decomposition |
| POST | `/query/retrieve` | Step 3+4: multi-sub-query retrieval + rerank |
| POST | `/query/sufficiency` | Step 5: sufficiency check + follow-up queries |
| POST | `/query/answer` | Step 6: answer generation with citations |

## Staged, whole-document phases

`processIngestionBatch` runs four sequential, whole-document phases (not
interleaved per node):

1. **units** — Phase 3 for every leaf node. Tables are processed one per batch
   (the 70b table LLM calls take several seconds each); rules/notes use the
   configured `batchSize` (default 3, client default 5).
2. **summary** — Phase 4a for every unit: generate a concise summary using the
   70b model, then immediately embed and upsert to Vectorize. Processed
   **parent-first** (`getUnitsByStatusParentFirst`) so parent summaries are
   available when generating child summaries (critical for table cells and
   orphan-linked children). Batch size capped at 2 (70b calls are expensive).
   Falls back to any pending unit if no parent-ready units are found.
3. **metadata** — Phase 4b + concepts/keywords (Phase 7) for every unit.
   Extracts all 14 relationship fields + keywords + aliases using the 70b
   model. Processed **parent-first** (`getUnitsByStatusParentFirst` on
   `summary_done`). Uses the pre-generated summary as input context. Batch
   size capped at 2.
4. **relations** — Phase 5 + graph relations (Phase 7) for every unit.
   Vector-search-based: for each term in the unit's metadata fields, embed
   (term + summary) and search Vectorize. Confidence = similarity score.
   Processed one unit at a time (multiple vector queries per unit). Because
   this phase only starts once the entire document is embedded, vector search
   sees the complete knowledge base — forward and backward references alike.
   No deterministic adjacency or parent edges — parent/child hierarchy is
   read directly from `semantic_units` columns at retrieval time.

Each phase selects its next batch by `status` (`pending` → `summary_done` →
`metadata_done` → `relations_done` → `done`), so progress is resumable across
Worker invocations and crashes. The summary and metadata phases additionally
use parent-first ordering rather than plain status selection.

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
   re-running Phases 3-5 for any node whose existing semantic units all have a
   matching `content_hash`. Only changed nodes are reprocessed (and
   re-summarized/re-embedded/re-graphed).
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
    row refinement, column SPLIT-vs-SIMPLE, summary generation, metadata
    extraction, answers).
12. Keep heuristics language-agnostic and document-agnostic — no hard-coded
    terms, units, attribute names, or version-specific vocabulary.
13. Confidence scores reflect real match quality (vector similarity), not
    fixed constants. Retrieval filters by threshold, not fixed topN.

---

# MVP Deliverables (As-Built)

- DOCX → Markdown conversion (Phase 1, deterministic)
- Structural parser with `group` containers and leaf-size guards (Phase 2,
  deterministic)
- Semantic unit detection with deterministic chunking + LLM orphan resolution
  (Phase 3a)
- Table double-tree unitization: row skeleton → LLM refinement → LLM column
  tree → deterministic overrides → deduplication → unit building (Phase 3b)
- Summary generation with parent context (70b) + immediate embedding (Phase 4a)
- Metadata extraction with all 14 relationship fields + parent context (70b)
  (Phase 4b)
- Vector-search-based relationship extraction: term+summary embedding →
  Vectorize search → confidence = similarity score (Phase 5)
- Lean embedding generation with token-budget management (Phase 6)
- D1 knowledge graph with documents/structure_nodes/ingestion_jobs tables and
  a status state machine (Phase 7)
- Agentic retrieval pipeline: router (RAG/chat + language + translation) →
  query decomposition → multi-sub-query vector search + parent/sibling +
  confidence-filtered graph expansion → per-sub-query reranking → iterative
  sufficiency check with follow-up queries → citation-backed answer (Phase 8)
- Conversation history stored in D1; every pipeline step logged to D1
  `query_logs` + console.log
- Streaming (SSE) and complete (JSON) response modes
- All-in-one `/query` endpoint + step-by-step `/query/*` endpoints for
  client-side orchestration (avoids Workers 30s wall-time limit)
- Chunked, resumable ingestion driven by a client poll loop
- Incremental update pipeline via content hashing
- API security (fail-closed admin, optional query auth)
- Operations tooling: `iterate.sh`, `/ingest/table`,
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
