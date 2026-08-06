#!/usr/bin/env bash
set -euo pipefail

# Full iteration cycle: cleanup DB, reparse, redeploy worker, reingest.
# Usage: ./iterate.sh [--no-watch]
#   --no-watch  Start ingestion in background instead of blocking until done.

REPO_DIR="/home/enki/dev/slitherer"
WORKER_DIR="$REPO_DIR/worker"
RULEBOOK="$REPO_DIR/rulebooks/deorim_rules.md"
STRUCTURE="$REPO_DIR/rulebooks/deorim_rules.structure.json"
SOURCE_PATH="rulebooks/deorim_rules.docx"
DOCUMENT_ID="deorim_rules"
WORKER_URL="https://slitherer-rag.slitherer.workers.dev"
API_KEY="d18f5e205c52da3fd0b2086f435c94c1219145ef379459e3e6b89686061e9068"

WATCH=true
for arg in "$@"; do
  case "$arg" in
    --no-watch) WATCH=false ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

echo "=== 1/5 Cleaning local ingest state ==="
rm -f "$WORKER_DIR/.ingest-state.json" "$WORKER_DIR/ingest.log"
echo "Done."

echo "=== 2/5 Reparsing structure.json ==="
python3 "$REPO_DIR/parser/markdown_to_structure.py" "$RULEBOOK" -o "$STRUCTURE"
echo "Done."

echo "=== 3/5 Cleaning remote DB ==="
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"documentId\":\"$DOCUMENT_ID\"}" \
  "$WORKER_URL/ingest/cleanup")
echo "$RESPONSE"

echo "=== 4/5 Deploying worker ==="
cd "$WORKER_DIR"
npm run deploy
echo "Done."

echo "=== 5/5 Starting ingestion ==="
if [ "$WATCH" = true ]; then
  node scripts/ingest.mjs \
    --url "$WORKER_URL" \
    --api-key "$API_KEY" \
    --document-id "$DOCUMENT_ID" \
    --structure "$STRUCTURE" \
    --source-path "$SOURCE_PATH" \
    --fresh
else
  node scripts/ingest.mjs \
    --url "$WORKER_URL" \
    --api-key "$API_KEY" \
    --document-id "$DOCUMENT_ID" \
    --structure "$STRUCTURE" \
    --source-path "$SOURCE_PATH" \
    --fresh &
  INGEST_PID=$!
  echo "Ingestion started in background (PID: $INGEST_PID)."
  echo "Monitor with: tail -f $WORKER_DIR/ingest.log"
fi

echo "=== Iteration complete ==="
