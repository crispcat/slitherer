#!/usr/bin/env node
/**
 * Full iteration cycle: clear (local + remote), reparse structure.json,
 * redeploy worker, reingest.
 *
 * Usage:
 *   npm run iterate              # blocks until ingestion completes
 *   npm run iterate -- --no-watch # starts ingestion in background
 *   npm run iterate -- --stage metadata  # run only the metadata phase
 *   node scripts/iterate.mjs --no-watch
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(WORKER_DIR, "..");

// ---- Config (base URL from config/worker.yaml) ----
const workerConfig = yaml.load(readFileSync(join(REPO_DIR, "config", "worker.yaml"), "utf8"));
const DOCX = join(REPO_DIR, "rulebooks", "deorim_rules.docx");
const RULEBOOK = join(REPO_DIR, "rulebooks", "deorim_rules.md");
const STRUCTURE = join(REPO_DIR, "rulebooks", "deorim_rules.structure.json");
const SOURCE_PATH = "rulebooks/deorim_rules.docx";
const DOCUMENT_ID = "deorim_rules";
const WORKER_URL = workerConfig.url;

// Read API key from .dev.vars
let API_KEY = process.env.ADMIN_API_KEY ?? null;
if (!API_KEY) {
  const devVarsPath = join(WORKER_DIR, ".dev.vars");
  if (existsSync(devVarsPath)) {
    const devVars = await import("node:fs").then((fs) => fs.readFileSync(devVarsPath, "utf8"));
    const match = devVars.match(/^ADMIN_API_KEY=(.+)$/m);
    if (match) API_KEY = match[1].trim();
  }
}
if (!API_KEY) {
  console.error("ERROR: ADMIN_API_KEY not found. Set it in worker/.dev.vars or as an env var.");
  process.exit(1);
}

// ---- Parse args ----
let watch = true;
let stage = null;
const VALID_STAGES = ["units", "summary", "metadata", "relations"];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--no-watch") watch = false;
  else if (arg === "--stage") {
    stage = argv[++i];
    if (!VALID_STAGES.includes(stage)) {
      console.error(`Invalid --stage: ${stage}. Valid stages: ${VALID_STAGES.join(", ")}`);
      process.exit(1);
    }
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: npm run iterate [-- --no-watch] [-- --stage <name>]");
    console.log("  --no-watch       Start ingestion in background instead of blocking");
    console.log("  --stage <name>   Run only a single ingestion stage (units|summary|metadata|relations)");
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: WORKER_DIR, ...opts });
}

function step(n, total, label) {
  console.log(`\n=== ${n}/${total} ${label} ===`);
}

// ---- 1/4: Clear (local state + remote DB) ----
step(1, 4, "Clearing local state + remote DB");
run("npm run clear");
console.log("Done.");

// ---- 2/4: Reparse rulebook (DOCX -> Markdown -> structure.json) ----
step(2, 4, "Reparsing rulebook");
const venvPython = join(REPO_DIR, "parser", ".venv", "bin", "python");
run(`"${venvPython}" "${join(REPO_DIR, "parser", "docx_to_markdown.py")}" "${DOCX}" -o "${RULEBOOK}"`, { cwd: REPO_DIR });
run(`"${venvPython}" "${join(REPO_DIR, "parser", "markdown_to_structure.py")}" "${RULEBOOK}" -o "${STRUCTURE}"`, { cwd: REPO_DIR });
console.log("Done.");

// ---- 3/4: Deploy worker ----
step(3, 4, "Deploying worker");
run("npm run deploy");
console.log("Done.");

// ---- 4/4: Start ingestion ----
step(4, 4, "Starting ingestion");

const ingestArgs = [
  "scripts/ingest.mjs",
  "--url", WORKER_URL,
  "--api-key", API_KEY,
  "--document-id", DOCUMENT_ID,
  "--structure", STRUCTURE,
  "--source-path", SOURCE_PATH,
  "--fresh",
];
if (stage) ingestArgs.push("--stage", stage);

if (watch) {
  // Block until ingestion completes
  execSync(`node ${ingestArgs.map((a) => `"${a}"`).join(" ")}`, {
    stdio: "inherit",
    cwd: WORKER_DIR,
  });
} else {
  // Start in background
  const child = spawn("node", ingestArgs, {
    stdio: "ignore",
    cwd: WORKER_DIR,
    detached: true,
  });
  child.unref();
  console.log(`Ingestion started in background (PID: ${child.pid}).`);
  console.log(`Monitor with: tail -f ${join(WORKER_DIR, "ingest.log")}`);
}

console.log("\n=== Iteration complete ===");
