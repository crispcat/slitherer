#!/usr/bin/env node
/**
 * Drives the Cloudflare Worker's vision-based ingestion pipeline.
 *
 * Flow (vision-first):
 *   1. Render PDF pages to PNG images (via pdftoppm/poppler-utils)
 *   2. Upload page images to R2 (pages/{documentId}/{page}.png) — skip unchanged
 *   3. POST /ingest { documentId, sourcePath, totalPages, pages? } — enqueues pages to vision Queue
 *   4. Poll POST /ingest/step for summary/metadata/relations phases
 *
 * Usage:
 *   node scripts/ingest.mjs \
 *     --url https://api.slitherer.workers.dev \
 *     --input ../rulebooks/deorim_rules.pdf \
 *     --document-id deorim_rules \
 *     --source-path rulebooks/deorim_rules.pdf
 *
 *   # Ingest only specific pages (vision stage only — post-vision stages process all units):
 *   node scripts/ingest.mjs --input ../rulebooks/deorim_rules.pdf --pages 5-10
 *   node scripts/ingest.mjs --input ../rulebooks/deorim_rules.pdf --pages 1,3,5-10
 *   node scripts/ingest.mjs --input ../rulebooks/deorim_rules.pdf --pages 7
 *
 *   # Run only a specific stage:
 *   node scripts/ingest.mjs --stage vision     # re-run vision extraction (re-enqueues pages)
 *   node scripts/ingest.mjs --stage summary
 *   node scripts/ingest.mjs --stage metadata
 *   node scripts/ingest.mjs --stage relations
 *
 * Re-running with the same --state file resumes an in-progress or failed job.
 */

import { readFile, writeFile, appendFile, access, readdir, unlink } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import * as crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dirname, "..");
const REPO_DIR = resolve(WORKER_DIR, "..");

// Read base URL from config/worker.yaml
const workerConfig = yaml.load(readFileSync(join(REPO_DIR, "config", "worker.yaml"), "utf8"));
const DEFAULT_WORKER_URL = workerConfig.url;

/**
 * Parse a page range string into a sorted, de-duplicated array of page numbers.
 * Supports: "5", "5-10", "1,3,5-10", "1,3-5,7"
 */
function parsePageRanges(spec) {
  const pages = new Set();
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map((s) => parseInt(s.trim(), 10));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        console.error(`Invalid page range: "${trimmed}"`);
        process.exit(1);
      }
      for (let p = start; p <= end; p++) pages.add(p);
    } else {
      const p = parseInt(trimmed, 10);
      if (!Number.isFinite(p) || p < 1) {
        console.error(`Invalid page number: "${trimmed}"`);
        process.exit(1);
      }
      pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function parseArgs(argv) {
  const args = {
    url: null,
    input: null, // PDF file
    documentId: "deorim_rules",
    sourcePath: null, // derived from --input if not set
    dpi: 200, // DPI for page rendering
    state: ".ingest-state.json",
    log: "ingest.log",
    pollDelayMs: 1000, // longer poll delay for Queue-based processing
    maxRetries: 5,
    statusOnly: false,
    fresh: false,
    stage: null, // null = run all stages; otherwise "vision"|"summary"|"metadata"|"relations"
    pages: null, // null = all pages; otherwise array of 1-indexed page numbers
    apiKey: process.env.ADMIN_API_KEY ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": args.url = next(); break;
      case "--input": args.input = next(); break;
      case "--document-id": args.documentId = next(); break;
      case "--source-path": args.sourcePath = next(); break;
      case "--dpi": args.dpi = parseInt(next(), 10); break;
      case "--state": args.state = next(); break;
      case "--log": args.log = next(); break;
      case "--poll-delay-ms": args.pollDelayMs = parseInt(next(), 10); break;
      case "--max-retries": args.maxRetries = parseInt(next(), 10); break;
      case "--status-only": args.statusOnly = true; break;
      case "--fresh": args.fresh = true; break;
      case "--stage": args.stage = next(); break;
      case "--pages": args.pages = parsePageRanges(next()); break;
      case "--api-key": args.apiKey = next(); break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  if (!args.input) {
    console.error("--input is required (PDF file)");
    process.exit(1);
  }
  if (!args.input.toLowerCase().endsWith(".pdf")) {
    console.error("--input must be a PDF file (vision-based ingestion requires page images)");
    process.exit(1);
  }
  if (!args.sourcePath) {
    args.sourcePath = args.input.replace(REPO_DIR + "/", "");
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
  const VALID_STAGES = ["vision", "summary", "metadata", "relations"];
  if (args.stage && !VALID_STAGES.includes(args.stage)) {
    console.error(`Invalid --stage: ${args.stage}. Valid stages: ${VALID_STAGES.join(", ")}`);
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const statePath = resolve(process.cwd(), args.state);
const logPath = resolve(process.cwd(), args.log);
const renderDir = resolve(process.cwd(), "rulebooks", ".render", args.documentId);

// Check system dependencies (only needed for full ingestion with rendering)
if (!args.stage && !args.statusOnly) {
  for (const bin of ["pdftoppm", "pdfinfo"]) {
    try {
      execSync(`which ${bin}`, { stdio: "pipe" });
    } catch {
      console.error(`Missing system dependency: ${bin} (from poppler-utils)`);
      console.error("Install it with:");
      console.error("  Debian/Ubuntu: sudo apt install poppler-utils");
      console.error("  macOS:         brew install poppler");
      console.error("  Arch:          sudo pacman -S poppler");
      process.exit(1);
    }
  }
}

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

async function putBinary(path, binaryData, contentType, contentHash) {
  const headers = {
    authorization: `Bearer ${args.apiKey}`,
    "content-type": contentType,
  };
  if (contentHash) headers["x-content-hash"] = contentHash;
  const res = await fetch(new URL(path, args.url), {
    method: "PUT",
    headers,
    body: binaryData,
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

/** Check if an R2 object exists with the same content hash. Returns true if upload can be skipped. */
async function r2ObjectMatches(r2Key, localHash) {
  try {
    const res = await fetch(new URL(`/ingest/r2/meta/${r2Key}`, args.url), {
      headers: { authorization: `Bearer ${args.apiKey}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.exists === true && data.hash === localHash;
  } catch {
    return false;
  }
}

/** Compute SHA-256 hex hash of a Buffer using Node's crypto module. */
function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Upload a file to R2 only if the existing object's hash doesn't match.
 *  Returns true if uploaded, false if skipped (unchanged). */
async function putBinaryIfChanged(r2Key, binaryData, contentType) {
  const localHash = sha256Hex(binaryData);
  if (await r2ObjectMatches(r2Key, localHash)) {
    return { ok: true, skipped: true };
  }
  const result = await putBinary(`/ingest/r2/${r2Key}`, binaryData, contentType, localHash);
  return { ...result, skipped: false };
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

/** Get the total page count of a PDF using pdfinfo (poppler-utils). */
function getPdfPageCount(pdfPath) {
  const stdout = execSync(`pdfinfo "${pdfPath}"`, { encoding: "utf8" });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  return match ? parseInt(match[1], 10) : 0;
}

/** Render PDF pages to PNG images using pdftoppm (poppler-utils).
 *  If pages is provided, only those 1-indexed page numbers are rendered.
 *  Returns the total page count of the PDF. */
function renderPdfPages(pdfPath, outputDir, dpi, pages = null) {
  const totalPages = getPdfPageCount(pdfPath);
  if (totalPages === 0) return 0;

  if (pages) {
    // Render specific pages one at a time (pdftoppm renders ranges, not arbitrary sets)
    for (const pageNum of pages) {
      execSync(
        `pdftoppm -png -r ${dpi} -f ${pageNum} -l ${pageNum} -singlefile "${pdfPath}" "${join(outputDir, String(pageNum))}"`,
        { stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" }
      );
    }
  } else {
    // Render all pages: pdftoppm outputs prefix-001.png, prefix-002.png, ...
    // We use a temporary prefix then rename to {page}.png
    const prefix = join(outputDir, "page");
    execSync(
      `pdftoppm -png -r ${dpi} "${pdfPath}" "${prefix}"`,
      { stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" }
    );
    // Rename page-001.png → 1.png, page-002.png → 2.png, etc.
    const files = readdirSync(outputDir).filter(f => f.match(/^page-\d+\.png$/));
    for (const f of files) {
      const num = parseInt(f.match(/page-(\d+)\.png/)[1], 10);
      renameSync(join(outputDir, f), join(outputDir, `${num}.png`));
    }
  }
  return totalPages;
}

async function main() {
  await log("INFO", "Ingestion run starting", {
    url: args.url,
    input: args.input,
    stage: args.stage ?? "all",
  });

  const inputPath = resolve(process.cwd(), args.input);
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // For --stage (post-vision stages), resume from existing state
  if (args.stage) {
    let state = await loadState();
    if (!state?.jobId) {
      console.error(`No existing job in state file for --stage ${args.stage}. Run without --stage first.`);
      process.exit(1);
    }

    // Reset the requested stage
    await log("STAGE", `Resetting stage '${args.stage}' to clean state`, { documentId: args.documentId });
    const resetBody = { documentId: args.documentId, stage: args.stage };
    if (args.stage === "vision") resetBody.jobId = state.jobId;
    const resetResult = await withRetry(
      () => postJson("/ingest/reset-stage", resetBody),
      "POST /ingest/reset-stage"
    );
    await log("STAGE", `Stage reset complete`, resetResult);
    state.phase = args.stage;
    await saveState(state);

    // Vision stage: pages are re-enqueued by the reset endpoint. Poll status
    // until the vision phase completes (the Queue processes pages sequentially).
    if (args.stage === "vision") {
      const targetCount = state.pages ? state.pages.length : null;
      let lastPages = -1;
      let lastUnits = -1;
      let lastPhase = "vision";
      while (true) {
        await sleep(args.pollDelayMs);
        const job = await getJson(`/ingest/status?jobId=${state.jobId}`);
        const detail = JSON.parse(job.detail || "{}");
        const target = targetCount ?? detail.totalPages ?? "?";
        const pages = detail.pagesProcessed ?? 0;
        const units = detail.unitsProcessed ?? 0;
        const phase = detail.phase;

        if (pages !== lastPages || units !== lastUnits || phase !== lastPhase) {
          await log(
            "PROGRESS",
            `phase=${phase} pagesProcessed=${pages}/${target} unitsProcessed=${units}`
          );
          lastPages = pages;
          lastUnits = units;
          lastPhase = phase;
        }
        state.phase = phase;
        state.lastStepAt = nowIso();
        await saveState(state);

        if (phase !== "vision") {
          state.finishedAt = nowIso();
          await saveState(state);
          await log("DONE", `Vision stage complete — phase is now '${phase}'`, state);
          break;
        }
      }
      return;
    }

    // Post-vision stages: drive via /ingest/step
    let lastPhase = state.phase;
    let lastUnits = -1;
    while (true) {
      const stepBody = { jobId: state.jobId, batchSize: 5 };
      if (args.stage) stepBody.stage = args.stage;
      const result = await withRetry(
        () => postJson("/ingest/step", stepBody),
        "POST /ingest/step"
      );

      if (result.phase !== lastPhase) {
        await log("STAGE", `Entered phase: ${result.phase}`, {});
        lastPhase = result.phase;
        lastUnits = -1;
      }

      state.phase = result.phase;
      state.unitsProcessed = result.unitsProcessed;
      state.remaining = result.remaining;
      state.lastStepAt = nowIso();
      await saveState(state);

      if (result.unitsProcessed !== lastUnits) {
        await log(
          "PROGRESS",
          `phase=${result.phase} unitsProcessed=${result.unitsProcessed} remaining=${result.remaining ?? "?"}`
        );
        lastUnits = result.unitsProcessed;
      }

      if (result.done) {
        state.finishedAt = nowIso();
        await saveState(state);
        await log("DONE", `Stage '${args.stage}' complete`, state);
        break;
      }

      await sleep(args.pollDelayMs);
    }
    return;
  }

  // Full ingestion flow
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
    // Step 1: Render PDF pages to PNG
    let totalPages = 0;
    const pagesDir = join(renderDir, "pages");
    try {
      await access(pagesDir);
    } catch {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(pagesDir, { recursive: true });
    }
    await log("STAGE", "Rendering PDF pages to PNG", {
      dpi: args.dpi,
      pagesDir,
      pages: args.pages ?? "all",
    });
    const pdfPageCount = renderPdfPages(inputPath, pagesDir, args.dpi, args.pages);
    totalPages = pdfPageCount;

    // Count rendered pages
    const files = await readdir(pagesDir);
    const pageFiles = files.filter((f) => f.match(/^\d+\.png$/)).sort((a, b) => {
      return parseInt(a) - parseInt(b);
    });
    const renderedCount = pageFiles.length;
    await log("STAGE", `Rendered ${renderedCount} of ${totalPages} pages`, { pagesDir });

    // Step 2: Upload page images to R2 (skip unchanged files)
    await log("STAGE", "Uploading page images to R2", { documentId: args.documentId, count: renderedCount });
    let uploadedCount = 0;
    let skippedCount = 0;
    for (const file of pageFiles) {
      const pageNum = parseInt(file);
      const imageBuffer = await readFile(join(pagesDir, file));
      const r2Key = `pages/${args.documentId}/${pageNum}.png`;
      const result = await withRetry(
        () => putBinaryIfChanged(r2Key, imageBuffer, "image/png"),
        `PUT /ingest/r2/${r2Key}`
      );
      if (result.skipped) {
        skippedCount++;
      } else {
        uploadedCount++;
      }
    }
    await log("STAGE", "Page images uploaded", { uploaded: uploadedCount, skipped: skippedCount });

    if (totalPages === 0) {
      console.error("ERROR: Could not determine total page count from PDF.");
      process.exit(1);
    }

    // Step 3: Start ingestion (enqueues pages to vision Queue)
    await log("STAGE", "Starting ingestion job", {
      documentId: args.documentId,
      sourcePath: args.sourcePath,
      totalPages,
      pages: args.pages ?? "all",
    });

    const ingestBody = {
      documentId: args.documentId,
      sourcePath: args.sourcePath,
      totalPages,
    };
    if (args.pages) ingestBody.pages = args.pages;

    const started = await withRetry(
      () => postJson("/ingest", ingestBody),
      "POST /ingest"
    );

    state = {
      jobId: started.jobId,
      documentId: started.documentId,
      totalPages: started.totalPages,
      pages: args.pages ?? null,
      pagesEnqueued: started.pagesEnqueued,
      totalUnits: null,
      phase: "vision",
      startedAt: nowIso(),
    };
    await saveState(state);
    await log("STAGE", "Ingestion job created — pages enqueued to vision Queue", state);
  } else {
    await log("STAGE", "Resuming existing ingestion job from state file", state);
  }

  // Step 6: Poll for vision phase completion, then run post-vision stages
  let lastPhase = state.phase;
  let lastPages = -1;
  let lastUnits = -1;
  while (true) {
    // Check job status
    const job = await withRetry(
      () => getJson(`/ingest/status?jobId=${state.jobId}`),
      "GET /ingest/status"
    );

    const detail = JSON.parse(job.detail || "{}");
    const phase = job.phase;
    const status = job.status;
    const pages = detail.pagesProcessed ?? 0;
    const units = detail.unitsProcessed ?? 0;

    if (phase !== lastPhase) {
      await log("STAGE", `Entered phase: ${phase}`, {
        pagesProcessed: pages,
        totalPages: detail.totalPages,
        unitsProcessed: units,
      });
      if (lastPhase === "vision") {
        state.totalUnits = units;
      }
      lastPhase = phase;
      lastPages = -1;
      lastUnits = -1;
    }

    state.phase = phase;
    state.pagesProcessed = pages;
    state.unitsProcessed = units;
    const targetCount = state.pages ? state.pages.length : state.totalPages;
    state.remaining = targetCount ? targetCount - pages : null;
    state.lastStepAt = nowIso();
    await saveState(state);

    if (phase === "vision") {
      if (pages !== lastPages || units !== lastUnits) {
        const pct = targetCount ? (pages / targetCount * 100).toFixed(1) : "?";
        await log("PROGRESS", `vision: pages ${pages}/${targetCount} (${pct}%) units=${units}`);
        lastPages = pages;
        lastUnits = units;
      }
    } else {
      // Post-vision phase: advance via /ingest/step
      const result = await withRetry(
        () => postJson("/ingest/step", { jobId: state.jobId, batchSize: 5 }),
        "POST /ingest/step"
      );
      if (result.unitsProcessed !== lastUnits || result.remaining !== state.remaining) {
        await log("PROGRESS", `phase=${result.phase} unitsProcessed=${result.unitsProcessed} remaining=${result.remaining ?? "?"}`);
        lastUnits = result.unitsProcessed;
      }
      if (result.done) {
        state.finishedAt = nowIso();
        await saveState(state);
        await log("DONE", "Ingestion complete", state);
        break;
      }
    }

    if (status === "done") {
      state.finishedAt = nowIso();
      await saveState(state);
      await log("DONE", "Ingestion complete", state);
      break;
    }

    await sleep(args.pollDelayMs);
  }
}

main().catch(async (err) => {
  await log("FATAL", "Ingestion run aborted", { message: err.message });
  process.exit(1);
});
