# Project Guide

## Deployment & Operations

**ALWAYS check `README.md` first** for deployment, ingestion, and query
instructions before running any deployment or DB manipulation task.

### Deploy the worker

```bash
cd worker && npm run deploy
```

### Deploy the client (Worker with static assets)

```bash
cd pages && npm run deploy:client
```

The client is a static site (HTML/CSS/JS, no build step) deployed as a Worker
with static assets at `https://client.slitherer.workers.dev`.
URLs and API connection are configured in `config/pages.yaml` and `config/worker.yaml`.

### Deploy the debug tree viewer (Worker with static assets)

```bash
cd pages && npm run deploy:debug
```

The debug viewer is a standalone D3.js app deployed as a Worker with static
assets at `https://debug.slitherer.workers.dev`.
It calls the API Worker's `/debug/*` endpoints.

### Deploy all sites at once

```bash
cd pages && npm run deploy:all
```

### Apply DB schema (remote)

```bash
cd worker && npm run db:migrate:remote
```

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`), safe to re-run for new tables.

**Note:** `CREATE TABLE IF NOT EXISTS` does NOT add columns to existing tables.
If the schema has been updated with new columns on an existing table, you need
to either `ALTER TABLE` the specific column or drop and recreate the table:

```bash
# Drop specific table and re-apply schema (destructive — loses that table's data)
npx wrangler d1 execute slitherer-rag-db --remote --command "DROP TABLE IF EXISTS semantic_units;"
npm run db:migrate:remote

# Or drop all tables and start fresh
npx wrangler d1 execute slitherer-rag-db --remote --command "DROP TABLE IF EXISTS candidate_logs; DROP TABLE IF EXISTS query_logs; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS debug_logs; DROP TABLE IF EXISTS concept_mentions; DROP TABLE IF EXISTS concept_aliases; DROP TABLE IF EXISTS concepts; DROP TABLE IF EXISTS ingestion_jobs; DROP TABLE IF EXISTS semantic_units; DROP TABLE IF EXISTS structure_nodes; DROP TABLE IF EXISTS documents;"
npm run db:migrate:remote
```

### Create the vision Queue

The vision pipeline uses a Cloudflare Queue (`vision-ingest`) for page-by-page
processing. Create it once:

```bash
cd worker && npx wrangler queues create vision-ingest
```

### Clear all ingestion data

Use the `clear` npm script to wipe local state + remote DB in one command:

```bash
cd worker && npm run clear
```

This removes:
- Local: `.ingest-state.json`, `ingest.log`
- Remote: D1 tables (semantic_units, structure_nodes, concept_mentions, concepts, concept_aliases, ingestion_jobs, documents), Vectorize vectors (subjects + content + concepts), R2 job/structure files

It does NOT clear R2 page images (these are reused on the next ingest — the
ingest script skips re-uploading unchanged files via hash check). It does NOT
clear client logs (conversations, query_logs, debug_logs, candidate_logs) and
does NOT redeploy the worker.

### Re-ingest after source PDF changes

1. Clear the old ingestion: `cd worker && npm run clear`
2. Run the ingest script (see `README.md` section 4). It re-renders the PDF
   and re-uploads changed page images automatically.

### Run a single ingestion stage

The ingest script supports `--stage` to run only one phase. The vision phase
is Queue-driven — `--stage vision` resets the vision stage and re-enqueues all
pages to the vision Queue. Post-vision stages (summary, metadata, embedding,
concepts) are advanced via `POST /ingest/step`:

```bash
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf  # full ingestion (vision + all stages)
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 5-10  # only pages 5-10
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 1,3,5-10  # specific pages
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 1-5 --vision-only  # vision only, skip post-vision stages
cd worker && npm run ingest -- --stage vision     # re-run vision extraction (resets + re-enqueues pages)
cd worker && npm run ingest -- --stage summary    # re-generate summaries + embeddings
cd worker && npm run ingest -- --stage metadata   # re-extract metadata
cd worker && npm run ingest -- --stage embedding  # re-generate subject + content embeddings
cd worker && npm run ingest -- --stage concepts   # re-extract concepts + mentions
```

The `--pages` flag accepts comma-separated ranges (e.g. `5-10`, `1,3,5-10`, `7`).
Only those pages are rendered, uploaded, and enqueued to the vision Queue. This is
useful for testing the vision stage on a subset of pages without ingesting the full
document.

Note: `--input` is required for all stages. For post-vision stages (`summary`, `metadata`,
`embedding`, `concepts`), the script skips parsing and uploading — it uses the existing R2 data and
resumes from the state file.

### Page-scoped stage resets

`--pages` can be combined with `--stage` to reset and re-run only the units on
specific pages, without affecting the rest of the document:

```bash
cd worker && npm run ingest -- --stage vision --pages 7-10    # re-extract vision for pages 7-10 only
cd worker && npm run ingest -- --stage summary --pages 7-10   # re-generate summaries for pages 7-10's units
cd worker && npm run ingest -- --stage metadata --pages 7-10  # re-extract metadata for pages 7-10's units
cd worker && npm run ingest -- --stage embedding --pages 7-10 # re-generate embeddings for pages 7-10's units
cd worker && npm run ingest -- --stage concepts --pages 7-10  # re-extract concepts for pages 7-10's units
```

Without `--pages`, the stage reset is document-wide (all units). With `--pages`,
only units on the specified pages are reset and re-processed. For concepts,
page-scoped resets only clear mentions for the affected units' pages and delete
orphaned concepts (concepts with no remaining mentions from any unit).
Non-orphaned concepts are preserved and updated via re-resolution.

**What gets cleared per stage (document-wide):**
- `vision`: semantic_units, embeddings, concepts; resets job to vision phase and re-enqueues pages
- `summary`: summaries, embeddings, metadata, concepts; resets status to `pending`
- `metadata`: metadata, embeddings, concepts; resets status to `summary_done`
- `embedding`: subject + content embeddings, concepts; resets status to `metadata_done`
- `concepts`: concepts + mentions only; resets status to `embedding_done`

**What gets cleared per stage (page-scoped with `--pages`):**
- `vision`: units + vectors + concept mentions for the specified pages only; re-enqueues only those pages
- `summary`: summaries + downstream for units on the specified pages; resets their status to `pending`
- `metadata`: metadata + embeddings + concept mentions for units on the specified pages; resets their status to `summary_done`
- `embedding`: subject + content vectors for units on the specified pages; resets their status to `metadata_done`
- `concepts`: concept mentions for units on the specified pages + orphaned concepts; resets their status to `embedding_done`

## Architecture

- `worker/` (TypeScript, Cloudflare Workers) — Ingestion: vision extraction (page images →
  semantic units), summary, subject + content embeddings, metadata extraction, concept
  extraction + resolution. Retrieval: hybrid (subject + content + FTS5 lexical, RRF-fused),
  concept-first + type-driven expansion, reranking, evidence selection, sufficiency loop,
  citation-aware answer generation.
- System dependencies: `poppler-utils` (`pdftoppm`, `pdfinfo`) for PDF rendering.

### Vision-based extraction pipeline

The vision pipeline uses a vision-language model that reads page images directly:

1. **Render**: PDF pages → PNG images (via `pdftoppm`, 200 DPI)
2. **Upload**: Page images → R2 (`pages/{docId}/{page}.png`) — unchanged images are skipped via hash check
3. **Enqueue**: `POST /ingest` enqueues all pages to the vision Queue (max_concurrency=1, FIFO)
4. **Extract** (Queue handler): Each page image → vision model → `VisionUnit[]` + continuation state
5. **Post-vision phases**: summary → metadata → embeddings → concepts (advanced via `POST /ingest/step`)

### Testing vision extraction

Single-page testing via the `/ingest/vision/test` API endpoint:

```bash
# Test extraction on a single page image (no DB writes)
curl -X POST https://api.slitherer.workers.dev/ingest/vision/test \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image": "<base64>", "page": 7}'

# Test with DB writes (stores units for debug frontend review)
curl -X POST https://api.slitherer.workers.dev/ingest/vision/test \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image": "<base64>", "page": 7, "writeToDb": true, "documentId": "test"}'
```

### Verification commands

```bash
cd worker && npm run typecheck   # TypeScript type checking (runs gen-config first)
cd worker && npm run deploy      # Deploy to Cloudflare Workers (runs gen-config first)
```

## Configuration System

All hardcoded values, prompts, and thresholds live in YAML files under `config/`:

- `config/ingestion.yaml` — pipeline thresholds, batch sizes, LLM temperatures, all prompts
- `config/retrieval.yaml` — retrieval thresholds, ranking weights, prompts
- `config/pages.yaml` — client/debug site URLs, UI feature flags
- `config/worker.yaml` — worker URL, CORS headers

Model bindings are configured in `worker/wrangler.toml` (not in YAML).

A build-time codegen script (`worker/scripts/gen-config.mjs`) reads the YAML
and generates `worker/src/config.gen.ts` (gitignored), which is imported by
the worker code. The gen-config step runs automatically before `deploy`,
`dev`, and `typecheck`.

To change any value:
1. Edit the YAML file
2. Run `npm run deploy` (gen-config runs automatically)
3. Done

Never edit `config.gen.ts` directly — it's auto-generated. The YAML files
are the source of truth.
