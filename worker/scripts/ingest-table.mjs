#!/usr/bin/env node
/**
 * Processes a single table node through the table pipeline and prints the
 * resulting semantic units. Does NOT save anything to the database.
 *
 * Usage:
 *   node scripts/ingest-table.mjs \
 *     --url https://api.slitherer.workers.dev \
 *     --structure ../rulebooks/deorim_rules.structure.json \
 *     --node-id TABLE-00020
 *
 * Options:
 *   --url         Worker base URL (required)
 *   --structure   Path to structure.json (default: ../rulebooks/deorim_rules.structure.json)
 *   --node-id     Table node ID to process (required)
 *   --api-key     Admin API key (or set ADMIN_API_KEY env var)
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    url: null,
    structure: "../rulebooks/deorim_rules.structure.json",
    nodeId: null,
    apiKey: process.env.ADMIN_API_KEY ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": args.url = next(); break;
      case "--structure": args.structure = next(); break;
      case "--node-id": args.nodeId = next(); break;
      case "--api-key": args.apiKey = next(); break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  if (!args.url) {
    console.error("Missing required --url <worker base url>");
    process.exit(1);
  }
  if (!args.nodeId) {
    console.error("Missing required --node-id <TABLE-XXXXX>");
    process.exit(1);
  }
  if (!args.apiKey) {
    console.error("Missing admin API key. Pass --api-key <key> or set ADMIN_API_KEY env var.");
    process.exit(1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

async function main() {
  const structurePath = resolve(process.cwd(), args.structure);
  const raw = await readFile(structurePath, "utf8");
  const doc = JSON.parse(raw);
  const node = doc.nodes[args.nodeId];
  if (!node) {
    console.error(`Node ${args.nodeId} not found in ${structurePath}`);
    process.exit(1);
  }
  if (node.type !== "table") {
    console.error(`Node ${args.nodeId} is type=${node.type}, expected type=table`);
    process.exit(1);
  }

  console.log(`Processing ${args.nodeId} (${node.content.split("\n").filter(l => l.trim().startsWith("|")).length} lines)...`);

  const resp = await fetch(`${args.url}/ingest/table`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({ node }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Error ${resp.status}: ${text}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log(`\n${result.nodeId}: ${result.unitCount} units\n`);

  // Print tree
  const byId = new Map(result.units.map((u) => [u.id, u]));
  const children = new Map();
  for (const u of result.units) {
    const p = u.parentUnitId;
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(u);
    }
  }

  function printTree(uid, indent = 0) {
    const u = byId.get(uid);
    if (!u) return;
    const sec = u.secondaryParentUnitId ? "SEC" : "   ";
    const content = u.content.slice(0, 65).replace(/\n/g, " ");
    console.log(`${"  ".repeat(indent)}[${String(u.sourceOrder).padStart(2)}] ${sec} | ${content}`);
    for (const c of children.get(uid) ?? []) {
      printTree(c.id, indent + 1);
    }
  }

  const roots = result.units.filter((u) => !u.parentUnitId);
  for (const r of roots) {
    printTree(r.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
