#!/usr/bin/env node
/**
 * Drives the Cloudflare Worker's ingestion pipeline (/ingest -> /ingest/step
 * loop) for a Phase-2 structure.json, with:
 *   - stage/progress tracking (units -> metadata -> relations -> embeddings -> done)
 *   - a resumable state file, so a crashed/interrupted run can continue from
 *     the exact same job instead of restarting from scratch
 *   - retry with backoff on transient errors, and a structured error log
 *   - --stage <name> to run only a single ingestion phase
 *
 * Usage:
 *   node scripts/ingest.mjs \
 *     --url https://api.slitherer.workers.dev \
 *     --structure ../rulebooks/deorim_rules.structure.json \
 *     --document-id deorim_rules \
 *     --source-path rulebooks/deorim_rules.docx
 *
 *   # Run only a specific stage:
 *   node scripts/ingest.mjs --stage summary
 *   node scripts/ingest.mjs --stage metadata
 *   node scripts/ingest.mjs --stage relations
 *
 *   # Re-parse + re-run units from scratch:
 *   node scripts/ingest.mjs --stage units
 *
 * When --stage units is used, the script first re-parses the rulebook to
 * regenerate structure.json, then uploads it and creates a fresh job.
 * Other stages resume from the existing state file.
 *
 * Re-running with the same --state file resumes an in-progress or failed job.
 */

import { readFile, writeFile, appendFile, access } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(WORKER_DIR, "..");

// Read base URL from config/worker.yaml
const workerConfig = yaml.load(readFileSync(join(REPO_DIR, "config", "worker.yaml"), "utf8"));
const DEFAULT_WORKER_URL = workerConfig.url;

function parseArgs(argv) {
  const args = {
    url: null,
    structure: "../rulebooks/deorim_rules.structure.json",
    rulebook: null, // derived from --structure if not set
    docx: null, // derived from --rulebook if not set
    documentId: "deorim_rules",
    sourcePath: "rulebooks/deorim_rules.docx",
    batchSize: 5,
    state: ".ingest-state.json",
    log: "ingest.log",
    pollDelayMs: 200,
    maxRetries: 5,
    statusOnly: false,
    fresh: false,
    stage: null, // null = run all stages; otherwise "units"|"summary"|"metadata"|"relations"
    apiKey: process.env.ADMIN_API_KEY ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": args.url = next(); break;
      case "--structure": args.structure = next(); break;
      case "--rulebook": args.rulebook = next(); break;
      case "--docx": args.docx = next(); break;
      case "--document-id": args.documentId = next(); break;
      case "--source-path": args.sourcePath = next(); break;
      case "--batch-size": args.batchSize = parseInt(next(), 10); break;
      case "--state": args.state = next(); break;
      case "--log": args.log = next(); break;
      case "--poll-delay-ms": args.pollDelayMs = parseInt(next(), 10); break;
      case "--max-retries": args.maxRetries = parseInt(next(), 10); break;
      case "--status-only": args.statusOnly = true; break;
      case "--fresh": args.fresh = true; break;
      case "--stage": args.stage = next(); break;
      case "--api-key": args.apiKey = next(); break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  // Derive rulebook path from structure path if not explicitly set
  if (!args.rulebook) {
    args.rulebook = args.structure.replace(/\.structure\.json$/, ".md");
  }
  // Derive docx path from rulebook path if not explicitly set
  if (!args.docx) {
    args.docx = args.rulebook.replace(/\.md$/, ".docx");
  }
  if (!args.url) {
    args.url = DEFAULT_WORKER_URL;
  }
  // Read API key from .dev.vars as fallback
  if (!args.apiKey) {
    const devVarsPath = join(WORKER_DIR, ".dev.vars");
    if (existsSync(devVarsPath)) {
      const devVars = readFileSync(devVarsPath, "utf8");
      const match = devVars.match(/^ADMIN_API_KEY=(.+)$/m);
      if (match) args.apiKey = match[1].trim();
    }
  }
  if (!args.apiKey) {
    console.error("Missing admin API key. Pass --api-key <key>, set ADMIN_API_KEY env var, or put it in worker/.dev.vars.");
    process.exit(1);
  }
  const VALID_STAGES = ["units", "summary", "metadata", "relations"];
  if (args.stage && !VALID_STAGES.includes(args.stage)) {
    console.error(`Invalid --stage: ${args.stage}. Valid stages: ${VALID_STAGES.join(", ")}`);
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const statePath = resolve(process.cwd(), args.state);
const logPath = resolve(process.cwd(), args.log);

function nowIso() {
  return new Date().toISOString();
}

async function log(level, message, extra) {
  const line = `[${nowIso()}] [${level}] ${message}${extra ? " " + JSON.stringify(extra) : ""}`;
  console.log(line);
  await appendFile(logPath, line + "\n").catch(() => {});
}

async function loadState() {
  try {
    await access(statePath);
    return JSON.parse(await readFile(statePath, "utf-8"));
  } catch {
    return null;
  }
}

async function saveState(state) {
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

async function postJson(path, body) {
  const res = await fetch(new URL(path, args.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.error) {
    const err = new Error(`HTTP ${res.status}: ${data.error ?? text}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function postRaw(path, rawBody) {
  const res = await fetch(new URL(path, args.url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
    body: rawBody,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.error) {
    const err = new Error(`HTTP ${res.status}: ${data.error ?? text}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function getJson(path) {
  const res = await fetch(new URL(path, args.url), {
    headers: { authorization: `Bearer ${args.apiKey}` },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.error) {
    const err = new Error(`HTTP ${res.status}: ${data.error ?? text}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function withRetry(fn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      await log("ERROR", `${label} failed (attempt ${attempt}/${args.maxRetries})`, {
        message: err.message,
        status: err.status,
        body: err.body,
      });
      if (attempt >= args.maxRetries) {
        await log("FATAL", `${label} exceeded max retries. State preserved for resume.`, { statePath });
        throw err;
      }
      const backoffMs = Math.min(30_000, 500 * 2 ** attempt);
      await log("INFO", `Retrying ${label} in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await log("INFO", "Ingestion run starting", { url: args.url, stage: args.stage ?? "all" });

  // When --stage units, force fresh: re-parse the document, upload, and create a new job.
  // The units phase needs the latest structure.json, and reset-stage for units deletes
  // the old job, so we need a fresh one anyway.
  if (args.stage === "units") {
    args.fresh = true;
    const docxPath = resolve(process.cwd(), args.docx);
    const rulebookPath = resolve(process.cwd(), args.rulebook);
    const structurePath = resolve(process.cwd(), args.structure);
    const docxParserPath = join(REPO_DIR, "parser", "docx_to_markdown.py");
    const mdParserPath = join(REPO_DIR, "parser", "markdown_to_structure.py");
    const venvPython = join(REPO_DIR, "parser", ".venv", "bin", "python");
    await log("STAGE", "Re-parsing rulebook (--stage units)", { docx: docxPath, rulebook: rulebookPath, structure: structurePath });
    // Stage 1: DOCX -> Markdown
    execSync(`"${venvPython}" "${docxParserPath}" "${docxPath}" -o "${rulebookPath}"`, {
      stdio: "inherit",
      cwd: REPO_DIR,
    });
    // Stage 2: Markdown -> structure.json
    execSync(`"${venvPython}" "${mdParserPath}" "${rulebookPath}" -o "${structurePath}"`, {
      stdio: "inherit",
      cwd: REPO_DIR,
    });
    await log("STAGE", "Re-parse complete");

    // Clear old ingestion data (semantic_units, embeddings, relations, concepts, keywords).
    // reset-stage for units does a full wipe — we need this before creating a fresh job.
    await log("STAGE", "Resetting stage 'units' to clean state", { documentId: args.documentId });
    const resetResult = await withRetry(
      () => postJson("/ingest/reset-stage", { documentId: args.documentId, stage: "units" }),
      "POST /ingest/reset-stage"
    );
    await log("STAGE", "Stage reset complete", resetResult);
  }

  let state = args.fresh ? null : await loadState();

  if (args.statusOnly) {
    if (!state?.jobId) {
      console.error("No job in state file yet; nothing to check.");
      process.exit(1);
    }
    const job = await getJson(`/ingest/status?jobId=${state.jobId}`);
    console.log(JSON.stringify(job, null, 2));
    return;
  }

  if (!state) {
    const structurePath = resolve(process.cwd(), args.structure);
    await log("STAGE", "Reading structure.json", { structurePath });
    const rawStructure = await readFile(structurePath, "utf-8");
    const nodeCount = Object.keys(JSON.parse(rawStructure).nodes).length;

    await log("STAGE", "Uploading structure.json + sourcePath to R2", {
      documentId: args.documentId,
      sourcePath: args.sourcePath,
      nodeCount,
    });

    const uploadQuery = new URLSearchParams({
      documentId: args.documentId,
      sourcePath: args.sourcePath,
    });
    const uploaded = await withRetry(
      () => postRaw(`/ingest/upload?${uploadQuery}`, rawStructure),
      "POST /ingest/upload"
    );
    await log("STAGE", "Uploaded to R2", uploaded);

    await log("STAGE", "Starting ingestion job", {
      documentId: args.documentId,
      sourcePath: args.sourcePath,
      bucketKey: uploaded.bucketKey,
    });

    const started = await withRetry(
      () => postJson("/ingest", { documentId: args.documentId, sourcePath: args.sourcePath, bucketKey: uploaded.bucketKey }),
      "POST /ingest"
    );

    state = {
      jobId: started.jobId,
      documentId: started.documentId,
      totalNodes: started.totalNodes,
      totalUnits: null, // filled in once the "units" phase completes
      phase: "units",
      startedAt: nowIso(),
    };
    await saveState(state);
    await log("STAGE", "Ingestion job created", state);
  } else {
    await log("STAGE", "Resuming existing ingestion job from state file", state);
  }

  // If --stage is specified (and not units, which already starts fresh),
  // reset that stage to a clean state before running.
  // This clears the stage's outputs and all downstream stages' outputs.
  if (args.stage && args.stage !== "units") {
    await log("STAGE", `Resetting stage '${args.stage}' to clean state`, { documentId: args.documentId });
    const resetResult = await withRetry(
      () => postJson("/ingest/reset-stage", { documentId: args.documentId, stage: args.stage }),
      "POST /ingest/reset-stage"
    );
    await log("STAGE", `Stage reset complete`, resetResult);
    // Update state phase to the target stage
    state.phase = args.stage;
    await saveState(state);
  }

  let lastPhase = state.phase;
  while (true) {
    const stepBody = { jobId: state.jobId, batchSize: args.batchSize };
    if (args.stage) stepBody.stage = args.stage;
    const result = await withRetry(
      () => postJson("/ingest/step", stepBody),
      "POST /ingest/step"
    );

    if (result.phase !== lastPhase) {
      await log("STAGE", `Entered phase: ${result.phase}`, {});
      if (lastPhase === "units") {
        state.totalUnits = result.unitsProcessed; // known once units phase is complete
      }
      lastPhase = result.phase;
    }

    state.phase = result.phase;
    state.unitsProcessed = result.unitsProcessed;
    state.remaining = result.remaining;
    state.lastStepAt = nowIso();
    await saveState(state);

    const pctOfPhase =
      state.totalUnits && result.remaining != null
        ? Math.max(0, Math.min(1, 1 - result.remaining / state.totalUnits)) * 100
        : null;

    await log(
      "PROGRESS",
      `phase=${result.phase} unitsProcessed=${result.unitsProcessed} remaining=${result.remaining ?? "?"}` +
        (pctOfPhase !== null ? ` (${pctOfPhase.toFixed(1)}% of this phase)` : "")
    );

    if (result.done) {
      state.finishedAt = nowIso();
      await saveState(state);
      const doneMsg = args.stage
        ? `Stage '${args.stage}' complete`
        : "Ingestion complete";
      await log("DONE", doneMsg, state);
      break;
    }

    await sleep(args.pollDelayMs);
  }
}

main().catch(async (err) => {
  await log("FATAL", "Ingestion run aborted", { message: err.message });
  process.exit(1);
});
