# Project Guide

## Deployment & Operations

**ALWAYS check `README.md` first** for deployment, ingestion, and query
instructions before running any deployment or DB manipulation task.

### Deploy the worker

```bash
cd worker && npm run deploy
```

### Deploy the client (Cloudflare Pages)

```bash
cd client && npx wrangler pages deploy . --project-name slitherer-rag
```

The client is a static site (HTML/CSS/JS, no build step) in `client/`.
It calls the Worker API at the URL configured in the sidebar.

### Apply DB schema (remote)

```bash
cd worker && npm run db:migrate:remote
```

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`), safe to re-run.

### Cleanup a failed/stale ingestion

Use the API endpoint (NOT manual SQL deletes):

```bash
curl -X POST https://slitherer-rag.slitherer.workers.dev/ingest/cleanup \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"documentId":"<doc-id>"}'
```

This removes all D1 rows, Vectorize vectors, and R2 objects for the document.
After cleanup, also remove the local resumable state file so the next ingest
starts fresh:

```bash
rm -f worker/.ingest-state.json
```

### Re-ingest after parser changes

1. Re-run the parser: `python3 parser/markdown_to_structure.py rulebooks/<book>.md -o rulebooks/<book>.structure.json`
2. Cleanup the old ingestion (see above).
3. Run the ingest script (see `README.md` section 4).

### Full iteration cycle (cleanup + reparse + redeploy + reingest)

Use the `iterate` npm script to run the full cycle in one command:

```bash
cd worker && npm run iterate              # blocks until ingestion completes
cd worker && npm run iterate -- --no-watch # starts ingestion in background
cd worker && npm run iterate -- --stage metadata  # run only the metadata phase
```

This cleans local state, reparses `structure.json`, cleans the remote DB,
deploys the worker, and starts a fresh ingestion. Use this instead of
running the individual steps manually when iterating on the pipeline.

### Run a single ingestion stage

The ingest script supports `--stage` to run only one phase. When a stage is
specified, the worker first resets that stage to a clean state (clearing its
outputs and all downstream stages' outputs), then runs it:

```bash
cd worker && npm run ingest -- --stage units      # re-detect all units (clears everything)
cd worker && npm run ingest -- --stage summary    # re-generate summaries + embeddings (clears summary+metadata+relations)
cd worker && npm run ingest -- --stage metadata   # re-extract metadata (clears metadata+relations)
cd worker && npm run ingest -- --stage relations  # re-extract relations (clears relations only)
```

This requires an existing job (use `--fresh` to start one first, or resume
from a state file). The worker skips ahead to the requested phase and stops
after it completes.

**What gets cleared per stage:**
- `units`: semantic_units, embeddings, relations, concepts, keywords (full reset, keeps structure_nodes)
- `summary`: summaries, embeddings, metadata, relations, concepts, keywords; resets status to `pending`
- `metadata`: metadata, relations, concepts, keywords; resets status to `summary_done`
- `relations`: relations only; resets status to `metadata_done`

## Architecture

- `parser/` (Python) — Phases 1-2: DOCX -> Markdown -> hierarchical `structure.json`. Deterministic, no LLM.
- `worker/` (TypeScript, Cloudflare Workers) — Phases 3-9: semantic unit detection, metadata, relationships, embeddings, graph, retrieval, Q&A.

### Node types in the structure tree

`document` > `chapter` > `section` > `subsection` > `group` > (`rule` | `table` | `note` | `image`)

`group` nodes are structural containers for colon-introduced lists (a `:`-ending
line followed by bold/numbered/bullet items). They are NOT leaf types, so Phase
3 skips them and processes their children as individual units. This prevents
category labels (e.g. "Основные:") from becoming orphan units and stops later
category labels from bleeding into the last entry of the previous group.

### Table unitization (Phase 3)

Table nodes are processed through a double-tree (row tree + column tree) pipeline
in `worker/src/pipeline/table_tree.ts`:

1. **`buildRowSkeleton`** (deterministic) — parses markdown table, classifies rows
   as structural/header/data based on merged cells and `---` separators.
2. **`refineRowSkeleton`** (LLM) — reclassifies rows, reparents for section
   hierarchies, chains name→description rows. Visual collapse guarded by
   fill-ratio < 0.7.
3. **`detectColumnTree`** (LLM) — determines if columns are SPLIT (independent
   sub-tables) or SIMPLE (properties of one entity).
4. **`deduplicateColumnHeaders`** (deterministic) — removes duplicate column tree
   nodes covering the same columns (fixes MULTI-MERGED tables).
5. **`buildTableUnitsFromTree`** (deterministic) — creates semantic units from the
   double-tree, with row-width column filtering and per-row deduplication.

### Testing table unitization

Single-table testing via the `/ingest/table` API endpoint:

```bash
node worker/scripts/ingest-table.mjs --url https://slitherer-rag.slitherer.workers.dev \
  --structure rulebooks/deorim_rules.structure.json --node-id TABLE-00005 \
  --api-key "$ADMIN_API_KEY"
```

Batch testing all tables (parallel, ~60s):

```python
# See /tmp/process_all_v3.py for the batch script pattern
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
- `config/client.yaml` — CORS settings, UI feature flags

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
