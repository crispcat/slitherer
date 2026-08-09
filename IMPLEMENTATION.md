# AI Rulebook Knowledge Engine
## Implementation Plan v1.0 (As-Built)

> This document is the **as-built specification**. It has been updated to
> reflect what was actually implemented, replacing the original design
> proposal. The original proposal suggested a Go-based stack with seven
> separate workers and a single LLM-driven parsing pass; the as-built system is
> a Python + TypeScript stack on Cloudflare with a vision-based semantic unit
> extraction pipeline. A vision-language model reads page images directly
> and extracts structured semantic units; and the post-vision phases (summary,
> metadata, relations) run as chunked, resumable batches driven by a client
> poll loop. Every phase below describes
> the implemented behavior, inputs, outputs, and key mechanisms.

## Goal

Build a semantic knowledge engine for a single (~200-page) RPG rulebook using
Cloudflare.

Target rulebook `deorim_rules.pdf` is stored under `rulebooks/` directory.

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

- **Workers** — single Worker hosts both ingestion and query endpoints, plus a
  Queue consumer for vision-based page processing.
- **Workers AI** — LLM extraction, summary/metadata generation, answer
  generation, embeddings, and reranking.
- **Queues** — `vision-ingest` queue processes page images sequentially
  (max_concurrency=1, FIFO) so cross-page continuation state stays consistent.
- **Vectorize** — semantic unit embeddings (cosine, 1024-dim).
- **D1** — knowledge graph, structure tree, ingestion jobs, unit issues.
- **R2** — page images, markdown, sections metadata, per-job snapshots.

## Implementation languages

- **TypeScript** (`worker/`) — Phases 1-8. Runs on Cloudflare Workers.
- **System tools** — `poppler-utils` (`pdftoppm` for PDF→PNG rendering,
  `pdfinfo` for page count). No Python needed.

## Models (configured in `worker/wrangler.toml`)

| Binding | Model | Used for |
|---------|-------|----------|
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Summary-phase embeddings, retrieval query embeddings (1024-dim, 8192 token input) |
| `EXTRACTION_MODEL` | `@cf/zai-org/glm-4.7-flash` | Phase 3a summary generation, Phase 7 router (RAG/chat + language + translation), chat responses |
| `REASONING_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Phase 3b metadata extraction, Phase 7 decomposition, Phase 7 sufficiency check |
| `ANSWER_MODEL` | `@cf/openai/gpt-oss-120b` | Phase 7 answer generation with citations |
| `RERANK_MODEL` | `@cf/baai/bge-reranker-base` | Phase 7 per-sub-query reranking |
| `VISION_MODEL` | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Phase 2 vision-based semantic unit extraction from page images |

The extraction model (GLM-4.7-flash) handles high-volume, low-latency tasks:
summary generation, routing, and chat. The reasoning model (Qwen3-30B MoE,
3B active) handles medium-complexity extraction and evaluation: metadata
extraction, query decomposition, and sufficiency checks. The answer model
(GPT-OSS-120B) is reserved for the single highest-quality task: generating
the final user-facing answer with citations. The vision model (Mistral Small
3.1 24B) reads page images and extracts structured semantic units directly.

---

# System Overview

Two pipelines run inside one Worker:

1. **Ingestion Pipeline** (`/ingest*` endpoints + Queue consumer)
   - Parses the source document into markdown + sections metadata (Python, local).
   - Renders PDF pages to PNG images (Python, local).
   - Uploads page images, markdown, and sections to R2.
   - Enqueues all pages to the vision Queue (max_concurrency=1, FIFO).
   - Extracts semantic units from each page image using a vision-language model,
     with cross-page continuation state for section paths and parent linking.
   - Generates summaries (extraction model, parent-context-enriched) and embeds them.
   - Extracts all 14 metadata relationship fields (reasoning model).
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

The vision phase is **Queue-driven**: `POST /ingest` enqueues all pages, and
the Queue consumer processes them sequentially (max_concurrency=1 ensures
continuation state consistency). Post-vision phases (summary, metadata,
relations) are **chunked and resumable**: a client poll loop calls
`POST /ingest/step` repeatedly, each call advancing one batch within a single
Worker invocation's CPU budget. Job state is persisted in D1
(`ingestion_jobs`).

---

# Ingestion Data Flow

What data gets extracted, created, upserted, and modified at every stage, and why.

```
PDF (rulebooks/deorim_rules.pdf)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  PAGE RENDERING (local, pdftoppm)                       │
│  poppler-utils                                          │
│                                                         │
│  INPUT:   PDF file                                      │
│  RENDERS: each page → PNG image at 200 DPI              │
│  CREATES:  local temp dir: 1.png, 2.png, ... N.png      │
│    (uploaded to R2 as pages/{documentId}/{page}.png)    │
│  WHY: Vision model needs page images.                   │
└─────────────────────────────────────────────────────────┘
  │
  │  Page images uploaded to R2 via PUT /ingest/r2/{key}
  │  (unchanged images skipped via hash check)
  │  POST /ingest enqueues all pages to the vision Queue
  ▼
┌─────────────────────────────────────────────────────────┐
│  INGESTION SETUP (Worker)                               │
│  ingest.ts → startIngestion()                           │
│                                                         │
│  CREATES: D1 documents row (id, source_path,            │
│    ingested_at)                                         │
│  CREATES: D1 ingestion_jobs row (id, document_id,       │
│    phase="vision", status="running", detail JSON        │
│    with totalPages, pagesProcessed, continuation)       │
│  ENQUEUES: all pages to VISION_QUEUE (FIFO,             │
│    max_concurrency=1)                                   │
│  WHY: Register the document, start the                  │
│    resumable job state machine, begin page              │
│    processing.                                          │
└─────────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 2 — Vision-Based Unit Extraction (Worker,        │
│  Queue consumer)                                        │
│  ingest.ts → processVisionPage()                        │
│  vision_extract.ts + vision_verify.ts                   │
│                                                         │
│  FOR EACH PAGE (sequential, Queue-driven):              │
│                                                         │
│  Step 1 — Fetch inputs:                                 │
│    READS:  D1 ingestion_jobs (job detail + continuation)│
│    READS:  R2 pages/{docId}/{page}.png (page image)     │
│    READS:  R2 markdown/{docId}.md (ground truth text)   │
│    READS:  R2 sections/{docId}.json (section metadata)  │
│                                                         │
│  Step 2 — Vision extraction (vision_extract.ts):        │
│    LLM (vision): reads page image, returns              │
│      structured JSON: units[] (includes Image           │
│      type for diagrams/maps with text descriptions      │
│      as content)                                        │
│      (NO continuation — that's computed below)          │
│    INPUT:  page image (base64), page number,            │
│      continuation from previous page                    │
│      (sectionPath, lastUnitName, lastUnitContent,       │
│       lastContainers)                                   │
│    OUTPUT: VisionUnit[] with type, name, content,       │
│      section, parentName (type can be Rule,             │
│      Table, or Image — Image units have a text          │
│      description as content)                            │
│    WHY: Vision model reads the page directly —          │
│      no deterministic structure parsing needed.         │
│      Tables, lists, headings, and mixed                 │
│      layouts are all handled by the same model.         │
│                                                         │
│  Step 3 — Normalize (vision_verify.ts):                 │
│    MAPS:   unknown unit types to "Rule"                 │
│    INHERITS: sections from parent units when            │
│      a child has an empty section path                  │
│    (IDs assigned in Step 2 via UUID)                    │
│                                                         │
│  Step 4 — Store units:                                  │
│    UPSERTS: D1 semantic_units rows with                 │
│      document_id, source_node_id="page-{N}",            │
│      status="pending", page=pageNumber,                 │
│      secondary_parent_unit_id=null                       │
│                                                         │
│  Step 5 — Compute continuation + update job state:      │
│    COMPUTES: continuation from extracted units          │
│      (deterministic — NOT from LLM output):             │
│      sectionPath = last unit's section,                 │
│      lastUnitName/Content = last unit,                  │
│      lastContainers = units with children (up to 4)     │
│    MODIFIES: D1 ingestion_jobs detail —                │
│      pagesProcessed++, unitsProcessed += N,             │
│      continuation = computed state                      │
│    WHY: Next page needs cross-page context              │
│      to link units that span page boundaries.           │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "vision" → "summary"
  │  (when pagesProcessed >= totalPages)
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 3a — Summary Generation + Embedding (Worker)     │
│  ingest.ts → stepSummaryPhase()                         │
│  summary.ts + embeddings.ts                             │
│                                                         │
│  READS:   D1 semantic_units (status="pending",          │
│    via getUnitsByStatus)                      │
│  READS:   D1 semantic_units (parent units — name only)  │
│  READS:   D1 semantic_units (children — names only,     │
│    if aggregate content < 3000 chars)                   │
│                                                         │
│  FOR EACH UNIT (batch size ≤ 2):                        │
│                                                         │
│  Step 1 — Summary (summary.ts):                         │
│    LLM (extraction): generates 1-3 sentence summary     │
│    INPUT:  unit.name, unit.content (full),              │
│      parent name (not content/summary),                 │
│      children names (if aggregate content               │
│      < 3000 chars)                                      │
│    PRECEDENCE: unit's own name + content take           │
│      precedence over parent/children context            │
│    OUTPUT: summary string                               │
│    WHY: Self-contained summary that knows               │
│      where the unit sits in the hierarchy               │
│      without being overwhelmed by parent/children.      │
│                                                         │
│  Step 2 — Embedding (embeddings.ts):                    │
│    EXTRACTS: buildEnrichedDocument(unit) →              │
│      "Name: <name>\nSummary: <summary>\n<content>"      │
│      (content included only if fits 6000 token budget)  │
│    LLM (bge-m3): embeds the document → 1024-dim vector  │
│    WHY: Clean "what is this unit" signal. No            │
│      relationship descriptors or structural             │
│      context — those are handled by graph               │
│      expansion at retrieval time.                       │
│                                                         │
│  UPSERTS: Vectorize vectors (id=unit.id, values=vector, │
│    metadata: name)                                      │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.summary = generated summary                   │
│    - unit.status = "summary_done"                       │
│    (vector id = unit.id, stored in Vectorize)           │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │             │
│                                                         │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "summary" → "metadata"
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 3b — Metadata Extraction (Worker)                │
│  ingest.ts → stepMetadataPhase()                        │
│  metadata.ts                                            │
│                                                         │
│  READS:   D1 semantic_units (status="summary_done")     │
│                                                         │
│  FOR EACH UNIT (batch size ≤ 2):                        │
│                                                         │
│  Step 1 — Metadata (metadata.ts):                       │
│    LLM (reasoning): extracts structured metadata        │
│    INPUT:  unit.name, unit.summary, unit.content        │
│      (no parent/children context — just the unit)       │
│    OUTPUT: UnitMetadata JSON with 14 relationship       │
│      fields + aliases:                                  │
│      defines, references, requires, exceptions,         │
│      modifies, modified_by, overrides, related_to,      │
│      incompatible_with, creates, consumes,              │
│      supersedes, example_of, part_of,                   │
│      aliases                                            │
│    WHY: The 14 relationship fields become probe         │
│      terms for vector-search-based relationship         │
│      extraction in Phase 4. Aliases aid                 │
│      embedding quality (alternate names).               │
│                                                         │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.metadata = extracted metadata JSON            │
│    - unit.status = "metadata_done"                      │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │
└─────────────────────────────────────────────────────────┘
  │  phase transition: "metadata" → "relations"
  ▼
┌─────────────────────────────────────────────────────────┐
│  PHASE 4 — Relationship Extraction (Worker)             │
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
│    EMBEDS:  each unique bare term (no source-unit       │
│      summary) → 1024-dim vector (bge-m3)                │
│    SEARCHES: Vectorize for each term vector             │
│      (topK=100, returnMetadata)                         │
│    KEEPS:   top 5 matches per term (TOP_K_MATCHES)      │
│      after filtering self-matches. No fixed             │
│      threshold — empirical testing showed the           │
│      correct target always ranks #1, so top-K           │
│      guarantees recall.                                 │
│    CREATES: typed relations — one per (term,            │
│      match, relationType) with                          │
│      confidence = similarity score from vector          │
│      search (bare term vs. candidate name+summary+      │
│      content)                                           │
│    SKIPS:   self-matches (match.id === unit.id)         │
│    WHY: Bare-term retrieval gives a pure signal —       │
│      the same term always produces the same query       │
│      vector regardless of which source unit mentions    │
│      it. No source-unit summary pollutes the query.     │
│      Vector search catches fuzzy/semantic matches       │
│      ("оглушён" → "оглушение") that exact string        │
│      matching misses. Confidence = real match           │
│      quality, so weak edges are naturally               │
│      deprioritized in graph traversal. Deterministic    │
│      parent_of/child_of edges are inserted              │
│      separately (Step 2 above) from the known           │
│      parentUnitId — not inferred by the LLM.            │
│                                                         │
│  DEDUP:    relations deduplicated on                    │
│      (source, target, relation_type)                    │
│                                                         │
│  Step 2 — Deterministic hierarchy relations:            │
│    INSERTS: D1 relations — parent_of (parent → child)   │
│      and child_of (child → parent), confidence=1.0      │
│    WHY: Parent-child hierarchy is known from            │
│      parentUnitId — no need for LLM to infer it.        │
│                                                         │
│  CLEARS:  D1 relations rows where source_id = unit.id   │
│  INSERTS: D1 relations rows (id, source_id,             │
│    target_id, relation_type, confidence)                │
│  MODIFIES: D1 semantic_units:                           │
│    - unit.status = "relations_done"                     │
│  MODIFIES: D1 ingestion_jobs (phase progress)           │
│  WHY: Build a typed, confidence-scored knowledge        │
│    graph. Vector search sees the FULL vector            │
│    database (all units embedded in 3a) so               │
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
| **D1 `structure_nodes`** | Legacy table (no longer populated by the vision pipeline) | — |
| **D1 `semantic_units`** | One row per unit: id, document_id, type, name, page, section, content, contentHash, summary, metadata_json, parent links, sourceOrder, embeddingId, status | Phase 2 (create), 3a (summary+embeddingId), 3b (metadata), 4 (status) |
| **D1 `relations`** | Typed edges: source_id, target_id, relation_type, confidence | Phase 4 |
| **D1 `ingestion_jobs`** | Job state machine (phase, status, detail with pagesProcessed/continuation) | Setup + every page/batch |
| **Vectorize** | One 1024-dim vector per unit (name+summary+aliases+content) | Phase 3a |
| **R2** | Page images, markdown, sections metadata, per-job snapshots | Client upload (parse + render) |

## Key data dependencies (why the order matters)

1. **Phase 2 (vision) must complete before Phase 3a (summary)** — all units must exist before summaries are generated.
2. **Phase 2 pages must be processed sequentially** — cross-page continuation state (section path, last unit content, containers) must be consistent. The Queue's max_concurrency=1 guarantees this.
3. **Phase 3a must run before Phase 4** — vector-search relationship extraction searches Vectorize, so all units must be embedded first.
4. **Phase 3b must run after Phase 3a** — metadata extraction uses the pre-generated summary as input.
5. **Phase 4 must run after all units are embedded** — vector search needs the full vector database to find forward and backward references.
6. **Phase 4 must run after all units are embedded** — vector search needs the full vector database to find forward and backward references.

---

# Phase 1 — PDF Rendering

## Input

- PDF file

## Output

- PNG page images (one per page, 200 DPI)

Implemented in the ingest script (`ingest.mjs`) using `pdftoppm` (from
poppler-utils) for page rendering and `pdfinfo` for page count. No Python
or parser needed — the vision model reads page images directly.

Page images are uploaded to R2 (`pages/{documentId}/{page}.png`). Unchanged
images are skipped via a hash check (SHA-256 stored in R2 customMetadata) to
avoid redundant uploads on re-ingest.

---

# Phase 2 — Vision-Based Unit Extraction

## Input

- Page image (PNG, from R2)
- Page number
- Continuation state from previous page (section path, last unit name/content,
  last containers)

## Output

- Semantic units (typed, identified, with section paths and parent links)
- Continuation state for the next page (computed deterministically from
  extracted units — not produced by the LLM)

Implemented in `worker/src/pipeline/vision_extract.ts` (vision model call) and
`worker/src/pipeline/vision_verify.ts` (normalization). Runs as
a **Queue consumer** with `max_concurrency=1` so pages are processed
sequentially in FIFO order, ensuring continuation state consistency.

## Vision extraction (`vision_extract.ts`)

The vision model receives a page image and returns structured JSON with `units`
(semantic units). Visual elements (diagrams, charts, maps) are extracted as
units with type `Image` — the `name` is a short label and the `content` is a
comprehensive text description of what the visual depicts. This means images
go through the same pipeline as any other unit (summary, metadata, embedding,
relations). The continuation state for the next page is **computed
deterministically** from the extracted units — the LLM does not produce it.

```json
{
  "units": [
    {
      "type": "Rule",
      "name": "Контроль",
      "content": "...",
      "parentName": null,
      "section": ["II. КРАСНОЕ ЗОЛОТО", "2.1. Создание персонажа"]
    },
    {
      "type": "Image",
      "name": "Поле боя",
      "content": "A grid-based battlefield diagram showing...",
      "parentName": null,
      "section": ["3. СТАЛЬ", "3.2. Поле боя"]
    }
  ]
}
```

The continuation state for the next page is computed deterministically from
the extracted units:

```json
{
  "sectionPath": ["II. КРАСНОЕ ЗОЛОТО", "2.1. Создание персонажа"],
  "lastUnitName": "Контроль",
  "lastUnitContent": "...last 100 chars of the last unit...",
  "lastContainers": [
    { "name": "Основные:", "content": "..." },
    { "name": "Недостатки", "content": "..." }
  ]
}
```

### Unit types

Three types are emitted by the vision model:

- **`Rule`** — any retrievable piece of rules content. This is the default for
  ALL content: abilities, spells, weapons, traits, actions, definitions,
  modifiers, examples, category labels, etc. A Rule can serve as a container
  (has children but no content of its own — a category label grouping related
  items).
- **`Table`** — a container for tabular data where rows have a meaningful
  relationship across columns. The table header is a `Table` unit, each row is
  a `Rule` child.
- **`Image`** — a visual element that carries rules information (diagrams,
  charts, battlefield maps). The `name` is a short label, the `content` is a
  comprehensive text description of what the visual depicts. Image units go
  through the same pipeline as any other unit (summary, metadata, embedding,
  relations).

The old pipeline had 17 fine-grained types (Attribute, Skill, Trait, Ability,
etc.). The vision pipeline simplifies to 3 types because the vision model
handles granularity and hierarchy directly — it doesn't need a deterministic
type system to drive chunking.

### Parent-child hierarchy

The vision model links units via `parentName` (the name of the parent unit on
the same page). Root units have `parentName: null`. The parent must appear
before the child in the output. `resolveParentNames` converts `parentName` to
`parentId` by looking backward through the current page's units.

Cross-page parent linking is handled by the vision model via the continuation
context's `lastContainers` — the model receives the name and content of up to
4 recent container units from previous pages, and is instructed to use them
when a page starts with table rows or list items that belong to a container
from the previous page. However, `resolveParentNames` only resolves parents
within the current page; if the model outputs a `parentName` from a previous
page, the `parentId` will be null (orphaned). The batch `extractPages`
function (used by the `/ingest/vision/test` endpoint) performs global
cross-page parent resolution, but the Queue-driven `processVisionPage` does
not. This is a known limitation — cross-page orphans can be manually fixed
via the debug frontend's unit editor.

### Continuation state

Cross-page context is passed between pages via `VisionContinuation`. This is
**computed deterministically** from the extracted units after each page — the
LLM does not produce it. The system derives:

- `sectionPath` — the last unit's section path (carried forward if no new
  heading appears on the next page)
- `lastUnitName` — name of the last unit on the page
- `lastUnitContent` — last ~100 chars of the last unit (for detecting
  truncated units that span page boundaries)
- `lastContainers` — top N (default 4, configurable via
  `vision.continuationContainerCount`) of a container stack maintained
  across pages. A unit is a container if another unit on the same page
  references it as `parentName`. New containers are pushed onto the
  stack (re-pushed to top if already present); the top N are peeked for
  the next page's continuation.

## Normalization (`vision_verify.ts`)

After extraction, units are normalized by `normalizeUnits`:

1. **Type mapping** — unknown types are mapped to `Rule`.
2. **Section inheritance** — if a child unit has an empty section path, it
   inherits the section from its parent.

No verification or issue detection is performed — the vision model output is
trusted as-is.

IDs are assigned during extraction (in `vision_extract.ts`), not during
normalization — each unit gets a UUID-based ID (`RULE-<uuid>` or
`TABLE-<uuid>`, depending on type). Parent names
are resolved to parent IDs (via `resolveParentNames`) immediately after ID
assignment, so the parent must appear before the child in the output.

## Identifiers

Each semantic unit receives a deterministic identifier of the form
`RULE-<sha256(documentId:pageNumber:sourceOrder)>` or
`TABLE-<sha256(...)>` (depending on type). The deterministic hash ensures
that re-processing the same page (e.g. Queue redelivery) produces the same
IDs, so upserts overwrite instead of creating duplicates. The initial
UUID-based IDs from the vision model are replaced in `processVisionPage`
before storing to D1.

Other IDs in the system (relations, jobs, documents) use
the `nextId(prefix)` pattern with `crypto.randomUUID()` (e.g. `REL-<uuid>`).

Each unit also carries:

- `documentId` — the document it belongs to (enables direct cleanup without
  joining through `structure_nodes`)
- `sourceNodeId` — set to `page-{pageNumber}` (legacy field, kept for schema
  compatibility)
- `sourceOrder` — position within the page (for adjacency)
- `parentUnitId` — primary parent unit (for hierarchy)
- `secondaryParentUnitId` — secondary parent (always null in the vision
  pipeline; kept for schema compatibility with the old column-tree pipeline)
- `contentHash` — SHA-256 of content

---

# Phase 3a — Summary Generation

## Input

- A semantic unit (name + content)
- Parent unit name (not content/summary)
- Children unit names (if aggregate content under threshold)

## Output

- Concise summary (1-3 sentences)
- Embedding vector (stored in Vectorize)

Implemented in `worker/src/pipeline/summary.ts` (LLM, **extraction model**,
JSON-schema mode) and `worker/src/pipeline/embeddings.ts` (embedding).

### Context

The LLM receives three pieces of context:

1. **Unit's own name + content** (full) — this takes **precedence** over all
   other context. The summary should primarily describe what this unit says.
2. **Parent name** — just the name, not the parent's summary or content.
   Provides hierarchy framing (where this unit sits) without overwhelming the
   summary with the parent's meaning.
3. **Children names** — just names, never content. Included only if the
   aggregate children content is under `parentContext.childrenMaxChars`
   (default 3000 chars); otherwise skipped entirely to avoid flooding the
   prompt for large lists/tables.

The prompt explicitly instructs the LLM that the unit's own name and content
take precedence — parent and children names are framing context, not the
subject of the summary.

### Processing order

The summary phase processes units in arbitrary order via `getUnitsByStatus`
(no parent-first ordering needed, since only parent names are used — not
parent summaries). Phase 3b (metadata) also no longer needs parent-first
ordering since it only uses the unit's own name + summary + content.

### Embedding

Immediately after generating the summary, the unit is embedded using the lean
embedding document (name + summary + aliases + content, see Phase 5) and
upserted to Vectorize. Embeddings must exist before the relations phase, which
uses vector search for relationship construction.

### Fallback

On LLM failure, the summary falls back to a truncated content slice (240 chars)
so ingestion never blocks.

---

# Phase 3b — Metadata Extraction

## Input

- A semantic unit: name, summary, content (no parent/children context)

## Output

- Structured metadata: 14 relationship fields + aliases
- Deterministic `parent_of` / `child_of` relations

Implemented in `worker/src/pipeline/metadata.ts` (LLM, **reasoning model**,
JSON-schema mode).

### LLM input

The LLM receives only the unit's own `name`, `summary`, and `content`. No
parent or children context is passed — the LLM should extract relationships
from the unit's own text, not from structural context.

### Deterministic hierarchy relations

After the LLM extracts metadata, the system inserts deterministic
`parent_of` and `child_of` relations based on `parentUnitId`:

- `parent_of`: parent unit → child unit (confidence 1.0)
- `child_of`: child unit → parent unit (confidence 1.0)

These are not extracted by the LLM — they're derived directly from the unit
hierarchy. The `clearRelationsForSource` function (used by the Phase 4
relations re-run) excludes `parent_of`/`child_of` from deletion so re-running
relations doesn't wipe the hierarchy.

### Metadata fields (14 LLM-extracted types + search aids)

`defines`, `references`, `requires`, `exceptions`, `modifies`, `modified_by`,
`overrides`, `related_to`, `incompatible_with`, `creates`, `consumes`,
`supersedes`, `example_of`, `part_of`, `aliases`.

Each relationship field is a list of named mechanics, terms, or units that the
current unit relates to in the specified way. These fields become the probe
terms for vector-search-based relationship extraction in Phase 4.

The model is instructed to use only information present in the text, keep the
original language (Russian) for all extracted strings, and use empty arrays
where nothing applies. On failure, the unit gets empty arrays so ingestion
never blocks.

---

# Phase 4 — Relationship Extraction

## Input

- A semantic unit with metadata (all 14 relationship fields)
- The full Vectorize index (all units already embedded in Phase 3a)

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
  columns). Retrieval's parent/sibling expansion (Phase 7, step 4.5) reads
  these columns directly — it does not use the relations table. Duplicating
  them as graph edges would be redundant.
- **Adjacency edges** had fixed confidence (0.85), which contradicts the
  principle that confidence should reflect real match quality. Units from
  the same source node share section and will be found by vector
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

# Phase 5 — Embedding Generation

Implemented in `worker/src/pipeline/embeddings.ts`. Embeddings are generated
during the **summary phase** (Phase 3a), immediately after the summary is
produced, so they're available for vector-search-based relationship extraction
in Phase 4.

The embedding is a clean **"what is this unit"** signal. It contains only
fields that describe the unit itself, not its relationships or structural
location — those are handled by graph expansion and parent/sibling expansion
at retrieval time.

```
Name: <name>                        (only when the unit has a real name)
Summary: <summary>                  (parent-context-enriched from Phase 3a)
Aliases: <comma-joined>             (only when aliases exist; available after Phase 3b)
<content>                           (only if it fits the token budget)
```

Note: aliases are extracted in Phase 3b (metadata), which runs *after* the
summary+embedding phase. So the initial embedding does not include aliases.
The reranking step in Phase 7 uses the same `buildEnrichedDocument` function,
which *will* include aliases (loaded from D1) at query time. This is acceptable:
the embedding is for discovery, reranking is for precision.

### Deliberately excluded from the embedding

- **Chapter / section / type** — structural context, handled by parent/sibling
  expansion.
- **Keywords** — already used for SQL candidate selection; redundant in the
  embedding.
- **Defines / references / requires / exceptions / modifies / modified_by /
  overrides / related_to / incompatible_with / creates / consumes / supersedes /
  example_of / part_of** — relationship descriptors that become vector-search
  probes in Phase 4. Including them here would double-count with graph expansion
  and dilute the embedding's core semantic signal (Design Principle: "Use
  embeddings only for discovery").

### Token budget

`bge-m3` supports 8192 input tokens; the embedder stays well under it
(`MAX_EMBED_TOKENS = 6000`, estimated at `bytes / 2.5`). If the combined
prefix + original text fits, the full text is included; otherwise only the
name + summary + aliases are embedded (the full content is still available to
answer generation). This keeps every unit within a single embedding call.

### Storage

Embeddings are upserted to Vectorize with metadata (`name`). The vector id
equals the unit id.

---

# Phase 6 — Knowledge Graph

Implemented in `worker/schema.sql` (D1 schema), `worker/src/pipeline/graph.ts`
(population), and `worker/src/utils/db.ts` (access).

## D1 schema

Beyond the original `semantic_units` / `relations` tables, the as-built
schema adds:

- **`documents`** — registers each ingested document (`id`, `source_path`,
  `ingested_at`).
- **`structure_nodes`** — legacy table from the old deterministic parser
  pipeline. No longer populated by the vision pipeline, but kept for schema
  compatibility.
- **`ingestion_jobs`** — resumable job state (`id`, `document_id`, `phase`,
  `status`, `detail`, timestamps). `detail` is a JSON blob carrying
  `totalPages`, `pagesProcessed`, `unitsProcessed`, `continuation`, and
  `phase` progress.
- **`conversations`** — query conversation history (`id`, `messages` JSON,
  timestamps).
- **`query_logs`** — per-step query pipeline logs (`id`, `conversation_id`,
  `step`, `input`, `output`, `duration_ms`, timestamp).
- **`debug_logs`** — ingestion + retrieval pipeline events (`id`, `level`,
  `source`, `message`, `data` JSON, timestamp).

### `semantic_units` columns

`id`, `document_id`, `source_node_id`, `type`, `name`, `page`, `section`
(JSON array), `content`, `content_hash`, `summary`, `metadata_json`,
`parent_unit_id`, `secondary_parent_unit_id`, `source_order`, `embedding_id`,
`status`, `updated_at`.

- `document_id` — the document this unit belongs to. Enables direct cleanup
  and queries without joining through `structure_nodes`.
- `parent_unit_id` / `secondary_parent_unit_id` — parent units (foreign keys
  to `semantic_units`). Indexed.
- `status` — the ingestion state machine:
  `pending → summary_done → metadata_done → relations_done → done`.
  Indexed. Each pipeline phase selects the next batch by status.
- `content_hash` — SHA-256 of content. Indexed.

### `relations` columns

`id`, `source_id`, `target_id`, `relation_type`, `confidence`. Indexed on
both `source_id` and `target_id` for graph expansion in either direction.

### Population

- **`populateRelations`** runs in the Phase 4 pass: clears the unit's outgoing
  relations and inserts the new edge set.

---

# Phase 7 — Agentic Retrieval Pipeline

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
Step 1: Router (extraction)
  - RAG-vs-chat classification
  - Language detection
  - Translation to Russian (rulebook language)
  → { rag, language, russianQuery, chatResponse? }
  If rag=false → direct chat response (extraction), return.
  │
  ▼
Step 2: Query decomposition (reasoning)
  - Break russianQuery into 1-5 focused sub-queries
  - Decide dynamic rerank threshold (0.2-0.5 based on question type)
  → { subQueries[], rerankThreshold }
  │
  ▼
Step 3: Parallel retrieval (per sub-query)
  For each sub-query (in parallel):
    3a. Vector search (topK=10, no similarity threshold)
    3b. Parent/sibling/children expansion (D1 column reads)
    3c. Graph expansion (2 hops)
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
Step 5: Sufficiency check (reasoning)
  - Structured checklist: coverage, interactions, contradictions, completeness
  - Evidence grouped by sub-query (helps identify missing aspects)
  → { sufficient, gaps[], followUpQueries[] }
  If insufficient AND iterations < max (3):
    → run followUpQueries through Step 3-4, merge, re-check
  If sufficient OR max iterations reached:
    → proceed to Step 6
  │
  ▼
Step 6: Answer generation (answer)
  - Generate cited answer from evidence
  - Include sub-queries and identified gaps in context
  - Answer in user's detected language
  → { answer, citations, usedUnitIds, language }
```

## Step 1 — Router (`router.ts`, extraction model)

The router does triple duty in a single extraction-model LLM call:

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

**Fallback**: if the router fails (LLM error), defaults to `rag=true`,
`language="ru"`, `russianQuery=question`. Safer to do unnecessary retrieval
than miss a real rules question.

**Conversation history**: the router receives the last 6 turns (3 user + 3
assistant) from D1 `conversations` table, enabling follow-up questions like
"and what about higher levels?" to be understood in context.

## Step 2 — Query decomposition (`decompose.ts`, reasoning model)

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

## Step 5 — Sufficiency check (`sufficiency.ts`, reasoning model)

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

## Step 6 — Answer generation (`answer.ts`, answer model)

Generates a citation-backed answer from the accumulated evidence.

### Rules
- Use only supplied evidence. Never invent rules or fill gaps with assumptions.
- Every factual claim cites the unit id inline, like `(RULE-a1b2c3d4-...)`.
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
| Router | extraction | 1 | ~1s |
| Decompose | reasoning | 1 | ~3s |
| Retrieve (3 sub-queries, parallel) | bge-m3 | 3 embeds + 3 Vectorize queries | ~2s |
| Parent/sibling + graph expansion | — | D1 reads | ~1s |
| Rerank (3 sub-query groups) | bge-reranker | 3 (over ~10-20 candidates each) | ~3s |
| Sufficiency (round 1) | reasoning | 1 | ~3s |
| Retrieve (follow-up, if needed) | bge-m3 | 1-2 embeds + queries | ~1s |
| Rerank (follow-up) | bge-reranker | 1 | ~1s |
| Sufficiency (round 2) | reasoning | 1 | ~3s |
| Answer | answer | 1 | ~5s |
| **Total (with 1 follow-up)** | | ~12 LLM calls | **~23s** |

Simple question (no decomposition, no follow-up): ~13s.

---

# Phase 8 — Answer Generation

See Phase 7, Step 6 above. Answer generation is integrated into the agentic
retrieval pipeline rather than being a separate phase.

---

# Ingestion Architecture

The original proposal described seven separate workers (Ingestion, Parser,
Metadata, Relationship, Embedding, Graph, Query). The as-built system is a
**single Worker** with HTTP endpoints + a Queue consumer, driven by a client
poll loop for post-vision phases.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest` | Start ingestion (`documentId`, `sourcePath`, `totalPages`) → enqueues pages to vision Queue |
| PUT | `/ingest/r2/:key` | Upload binary data to R2 (page images, markdown, sections) |
| POST | `/ingest/step` | Advance one batch for summary/metadata/relations phases (`jobId`, `batchSize?`, `stage?`) |
| GET | `/ingest/status` | Job state |
| POST | `/ingest/cleanup` | Delete all D1/Vectorize/R2 data for a document |
| POST | `/ingest/reset-stage` | Reset a specific stage (vision/summary/metadata/relations) to clean state. For `vision`, also re-enqueues all pages to the vision Queue (requires `jobId` in body) |
| POST | `/ingest/vision/test` | Test vision extraction on a single page (optional DB write) |
| POST | `/ingest/rebuild-relations` | Re-run Phase 4 across the whole KB (incremental) |
| GET | `/debug/sources` | List source nodes with unit counts (for tree viewer) |
| GET | `/debug/tree` | Semantic unit hierarchy (flat or tree format) |
| GET | `/debug/unit/:id` | Full unit details (metadata, relations, parent/child) |
| PUT | `/debug/unit/:id` | Edit unit fields (content, name, section, type, parentId) |
| GET | `/debug/issues` | List unit issues for human review (filter by status/type/documentId) |
| POST | `/debug/issues/:id/resolve` | Mark an issue as resolved (optional corrected content) |
| POST | `/debug/issues/:id/dismiss` | Mark an issue as dismissed |
| GET | `/debug/logs` | Debug log entries (poll with `since` parameter) |
| DELETE | `/debug/logs` | Clear all debug log entries |
| POST | `/query` | Full agentic retrieval pipeline + answer (stream or complete) |
| POST | `/query/verify` | Validate API key without doing any work (client preflight) |
| POST | `/query/router` | Step 1: RAG-vs-chat + language + translation |
| POST | `/query/decompose` | Step 2: query decomposition |
| POST | `/query/retrieve` | Step 3+4: multi-sub-query retrieval + rerank |
| POST | `/query/sufficiency` | Step 5: sufficiency check + follow-up queries |
| POST | `/query/answer` | Step 6: answer generation with citations |

## Queue consumer

The Worker has a `queue()` handler that processes messages from the
`VISION_QUEUE` Queue. Each message contains `{ jobId, documentId, pageNumber }`.
The consumer calls `processVisionPage()` which fetches the page image from R2,
extracts units via the vision model, verifies against markdown, stores units +
issues in D1, and updates the job's continuation state.

**max_concurrency=1** ensures pages are processed sequentially in FIFO order,
so continuation state (section path, last unit, containers) is always
consistent between pages. **max_batch_size=1** processes one page per message.
**max_retries=3** allows transient failures to be retried.

## Staged, whole-document phases

The vision phase is **Queue-driven** — `POST /ingest` enqueues all pages, and
the Queue consumer processes them sequentially. Post-vision phases are driven
by `processIngestionBatch` via client poll loop:

1. **vision** (Queue) — Phase 2 for every page. The vision model reads each
   page image and extracts structured semantic units. Cross-page continuation
   state is passed between pages.
2. **summary** — Phase 3a for every unit: generate a concise summary using the
   extraction model, then immediately embed and upsert to Vectorize. Uses
   parent name and children names as context (not parent summaries), so no
   parent-first ordering needed. Batch size capped at 2 (LLM calls are
   expensive).
3. **metadata** — Phase 3b metadata extraction for every unit.
   Extracts 14 relationship fields + aliases using the reasoning
   model (unit name + summary + content only, no parent/children context).
   Also inserts deterministic `parent_of`/`child_of` relations from the unit
   hierarchy. Batch size capped at 2.
4. **relations** — Phase 4 + graph relations (Phase 6) for every unit.
   Vector-search-based: for each term in the unit's metadata fields, embed
   (term + summary) and search Vectorize. Confidence = similarity score.
   Processed one unit at a time (multiple vector queries per unit). Because
   this phase only starts once the entire document is embedded, vector search
   sees the complete knowledge base — forward and backward references alike.

Each post-vision phase selects its next batch by `status` (`pending` →
`summary_done` → `metadata_done` → `relations_done` → `done`), so progress is
resumable across Worker invocations and crashes. The summary and metadata
phases additionally use parent-first ordering rather than plain status
selection.

## Client driver

`worker/scripts/ingest.mjs` runs the full ingestion flow:

1. Renders PDF pages to PNG images via `pdftoppm` (poppler-utils)
2. Uploads page images to R2 via `PUT /ingest/r2/:key` (skips unchanged via hash check)
3. Calls `POST /ingest` to create the job and enqueue pages to the vision Queue
4. Polls `GET /ingest/status` for vision phase progress
5. Calls `POST /ingest/step` to advance post-vision phases (summary/metadata/relations)

It tracks stage/progress, persists a resumable state file
(`.ingest-state.json`), and retries transient errors with backoff while
logging full error details to `ingest.log`. Re-running the same command
resumes from the recorded job/phase; `--fresh` forces a new job;
`--status-only` prints current status; `--stage` runs only a specific
post-vision stage.

## Ingesting specific pages

The `--pages` flag limits the vision stage to a subset of pages. Only the
specified pages are rendered, uploaded to R2, and enqueued to the vision
Queue:

```bash
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 5-10
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 1,3,5-10
```

Post-vision stages always process all units in the database.

---

# Incremental Updates

When the source document changes:

1. Re-render page images from the updated PDF.
2. `POST /ingest` again with the same `documentId` and the new `totalPages`.
   This re-enqueues all pages to the vision Queue, which re-extracts all units.
3. For older units that should reconsider newly changed ones as candidates,
   `POST /ingest/rebuild-relations` re-runs Phase 4 across the whole knowledge
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

- `pages/{documentId}/{page}.png` — page images for vision extraction
- `markdown/{documentId}.md` — markdown ground truth for verification
- `sections/{documentId}.json` — section metadata for section checking
- `structures/{documentId}.json` — legacy (old pipeline)
- `structures/{documentId}.meta.json` — legacy (old pipeline)
- `jobs/{jobId}.json` — legacy (old pipeline)

## Vectorize

- `slitherer-rag-units` — unit embeddings (1024-dim, cosine)

## D1 (`slitherer-rag-db`)

Tables: `documents`, `structure_nodes`, `semantic_units`,
`relations`, `ingestion_jobs`, `conversations`, `query_logs`, `debug_logs`.

## Queues

- `vision-ingest` — page processing queue (max_concurrency=1, FIFO)

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`); apply with
`npm run db:migrate:remote`.

---

# Verification & Operations

```bash
# Worker
cd worker && npm run typecheck   # TypeScript type checking
cd worker && npm run deploy      # Deploy to Cloudflare Workers
cd worker && npm run db:migrate:remote   # Apply D1 schema

# Ingest (full pipeline: parse + render + upload + enqueue + poll)
# API key is read from worker/.dev.vars or ADMIN_API_KEY env var.
# URL defaults to config/worker.yaml — --url is optional.
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf

# Run a single stage
cd worker && npm run ingest -- --stage vision     # re-run vision extraction (resets + re-enqueues pages)
cd worker && npm run ingest -- --stage summary
cd worker && npm run ingest -- --stage metadata
cd worker && npm run ingest -- --stage relations

# Ingest only specific pages (vision stage only)
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 5-10
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 1,3,5-10

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
11. Vision-first extraction: let the vision model read page images directly
    and extract structured semantic units. No deterministic structure parsing
    or table double-tree heuristics — the model handles tables, lists,
    headings, and mixed layouts uniformly.
12. Keep heuristics language-agnostic and document-agnostic — no hard-coded
    terms, units, attribute names, or version-specific vocabulary.
14. Confidence scores reflect real match quality (vector similarity), not
    fixed constants. Retrieval filters by threshold, not fixed topN.

---

# MVP Deliverables (As-Built)

- PDF page rendering to PNG images (PyMuPDF, 200 DPI) with hash-based skip for unchanged pages
- Vision-based semantic unit extraction: vision model reads page images
  directly, extracts structured units with parent-child hierarchy and section
  paths (Phase 2)
- Cross-page continuation state: section paths, last unit name/content, and
  recent container units (name + content) passed between pages for consistent linking
- Summary generation with parent context (extraction model) + immediate embedding (Phase 3a)
- Metadata extraction with all 14 relationship fields + parent context (reasoning model)
  (Phase 3b)
- Vector-search-based relationship extraction: term+summary embedding →
  Vectorize search → confidence = similarity score (Phase 4)
- Lean embedding generation with token-budget management (Phase 5)
- D1 knowledge graph with documents/semantic_units/ingestion_jobs
  tables and a status state machine (Phase 6)
- Agentic retrieval pipeline: router (RAG/chat + language + translation) →
  query decomposition → multi-sub-query vector search + parent/sibling +
  confidence-filtered graph expansion → per-sub-query reranking → iterative
  sufficiency check with follow-up queries → citation-backed answer (Phase 7)
- Conversation history stored in D1; every pipeline step logged to D1
  `query_logs` + console.log
- Streaming (SSE) and complete (JSON) response modes
- All-in-one `/query` endpoint + step-by-step `/query/*` endpoints for
  client-side orchestration (avoids Workers 30s wall-time limit)
- Queue-driven vision phase (max_concurrency=1, FIFO) + chunked resumable
  post-vision phases driven by client poll loop
- API security (fail-closed admin, optional query auth)
- Operations tooling: `npm run ingest` (with `--pages` for partial ingestion,
  `--stage` for single-phase reruns), debug frontend with unit editing

The MVP is complete when users can ask questions involving multiple
interacting mechanics, and the system consistently retrieves all relevant
rules (including the right table cells and their parent context), resolves
interactions using only retrieved evidence, and produces fully cited answers.

---

# Future Improvements

## Conflict Detection

Automatically identify conflicting rules, duplicate definitions, circular
dependencies, and unreachable mechanics.

## Rule Timeline

Track introduced / modified / deprecated / overridden.

## Mechanic Summaries

Generate synthetic concept summaries by aggregating every semantic unit
connected to the same mechanic; these can improve retrieval quality.
