# AI Rulebook Knowledge Engine — MVP

Implements the MVP deliverables from `docs/IMPEMENTATION_PLAN_V1.md` for the
`rulebooks/deorim_rules.docx` rulebook.

## Architecture

- **`parser/`** (Python, local, no AI) — Phase 1 (DOCX -> Markdown) and Phase 2
  (Markdown -> hierarchical `structure.json`). This document has no Word
  heading styles, so headings are detected from numbering conventions
  (`I.`, `2.1.`, `2.1.1.` etc. -> chapter/section/subsection); page numbers
  come from Word's cached `<w:lastRenderedPageBreak/>` markers.
- **`worker/`** (TypeScript, Cloudflare Workers) — Phases 3-9: semantic unit
  detection/splitting, metadata extraction, relationship extraction,
  embedding generation, D1 knowledge graph, hybrid retrieval, reranking, and
  citation-aware answer generation. Uses Workers AI (`AI` binding),
  Vectorize, D1, and R2.

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

## 4. Ingest the rulebook

Use `worker/scripts/ingest.mjs` to drive ingestion. It first uploads
`structure.json` (plus `sourcePath`) to R2 via `POST /ingest/upload`, then
calls `POST /ingest` with the returned `bucketKey` and loops `/ingest/step`.
Uploading to R2 first (rather than inlining the JSON in the request body) is
always automatic — no manual step or size caveat to worry about. It also
tracks stage/progress, persists a resumable state file (`.ingest-state.json`
by default), and retries transient errors with backoff while logging full
error details to `ingest.log`.

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
