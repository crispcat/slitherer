# AI Rulebook Knowledge Engine — MVP

Implements the MVP deliverables from [IMPLEMENTATION.md](IMPLEMENTATION.md) for the
`rulebooks/deorim_rules.pdf` rulebook.

## Architecture

- **`worker/`** (TypeScript, Cloudflare Workers) — Phases 1-5: vision extraction
  (page images → semantic units via vision-language model), summary + embeddings,
  metadata extraction (LLM), relationship extraction (vector search + deterministic
  hierarchy). Phases 6-8: agentic retrieval (router → decompose → retrieve →
  sufficiency loop → answer), citation-aware answer generation. Uses Workers AI
  (`AI` binding), Vectorize, D1, R2, and Queues.
- **`pages/client/`** (HTML/CSS/JS, Worker static assets) — GPT-like chat UI for the
  retrieval API. Supports both full (all-in-one) and staged (step-by-step)
  request modes, SSE token streaming, expandable intermediate thinking
  steps, and parameter controls for all API options.
- **`pages/debug/`** (HTML/CSS/JS, D3.js, Worker static assets) — Debug tree viewer
  for inspecting the semantic unit hierarchy, metadata, and relations.
- **`config/`** (YAML) — Externalized configuration for all pipeline values,
  prompts, model references, and thresholds. Read at build time by
  `gen-config.mjs` to generate `worker/src/config.gen.ts`.

## Known MVP limitations

- Ingestion runs as four sequential phases (vision → summary → metadata →
  relations), each only starting once the previous phase has processed every
  unit. The vision phase is Queue-driven (one page at a time, max_concurrency=1);
  post-vision phases are advanced via `POST /ingest/step` in batches.
- Ingestion is chunked into batches to stay within a single Worker invocation's
  CPU budget — a ~200 page book requires many step calls (LLM call per unit
  × 2-3 pipeline phases).

## 1. Install system dependencies

The ingest script uses `pdftoppm` and `pdfinfo` (from poppler-utils) to render
PDF pages to PNG images. Install them if not already available:

```bash
# Debian/Ubuntu
sudo apt install poppler-utils
# macOS
brew install poppler
```

## 2. Provision Cloudflare resources

Requires a Cloudflare account and `wrangler login`.

```bash
cd worker
npm install
npx wrangler d1 create slitherer-rag-db          # copy the database_id into wrangler.toml
npx wrangler vectorize create slitherer-rag-units --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create slitherer-rag-storage
npx wrangler queues create vision-ingest          # Queue for vision pipeline
npm run db:migrate:remote                         # applies schema.sql
```

Update `database_id` in `worker/wrangler.toml` with the value printed by
`d1 create`.

### Secure the API

All `/ingest*` endpoints require a bearer token — **by design, they fail
closed** if this isn't set (nobody can ingest documents into your
infrastructure without it):

```bash
npx wrangler secret put ADMIN_API_KEY   # paste a long random value
```

`/query` is open by default (useful for a public-facing Q&A bot). To lock it
down too:

```bash
npx wrangler secret put QUERY_API_KEY
```

For local `wrangler dev`, copy `worker/.dev.vars.example` to `worker/.dev.vars`
(gitignored) and fill in your own values instead.

Every protected request must include `Authorization: Bearer <key>`.

## 3. Deploy

```bash
npm run deploy
```

The deploy script automatically runs `gen-config` first, which reads the YAML
config files in `config/` and generates `worker/src/config.gen.ts`. See the
[Configuration](#configuration) section below for details.

## 4. Ingest the rulebook

Use `npm run ingest` to drive the vision-based ingestion pipeline. The script:

1. Renders PDF pages to PNG images (via PyMuPDF, 200 DPI)
2. Uploads page images to R2 (`pages/{documentId}/{page}.png`) via `PUT /ingest/r2/{key}`
   — unchanged images are skipped via hash check
3. Calls `POST /ingest` to enqueue all pages to the vision Queue
4. Polls `GET /ingest/status` until the vision phase completes
5. Drives post-vision phases (summary → metadata → relations) via `POST /ingest/step`

It tracks stage/progress, persists a resumable state file (`.ingest-state.json`),
and retries transient errors with backoff while logging to `ingest.log`.

```bash
cd worker
ADMIN_API_KEY=<your-secret> npm run ingest -- \
  --url https://<your-worker>.workers.dev \
  --input ../rulebooks/deorim_rules.pdf \
  --document-id deorim_rules \
  --source-path rulebooks/deorim_rules.pdf
```

(or pass `--api-key <your-secret>` instead of the env var. The API key is also
read from `worker/.dev.vars` if present.)

Output looks like:

```
[...] [STAGE] Rendering PDF pages to PNG...
[...] [STAGE] Page images uploaded
[...] [STAGE] Starting ingestion job {...}
[...] [STAGE] Enqueued N pages to vision Queue
[...] [PROGRESS] phase=vision pagesProcessed=42/N
[...] [STAGE] Vision phase complete — transitioning to summary
[...] [PROGRESS] phase=summary unitsProcessed=340
...
[...] [DONE] Ingestion complete {...}
```

If the script crashes, hits an unrecoverable error, or you Ctrl-C it, just
re-run the same command — it resumes from the exact job/phase recorded in
`.ingest-state.json` instead of restarting. Use `--fresh` to force a brand
new job, or `--status-only` to just print the current job status.

Other useful flags: `--skip-parse` (skip parsing, use existing output),
`--skip-upload` (skip uploading to R2), `--max-retries <n>` (default 5),
`--poll-delay-ms <n>` (default 1000), `--pages <ranges>` (only ingest specific
pages, e.g. `--pages 5-10` or `--pages 1,3,5-10`).

### Ingesting specific pages

The `--pages` flag limits the vision stage to a subset of pages. Only the
specified pages are rendered, uploaded to R2, and enqueued to the vision
Queue. This is useful for testing the vision pipeline on a few pages without
ingesting the full document.

```bash
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --pages 5-10
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --pages 1,3,5-10
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --pages 7
```

The page range syntax supports comma-separated ranges: `5-10` (pages 5
through 10), `1,3,5-10` (pages 1, 3, and 5 through 10), `7` (just page 7).
Post-vision stages (summary, metadata, relations) always process all units
in the database regardless of the `--pages` filter.

### Run a single ingestion stage

The `--stage <name>` flag runs only one phase of the ingestion pipeline.
When a stage is specified, the worker first resets that stage to a clean
state (clearing its outputs and all downstream stages' outputs), then runs
it. This is useful for re-running a single phase after changing prompts or
thresholds without redoing the entire pipeline.

```bash
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --stage vision     # re-run vision extraction (resets + re-enqueues pages)
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --stage summary    # re-generate summaries + embeddings
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --stage metadata   # re-extract metadata
cd worker && npm run ingest -- --input ../rulebooks/deorim_rules.pdf --stage relations  # re-extract relations
```

`--stage vision` resets the vision phase and re-enqueues all existing page
images to the vision Queue (it does NOT re-parse or re-upload — use a full
`npm run ingest` for that). Other stages also resume from the existing
state file and require a prior run. The worker skips ahead to the requested
phase and stops after it completes.

**What gets cleared per stage:**
- `vision`: semantic_units, embeddings, relations; resets job to vision phase and re-enqueues pages
- `summary`: summaries, embeddings, metadata, relations; resets status to `pending`
- `metadata`: metadata, relations; resets status to `summary_done`
- `relations`: relations only; resets status to `metadata_done`

### Clear all ingestion data

To wipe all ingestion data (local state + remote DB, Vectorize, R2) without
parsing or redeploying:

```bash
cd worker && npm run clear
```

This clears D1 tables, Vectorize vectors, and R2 job/structure files for the
document, plus local state files. It preserves R2 page images (reused on the
next ingest — the ingest script skips re-uploading unchanged files via hash
check). It preserves client logs (conversations, query_logs).

## 5. Query

```bash
curl -s -X POST https://<your-worker>/query \
  -H 'content-type: application/json' \
  -d '{"question": "Может ли персонаж применить Финт-2 как малое действие?"}'
```

Returns `{ answer, citations, usedUnitIds, retrievedUnits }`.

## Incremental updates

To re-ingest after changes to the source document, run `npm run clear` to
wipe the old data, then `npm run ingest` with the updated input file. The
vision pipeline does not currently support incremental/delta updates —
each ingestion is a full re-run of all phases.

## Configuration

All hardcoded values, prompts, model references, and thresholds are
externalized into YAML files under `config/`:

- `config/ingestion.yaml` — pipeline thresholds, batch sizes, LLM temperatures, all ingestion prompts
- `config/retrieval.yaml` — retrieval thresholds, graph hops, all retrieval prompts
- `config/pages.yaml` — client/debug site URLs, UI feature flags
- `config/worker.yaml` — worker URL, CORS headers

A build-time codegen script (`worker/scripts/gen-config.mjs`) reads the YAML
and generates `worker/src/config.gen.ts` (gitignored), which is imported by
the worker code. The gen-config step runs automatically before `deploy`,
`dev`, and `typecheck`.

To change any value:
1. Edit the YAML file (e.g. `config/retrieval.yaml`)
2. Run `npm run deploy` (gen-config runs automatically first)
3. Done

Never edit `config.gen.ts` directly — it's auto-generated. The YAML files
are the source of truth.
