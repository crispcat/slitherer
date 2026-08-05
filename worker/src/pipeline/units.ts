import type { Env, SemanticUnit, SemanticUnitType, StructureNode } from "../types";
import { SEMANTIC_UNIT_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";

interface DetectedUnit {
  type: SemanticUnitType;
  name: string;
  content: string;
  /** Set during orphan resolution if this unit should be linked to a parent unit. */
  parentIndex?: number;
}

interface Chunk {
  content: string;
  start: number;
}

/** Split a rule/note source into candidate chunks. We over-split rather than
 *  under-split: the LLM can merge chunks, but cannot split a chunk that already
 *  contains two mechanics. */
const RULE_SPLIT_RE =
  /(?:^|\n)(?=\s*\n|\*\*|\d+[.\)]\s+|[-+•]\s+|\d+\s*[-–—]\s*\d+)/gi;

function chunkRuleContent(source: string): Chunk[] {
  if (!source.trim()) return [];

  // Create a fresh RegExp so the global lastIndex does not carry over between calls.
  const re = new RegExp(RULE_SPLIT_RE.source, RULE_SPLIT_RE.flags);
  const matches = Array.from(source.matchAll(re));
  const starts: number[] = [0];
  for (const m of matches) {
    const pos = m.index;
    if (pos !== undefined && !starts.includes(pos)) {
      starts.push(pos);
    }
  }
  starts.sort((a, b) => a - b);

  const chunks: Chunk[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i < starts.length - 1 ? starts[i + 1] : source.length;
    const content = source.slice(starts[i], end);
    if (content.trim().length > 0) {
      chunks.push({ content, start: starts[i] });
    }
  }
  return chunks;
}

function getFirstTableCell(row: string): string {
  const line = row.split("\n")[0].trim();
  // Match first non-empty Markdown table cell: text between | markers.
  const match = line.match(/^\s*\|?\s*([^|]*)\|/);
  return match ? match[1].trim() : line.split("|")[0]?.trim() ?? "";
}

/** Split a Markdown table into row chunks, pre-grouping visually-continued rows. */
function chunkTableContent(source: string): Chunk[] {
  const lines = source.split("\n");
  if (lines.length === 0) return [];

  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1;
  }

  const chunks: Chunk[] = [];
  let groupStart = 0;
  let groupEnd = 0;
  let lastFirstCell = "";
  let inGroup = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstCell = getFirstTableCell(line);
    const isData =
      line.includes("|") &&
      !/^[\|\s]*[-:]+/.test(line) &&
      firstCell !== "---";

    const isContinuation =
      inGroup &&
      (firstCell === "" ||
        firstCell === "…" ||
        firstCell === "..." ||
        /^[\s—–\-•‣▸»]+/.test(firstCell) ||
        (firstCell === lastFirstCell && firstCell.length > 0));

    if (!isData) {
      if (inGroup) {
        chunks.push({
          content: source.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
          start: lineStarts[groupStart],
        });
        inGroup = false;
      }
      continue;
    }

    if (isContinuation) {
      groupEnd = i;
      if (firstCell !== "" && firstCell !== "…" && firstCell !== "...") {
        lastFirstCell = firstCell;
      }
    } else {
      if (inGroup) {
        chunks.push({
          content: source.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
          start: lineStarts[groupStart],
        });
      }
      groupStart = i;
      groupEnd = i;
      lastFirstCell = firstCell;
      inGroup = true;
    }
  }

  if (inGroup) {
    chunks.push({
      content: source.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
      start: lineStarts[groupStart],
    });
  }

  return chunks;
}

interface ParsedTableLine {
  lineIndex: number;
  lineStart: number;
  cells: { text: string; start: number }[];
  maxCellLen: number;
}

function parseTableLine(line: string, lineIndex: number, lineStart: number): ParsedTableLine | undefined {
  if (!line.includes("|")) return undefined;
  if (/^[\|\s]*[-:]+/.test(line)) return undefined;
  if (getFirstTableCell(line) === "---") return undefined;

  const pipeIndices: number[] = [];
  for (let j = 0; j < line.length; j++) {
    if (line[j] === "|") pipeIndices.push(j);
  }
  if (pipeIndices.length < 2) return undefined;

  const cells: { text: string; start: number }[] = [];
  for (let k = 0; k < pipeIndices.length - 1; k++) {
    const text = line.slice(pipeIndices[k] + 1, pipeIndices[k + 1]).trim();
    const start = lineStart + pipeIndices[k];
    cells.push({ text, start });
  }
  const maxCellLen = Math.max(0, ...cells.map((c) => c.text.length));
  return { lineIndex, lineStart, cells, maxCellLen };
}

/** Split a Markdown table into cell chunks, one logical row at a time.
 *  The line immediately before the separator is the header. For two-column
 *  tables, consecutive data lines where the first is a short "name" row and
 *  the second is a long "description" row are merged vertically so each
 *  column becomes one cell. Cell content is normalised to "| text |" to keep
 *  headers and data uniform. */
function chunkTableCells(source: string): Chunk[][] {
  const lines = source.split("\n");
  if (lines.length === 0) return [];

  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1;
  }

  const parsed: ParsedTableLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parseTableLine(lines[i], i, lineStarts[i]);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) return [];

  const separatorIdx = lines.findIndex((l) => /^[\|\s]*[-:]+/.test(l));
  const headerLine = parsed.find((p) => separatorIdx === -1 || p.lineIndex < separatorIdx);
  if (!headerLine) return [];

  const dataRows = parsed.filter((p) => p !== headerLine);
  const colCount = headerLine.cells.length;

  const rows: Chunk[][] = [];
  rows.push(headerLine.cells.map((c) => ({ content: `| ${c.text} |`, start: c.start })));

  let i = 0;
  while (i < dataRows.length) {
    const current = dataRows[i];
    const next = dataRows[i + 1];
    const isShort = current.maxCellLen < 50;
    const isNextLong = next && next.maxCellLen > 80;

    if (colCount === 2 && isShort && isNextLong) {
      const cells: Chunk[] = [];
      for (let c = 0; c < 2; c++) {
        const text = [current.cells[c].text, next?.cells[c].text ?? ""].filter(Boolean).join("\n");
        cells.push({
          content: `| ${text} |`,
          start: current.cells[c].start,
        });
      }
      rows.push(cells);
      i += 2;
    } else {
      rows.push(
        current.cells.map((c) => ({
          content: `| ${c.text} |`,
          start: c.start,
        }))
      );
      i += 1;
    }
  }

  return rows;
}

interface TableMode {
  mode: "cell" | "row" | "table";
  link_target: "row" | "column" | "none";
  reason: string;
}

const TABLE_MODE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string" },
    link_target: { type: "string" },
    reason: { type: "string" },
  },
  required: ["mode", "link_target", "reason"],
};

const TABLE_LAYOUT_PROMPT = `You are a semantic-layout analyzer for a Russian tabletop RPG rulebook.

Given the Markdown table below, decide the best way to split it into search/retrieval units. There are three possible unitization strategies:

- "cell" — each non-header cell is its own unit.
  Use this when cells in a row are semantically independent and the column header is the meaningful category. Examples:
  • a two-column table of "Disadvantages | Advantages"
  • a two-column table of "Name | Description" (long descriptions are fine)
  • a two-column table of unrelated rules grouped only by type

- "row" — each logical data row is one unit.
  Use this when all columns together describe one entity, or when the table is a "visual" table (columns placed side-by-side for compactness rather than because they are separate categories). Examples:
  • attribute tables: "Value | Weapon use | Carry weight | Special"
  • skill lookup tables: "Н 0 | Полное незнание. | Н 60 | Профессионал."
  • any table where the first column is the entity and the others are its properties — set link_target to "row"
  • tables with 3+ columns that are not clearly two independent lists

- "table" — the whole table is a single unit.
  Use this only when the table is purely a visual layout device and the table as a whole expresses one rule that should not be split. Examples:
  • a paragraph of text reflowed into two columns
  • a table whose rows are all parts of one large rule and cannot stand alone
  • a table where the first column repeats the exact same large block of text for every row and the right column is just a list of values belonging to that one block

Return ONLY a JSON object with this shape:

{"mode": "cell" | "row" | "table", "link_target": "column" | "row" | "none", "reason": "short explanation in English"}

Rules:
- For a 2-column table where the left and right columns are two categories of the same kind (e.g. "Copper disadvantages | Copper advantages"), choose "cell" with link_target "column".
- For a 2-column "Name | Description" table, choose "cell" with link_target "column". The code will merge wrapped name+description rows automatically.
- For 3+ column attribute/skill tables, choose "row". If the first column is the key/entity and the others are its properties, set link_target "row"; otherwise "none".
- For a 4-column table that is really two independent 2-column sub-tables placed side-by-side (e.g. "Н 0 | Meaning | Н 60 | Meaning"), choose "row" (not cell) because the row is the meaningful compact block.
- If the first column repeats the same large text for every row (row-span / merged cell), the table is likely a visual table: prefer "row" or "table" over "cell", unless the right column is a clearly independent list.
- If the table is just a paragraph split into columns, or otherwise cannot be read row-by-row as independent rules, choose "table".

Table:
{{TABLE_CONTENT}}

Return JSON:`;

async function detectTableMode(env: Env, node: StructureNode): Promise<TableMode> {
  try {
    const prompt = TABLE_LAYOUT_PROMPT.replace("{{TABLE_CONTENT}}", node.content);
    const raw = await llmJson<TableMode>(
      env,
      prompt,
      "Return the JSON object with the table layout decision.",
      { model: env.EXTRACTION_MODEL, maxRetries: 1, schema: TABLE_MODE_SCHEMA }
    );

    const mode = raw?.mode === "cell" || raw?.mode === "row" || raw?.mode === "table" ? raw.mode : "row";
    let link_target: TableMode["link_target"] = "none";
    if (raw?.link_target === "row" || raw?.link_target === "column") {
      link_target = raw.link_target;
    }

    console.log(`Table mode for ${node.id}: ${mode} (link_target=${link_target}): ${raw?.reason ?? "no reason"}`);
    return { mode, link_target, reason: raw?.reason ?? "" };
  } catch (err) {
    console.warn(`Table layout detection failed for ${node.id}, using row mode: ${String(err)}`);
    return { mode: "row", link_target: "none", reason: "fallback" };
  }
}

function buildTableUnits(node: StructureNode, decision: TableMode): DetectedUnit[] {
  if (decision.mode === "table") {
    return [{ type: "Rule", name: "", content: node.content }];
  }

  if (decision.mode === "cell") {
    const rows = chunkTableCells(node.content);
    if (rows.length === 0) return [];

    const units: DetectedUnit[] = [];
    // First row is the header; create a unit for each column header.
    const header = rows[0];
    const headerIndices: number[] = [];
    for (const cell of header) {
      headerIndices.push(units.length);
      units.push({ type: "Rule", name: "", content: cell.content });
    }

    // Data cells link to their row or column header based on the decision.
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowFirstIdx = units.length;
      for (let c = 0; c < row.length; c++) {
        const d: DetectedUnit = { type: "Rule", name: "", content: row[c].content };
        if (decision.link_target === "row" && c > 0 && c <= headerIndices.length) {
          d.parentIndex = rowFirstIdx;
        } else if (decision.link_target === "column" && c < headerIndices.length) {
          d.parentIndex = headerIndices[c];
        }
        units.push(d);
      }
    }
    return units;
  }

  const rows = chunkTableContent(node.content);
  return rows.map((c) => ({ type: "Rule", name: "", content: c.content }));
}

function splitIntoChunks(node: StructureNode): Chunk[] {
  return chunkRuleContent(node.content);
}

/** Determine whether a chunk starts a new semantic block/entity. */
function isBlockHeading(content: string): boolean {
  const firstLine = content.trim().split("\n")[0].trim();
  if (firstLine.startsWith("**")) return true;
  if (/^\d+[.\)]+\s/.test(firstLine)) return true;
  if (/^[-+•]\s/.test(firstLine)) return true;
  if (firstLine.startsWith("|")) return true;
  if (/\d+\s*[-–—]\s*\d+/.test(firstLine)) return true;
  return false;
}

/** Merge consecutive non-heading chunks into the surrounding heading block. */
function mergeCohesiveChunks(chunks: Chunk[]): DetectedUnit[] {
  if (chunks.length === 0) return [];

  const units: DetectedUnit[] = [];
  for (const chunk of chunks) {
    if (units.length === 0 || isBlockHeading(chunk.content)) {
      units.push({ type: "Rule", name: "", content: chunk.content });
    } else {
      // Append verbatim; chunk.content includes the leading separator from the source.
      units[units.length - 1].content += chunk.content;
    }
  }

  return units;
}

/** Convert rule chunks to units using a deterministic heading rule.
 *  Consecutive non-heading fragments are merged into the preceding heading block. */
function chunksToUnits(chunks: Chunk[]): DetectedUnit[] {
  if (chunks.length === 0) return [];
  return mergeCohesiveChunks(chunks);
}

interface OrphanDecision {
  unit_index: number;
  action: "merge" | "link";
  parent_index: number;
  reason: string;
}

const ORPHAN_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      unit_index: { type: "number" },
      action: { type: "string" },
      parent_index: { type: "number" },
      reason: { type: "string" },
    },
    required: ["unit_index", "action", "parent_index", "reason"],
  },
};

function buildOrphanResolutionPrompt(node: StructureNode, units: DetectedUnit[]): string {
  const sectionPath = node.path.length > 0 ? node.path.join(" > ") : "(root)";
  const unitList = units
    .map((u, i) => `--- Unit ${i} (${u.type}${u.name ? ", name: " + u.name : ""}) ---\n${u.content}`)
    .join("\n\n");

  return `You are a rules-parsing engine for a tabletop RPG rulebook (Russian language).
Some of the detected semantic units below are "orphans": short fragments (e.g. stat modifiers like "+1З, +1Э", bonuses, penalties, exceptions, or conditions) that have no standalone meaning and clearly belong to a preceding unit.

For each orphan, decide whether to:
- "merge": combine its content into the preceding unit it belongs to.
- "link": keep it as a separate unit but mark it as a child of the preceding unit (use this when the fragment is a distinct related sub-rule, example, or exception worth keeping separately).

Only pick a "preceding" unit (parent_index < unit_index) from the list. If a unit makes sense on its own, do NOT include it.

Node type: ${node.type}
Section path: ${sectionPath}

Original text:
${node.content}

Detected units:
${unitList}

Respond with ONLY a JSON array of decisions, no prose, of the form:
[{"unit_index": 1, "action": "merge", "parent_index": 0, "reason": "it is the stat modifier for the age category"}]

Rules:
- Do not merge distinct list items, distinct spells, distinct weapons, or independent rules.
- Do not choose a parent that itself is being merged; if necessary, point to the final parent (the first non-merged unit in the chain).
- Preserve original language, case, and formatting.`;
}

function isOrphanCandidate(unit: DetectedUnit): boolean {
  // A short bold heading is a complete entity, not an orphan modifier.
  const firstLine = unit.content.trim().split("\n")[0].trim();
  if (firstLine.startsWith("**") && firstLine.length < 60) return false;

  // Short fragments, unnamed modifiers, and stat-like lines are the most common orphans.
  if (unit.content.length < 60) return true;
  if (!unit.name || unit.name.length === 0) {
    if (/^[\+\-]\d/.test(firstLine) || /^\d+[\p{L}]/u.test(firstLine)) return true;
  }
  return false;
}

/** Ask the LLM to identify short/detached orphan units and decide whether to merge
 *  them into a preceding sibling or link them as a child unit. */
async function resolveOrphanUnits(
  env: Env,
  node: StructureNode,
  units: DetectedUnit[]
): Promise<DetectedUnit[]> {
  if (units.length < 2) return units;
  if (!units.some((u, i) => i > 0 && isOrphanCandidate(u))) return units;

  try {
    const raw = await llmJson<OrphanDecision[]>(
      env,
      buildOrphanResolutionPrompt(node, units),
      "Return the JSON array of orphan resolution decisions.",
      { model: env.EXTRACTION_MODEL, maxRetries: 1, schema: ORPHAN_SCHEMA }
    );

    if (!Array.isArray(raw) || raw.length === 0) return units;

    // Build a decision map, keeping only valid forward-looking references.
    const decisions = new Map<number, OrphanDecision>();
    for (const d of raw) {
      if (
        typeof d.unit_index === "number" &&
        typeof d.parent_index === "number" &&
        d.unit_index > d.parent_index &&
        d.unit_index < units.length &&
        d.parent_index >= 0 &&
        isOrphanCandidate(units[d.unit_index])
      ) {
        const action = d.action === "link" ? "link" : "merge";
        decisions.set(d.unit_index, { ...d, action });
      }
    }

    if (decisions.size === 0) return units;

    // Resolve final parent for every index, following merge chains.
    const finalParent = new Map<number, number>();
    function resolveFinalParent(idx: number): number {
      if (finalParent.has(idx)) return finalParent.get(idx)!;
      const d = decisions.get(idx);
      if (!d || d.action === "link") {
        finalParent.set(idx, idx);
        return idx;
      }
      const parent = resolveFinalParent(d.parent_index);
      finalParent.set(idx, parent);
      return parent;
    }

    for (let i = 0; i < units.length; i++) {
      resolveFinalParent(i);
    }

    // Compute raw link parent (as stated by the LLM) for each linked child.
    const linkParent = new Map<number, number>();
    for (const [idx, d] of decisions) {
      if (d.action === "link") {
        linkParent.set(idx, d.parent_index);
      }
    }

    // Resolve a linked child''s logical parent to a final unit that is not itself a linked child.
    // This avoids pointing at a unit that was physically merged into another.
    function resolveLogicalParent(idx: number): number {
      let current = idx;
      while (true) {
        const lp = linkParent.get(current);
        if (lp === undefined) return current;
        const finalP = resolveFinalParent(lp);
        if (finalP === current) return current; // avoid cycle
        current = finalP;
      }
    }

    // Accumulate content for each final unit, preserving source order.
    const contentParts = new Map<number, string[]>();
    for (let i = 0; i < units.length; i++) {
      const parent = resolveFinalParent(i);
      if (!contentParts.has(parent)) contentParts.set(parent, []);
      contentParts.get(parent)!.push(units[i].content);
    }

    // Build resolved units in source order and map final input indices to resolved list indices.
    const resolved: DetectedUnit[] = [];
    const inputToResolvedIndex = new Map<number, number>();
    for (let i = 0; i < units.length; i++) {
      if (resolveFinalParent(i) !== i) continue; // merged; skip

      const logicalParent = linkParent.has(i) ? resolveLogicalParent(linkParent.get(i)!) : undefined;
      const parentIndex =
        logicalParent !== undefined && logicalParent !== i
          ? inputToResolvedIndex.get(logicalParent)
          : undefined;

      inputToResolvedIndex.set(i, resolved.length);
      resolved.push({
        ...units[i],
        content: contentParts.get(i)!.join("\n"),
        parentIndex: parentIndex ?? undefined,
      });
    }

    // Log the accepted reasoning for visibility.
    for (const d of raw) {
      if (decisions.has(d.unit_index)) {
        console.log(
          `Orphan ${d.unit_index} -> ${d.action} into ${d.parent_index}: ${d.reason}`
        );
      }
    }

    return resolved;
  } catch (err) {
    console.warn(`Orphan resolution failed for ${node.id}, using units as-is: ${String(err)}`);
    return units;
  }
}

async function buildUnit(
  node: StructureNode,
  d: DetectedUnit,
  sourceOrder: number,
  parentUnitId: string | null = null
): Promise<SemanticUnit> {
  const contentHash = await sha256(d.content);
  return {
    id: nextId(d.type),
    sourceNodeId: node.id,
    parentUnitId,
    sourceOrder,
    type: d.type,
    name: d.name || null,
    page: node.page,
    section: node.path,
    content: d.content,
    contentHash,
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
}

export async function detectSemanticUnits(env: Env, node: StructureNode): Promise<SemanticUnit[]> {
  if (!node.content.trim()) return [];

  let detected: DetectedUnit[] = [];

  if (node.type === "table") {
    const decision = await detectTableMode(env, node);
    detected = buildTableUnits(node, decision);
  } else {
    const chunks = splitIntoChunks(node);
    detected = chunksToUnits(chunks);
    // Second-pass LLM safety net for modifiers/exceptions that were not caught by
    // the deterministic heading rule (e.g. a bullet modifier chunk after a heading).
    detected = await resolveOrphanUnits(env, node, detected);
  }

  const units: SemanticUnit[] = [];
  for (let i = 0; i < detected.length; i++) {
    const d = detected[i];
    const type = SEMANTIC_UNIT_TYPES.includes(d.type as SemanticUnitType)
      ? (d.type as SemanticUnitType)
      : "Rule";
    const parentUnitId =
      d.parentIndex !== undefined && d.parentIndex < i ? units[d.parentIndex].id : null;
    units.push(await buildUnit(node, { ...d, type }, i, parentUnitId));
  }
  return units;
}
