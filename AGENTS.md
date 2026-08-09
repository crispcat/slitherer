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
npx wrangler d1 execute slitherer-rag-db --remote --command "DROP TABLE IF EXISTS relations; DROP TABLE IF EXISTS semantic_units; DROP TABLE IF EXISTS structure_nodes; DROP TABLE IF EXISTS ingestion_jobs; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS query_logs; DROP TABLE IF EXISTS conversations; DROP TABLE IF EXISTS debug_logs;"
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
- Remote: D1 tables (semantic_units, structure_nodes, relations, ingestion_jobs, documents), Vectorize vectors, R2 job/structure files

It does NOT clear R2 page images (these are reused on the next ingest — the
ingest script skips re-uploading unchanged files via hash check). It does NOT
clear client logs (conversations, query_logs) and does NOT redeploy the worker.

### Re-ingest after source PDF changes

1. Clear the old ingestion: `cd worker && npm run clear`
2. Run the ingest script (see `README.md` section 4). It re-renders the PDF
   and re-uploads changed page images automatically.

### Run a single ingestion stage

The ingest script supports `--stage` to run only one phase. The vision phase
is Queue-driven — `--stage vision` resets the vision stage and re-enqueues all
pages to the vision Queue. Post-vision stages (summary, metadata, relations)
are advanced via `POST /ingest/step`:

```bash
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf  # full ingestion (vision + all stages)
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 5-10  # only pages 5-10
cd worker && npm run ingest -- --input rulebooks/deorim_rules.pdf --pages 1,3,5-10  # specific pages
cd worker && npm run ingest -- --stage vision     # re-run vision extraction (resets + re-enqueues pages)
cd worker && npm run ingest -- --stage summary    # re-generate summaries + embeddings
cd worker && npm run ingest -- --stage metadata   # re-extract metadata
cd worker && npm run ingest -- --stage relations  # re-extract relations
```

The `--pages` flag accepts comma-separated ranges (e.g. `5-10`, `1,3,5-10`, `7`).
Only those pages are rendered, uploaded, and enqueued to the vision Queue. This is
useful for testing the vision stage on a subset of pages without ingesting the full
document. Post-vision stages always process all units in the database.

Note: `--input` is required for all stages. For post-vision stages (`summary`, `metadata`,
`relations`), the script skips parsing and uploading — it uses the existing R2 data and
resumes from the state file. Use `--skip-parse` and `--skip-upload` to further control this.

**What gets cleared per stage:**
- `vision`: semantic_units, embeddings, relations; resets job to vision phase and re-enqueues pages
- `summary`: summaries, embeddings, metadata, relations; resets status to `pending`
- `metadata`: metadata, relations; resets status to `summary_done`
- `relations`: relations only; resets status to `metadata_done`

## Architecture

- `worker/` (TypeScript, Cloudflare Workers) — Phases 1-5: vision extraction (page images →
  semantic units), summary + embeddings, metadata extraction, relationship extraction (vector
  search + deterministic hierarchy). Phases 6-8: agentic retrieval (router → decompose →
  retrieve → sufficiency loop → answer), citation-aware answer generation.
- System dependencies: `poppler-utils` (`pdftoppm`, `pdfinfo`) for PDF rendering.

### Vision-based extraction pipeline

The vision pipeline uses a vision-language model that reads page images directly:

1. **Render**: PDF pages → PNG images (via `pdftoppm`, 200 DPI)
2. **Upload**: Page images → R2 (`pages/{docId}/{page}.png`) — unchanged images are skipped via hash check
3. **Enqueue**: `POST /ingest` enqueues all pages to the vision Queue (max_concurrency=1, FIFO)
4. **Extract** (Queue handler): Each page image → vision model → `VisionUnit[]` + continuation state
5. **Post-vision phases**: summary → metadata → relations (advanced via `POST /ingest/step`)

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

All hardcoded values, prompts, model references, and thresholds live in YAML
files under `config/`:

- `config/ingestion.yaml` — pipeline thresholds, batch sizes, LLM temperatures, all prompts
- `config/retrieval.yaml` — retrieval thresholds, graph hops, prompts
- `config/pages.yaml` — client/debug site URLs, UI feature flags
- `config/worker.yaml` — worker URL, CORS headers

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
