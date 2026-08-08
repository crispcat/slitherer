# AI Rulebook Knowledge Engine — MVP

Implements the MVP deliverables from [IMPLEMENTATION.md](IMPLEMENTATION.md) for the
`rulebooks/deorim_rules.docx` rulebook.

## Architecture

- **`parser/`** (Python, local, no AI) — Phase 1 (DOCX -> Markdown) and Phase 2
  (Markdown -> hierarchical `structure.json`). This document has no Word
  heading styles, so headings are detected from numbering conventions
  (`I.`, `2.1.`, `2.1.1.` etc. -> chapter/section/subsection); page numbers
  come from Word's cached `<w:lastRenderedPageBreak/>` markers.
- **`worker/`** (TypeScript, Cloudflare Workers) — Phases 3-9: semantic unit
  detection/splitting, metadata extraction, relationship extraction,
  embedding generation, D1 knowledge graph, agentic retrieval (router →
  decompose → retrieve → sufficiency loop → answer), and citation-aware
  answer generation. Uses Workers AI (`AI` binding), Vectorize, D1, and R2.
- **`client/`** (HTML/CSS/JS, Cloudflare Pages) — GPT-like chat UI for the
  retrieval API. Supports both full (all-in-one) and staged (step-by-step)
  request modes, SSE token streaming, expandable intermediate thinking
  steps, and parameter controls for all API options.
- **`config/`** (YAML) — Externalized configuration for all pipeline values,
  prompts, model references, and thresholds. Read at build time by
  `gen-config.mjs` to generate `worker/src/config.gen.ts`.

## Known MVP limitations

- The local heading heuristic also matches the book's table-of-contents
  entries (they reuse the same numbering scheme), producing some duplicate
  early nodes. Harmless for the pipeline; can be filtered by section-page
  monotonicity if it becomes an issue.
- Ingestion runs as four sequential whole-document phases (units -> metadata
  -> relations -> embeddings), each only starting once the previous phase
  has processed every node/unit. This means Phase 5 relationship extraction
  always sees the complete knowledge base as candidates (forward and
  backward references alike) — no separate rebuild pass needed for a fresh
  ingest. `POST /ingest/rebuild-relations` still exists as a utility for
  incremental updates, to let older units reconsider newly changed ones.
- Ingestion is chunked into batches (see `/ingest/step`) to stay within a
  single Worker invocation's CPU budget — a ~200 page book requires many
  step calls (LLM call per unit x 2-3 pipeline phases).

## 1. Run the parser

```bash
cd parser
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python docx_to_markdown.py ../rulebooks/deorim_rules.docx -o ../rulebooks/deorim_rules.md
.venv/bin/python markdown_to_structure.py ../rulebooks/deorim_rules.md -o ../rulebooks/deorim_rules.structure.json
```

Produces `rulebooks/deorim_rules.md` and `rulebooks/deorim_rules.structure.json`
(the Phase 2 node tree consumed by the Worker).

## 2. Provision Cloudflare resources

Requires a Cloudflare account and `wrangler login`.

```bash
cd worker
npm install
npx wrangler d1 create slitherer-rag-db          # copy the database_id into wrangler.toml
npx wrangler vectorize create slitherer-rag-units --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create slitherer-rag-storage
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

Use `npm run ingest` to drive ingestion. It first uploads `structure.json`
(plus `sourcePath`) to R2 via `POST /ingest/upload`, then calls `POST /ingest`
with the returned `bucketKey` and loops `/ingest/step`. Uploading to R2 first
(rather than inlining the JSON in the request body) is always automatic — no
manual step or size caveat to worry about. It also tracks stage/progress,
persists a resumable state file (`.ingest-state.json` by default), and retries
transient errors with backoff while logging full error details to `ingest.log`.

```bash
cd worker
ADMIN_API_KEY=<your-secret> npm run ingest -- \
  --url https://<your-worker>.workers.dev \
  --structure ../rulebooks/deorim_rules.structure.json \
  --document-id deorim_rules \
  --source-path rulebooks/deorim_rules.docx
```

(or pass `--api-key <your-secret>` instead of the env var.)

Output looks like:

```
[...] [STAGE] Starting ingestion job {...}
[...] [STAGE] Entered phase: units
[...] [PROGRESS] phase=units unitsProcessed=12 remaining=?
[...] [STAGE] Entered phase: metadata
[...] [PROGRESS] phase=metadata unitsProcessed=340 remaining=298 (12.4% of this phase)
...
[...] [DONE] Ingestion complete {...}
```

If the script crashes, hits an unrecoverable error, or you Ctrl-C it, just
re-run the same command — it resumes from the exact job/phase recorded in
`.ingest-state.json` instead of restarting. Use `--fresh` to force a brand
new job, or `--status-only` to just print the current job status.

Other useful flags: `--batch-size <n>` (nodes/units per step, default 5),
`--max-retries <n>` (default 5), `--poll-delay-ms <n>` (default 200).

### Run a single ingestion stage

The `--stage <name>` flag runs only one phase of the ingestion pipeline.
When a stage is specified, the worker first resets that stage to a clean
state (clearing its outputs and all downstream stages' outputs), then runs
it. This is useful for re-running a single phase after changing prompts or
thresholds without redoing the entire pipeline.

```bash
cd worker && npm run ingest -- --stage units      # re-detect all units
cd worker && npm run ingest -- --stage summary    # re-generate summaries + embeddings
cd worker && npm run ingest -- --stage metadata   # re-extract metadata
cd worker && npm run ingest -- --stage relations  # re-extract relations
```

This requires an existing job (use `--fresh` to start one first, or resume
from a state file). The worker skips ahead to the requested phase and stops
after it completes.

**What gets cleared per stage:**
- `units`: semantic_units, embeddings, relations, concepts, keywords (full reset, keeps structure_nodes)
- `summary`: summaries, embeddings, metadata, relations, concepts, keywords; resets status to `pending`
- `metadata`: metadata, relations, concepts, keywords; resets status to `summary_done`
- `relations`: relations only; resets status to `metadata_done`

### Full iteration cycle

The `npm run iterate` script runs the full cycle in one command: clean local
state, reparse `structure.json`, clean remote DB, deploy worker, start fresh
ingestion.

```bash
cd worker && npm run iterate              # blocks until ingestion completes
cd worker && npm run iterate -- --no-watch # starts ingestion in background
cd worker && npm run iterate -- --stage metadata  # iterate but only run metadata phase
```

## 5. Query

```bash
curl -s -X POST https://<your-worker>/query \
  -H 'content-type: application/json' \
  -d '{"question": "Может ли персонаж применить Финт-2 как малое действие?"}'
```

Returns `{ answer, citations, usedUnitIds, retrievedUnits }`.

## Incremental updates

Re-run the parser on an updated DOCX, then POST the new `structure.json` to
`/ingest` again with the same `documentId`. `processIngestionBatch` hashes
each structure node's content and skips re-running Phases 3-7 for any node
whose semantic units already have a matching `content_hash`, only
reprocessing (and re-embedding/re-graphing) changed nodes.

## Configuration

All hardcoded values, prompts, model references, and thresholds are
externalized into YAML files under `config/`:

- `config/ingestion.yaml` — pipeline thresholds, batch sizes, LLM temperatures, all ingestion prompts
- `config/retrieval.yaml` — retrieval thresholds, graph hops, all retrieval prompts
- `config/client.yaml` — CORS settings, UI feature flags

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
