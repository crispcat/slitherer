#!/usr/bin/env node
/**
 * Clear all ingestion data — local state + remote DB, Vectorize, and R2.
 * Does NOT parse the document or redeploy the worker.
 * Does NOT clear client logs (conversations, query_logs, debug_logs).
 *
 * Usage:
 *   npm run clear
 *   node scripts/clear.mjs
 */

import { execSync } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(WORKER_DIR, "..");

// ---- Config (base URL from config/worker.yaml) ----
const workerConfig = yaml.load(readFileSync(join(REPO_DIR, "config", "worker.yaml"), "utf8"));
const WORKER_URL = workerConfig.url;
const DOCUMENT_ID = "deorim_rules";

// Read API key from .dev.vars
let API_KEY = process.env.ADMIN_API_KEY ?? null;
if (!API_KEY) {
  const devVarsPath = join(WORKER_DIR, ".dev.vars");
  if (existsSync(devVarsPath)) {
    const devVars = readFileSync(devVarsPath, "utf8");
    const match = devVars.match(/^ADMIN_API_KEY=(.+)$/m);
    if (match) API_KEY = match[1].trim();
  }
}
if (!API_KEY) {
  console.error("ERROR: ADMIN_API_KEY not found. Set it in worker/.dev.vars or as an env var.");
  process.exit(1);
}

function step(n, total, label) {
  console.log(`\n=== ${n}/${total} ${label} ===`);
}

// ---- 1/3: Clean local ingest state ----
step(1, 3, "Cleaning local ingest state");
rmSync(join(WORKER_DIR, ".ingest-state.json"), { force: true });
rmSync(join(WORKER_DIR, "ingest.log"), { force: true });
console.log("Done.");

// ---- 2/3: Clean remote DB (D1 + Vectorize + R2) ----
step(2, 3, "Cleaning remote DB (D1, Vectorize, R2)");
const cleanupResp = execSync(
  `curl -s -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '{"documentId":"${DOCUMENT_ID}"}' ${WORKER_URL}/ingest/cleanup`,
  { encoding: "utf8" }
);
let cleanupOk = false;
try {
  const parsed = JSON.parse(cleanupResp);
  if (parsed.error) {
    console.error(`ERROR: Remote cleanup failed: ${parsed.error}`);
    process.exit(1);
  }
  cleanupOk = true;
} catch {
  // Non-JSON response, treat as error
  console.error(`ERROR: Remote cleanup returned unexpected response: ${cleanupResp.trim()}`);
  process.exit(1);
}
console.log(cleanupResp.trim());

// ---- 3/3: Summary ----
step(3, 3, "Clear complete");
console.log(`Document: ${DOCUMENT_ID}`);
console.log("Cleared: local state, D1 tables, Vectorize vectors, R2 job/structure files");
console.log("Preserved: R2 page images (reused on next ingest)");
console.log("Preserved: conversations, query_logs, debug_logs (client/pipeline logs)");

console.log("\n=== Done ===");
