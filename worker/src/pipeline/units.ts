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

/** Check if all cells in a table row are identical (merged-cell artifact). */
function isMergedRow(line: string): boolean {
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 2) return false;
  const first = cells[0];
  if (!first) return false;
  return cells.every((c) => c === first);
}

/** Collapse a merged-cell row (all cells identical) to a single-cell row. */
function collapseMergedRow(line: string): string {
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  const first = cells[0];
  return `| ${first} |`;
}

/** Split a Markdown table into row chunks, pre-grouping visually-continued rows.
 *  Merged-cell rows (all cells identical) are collapsed to single-cell rows. */
function chunkTableContent(source: string): Chunk[] {
  const rawLines = source.split("\n");
  if (rawLines.length === 0) return [];

  // Collapse merged-cell rows (all cells identical) to single-cell rows.
  // Build a new source string from the collapsed lines so positions are consistent.
  const lines = rawLines.map((l) =>
    l.includes("|") && isMergedRow(l) ? collapseMergedRow(l) : l
  );
  const collapsedSource = lines.join("\n");

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
          content: collapsedSource.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
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
          content: collapsedSource.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
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
      content: collapsedSource.slice(lineStarts[groupStart], lineStarts[groupEnd] + lines[groupEnd].length),
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
  const rawLines = source.split("\n");
  if (rawLines.length === 0) return [];

  // Collapse merged-cell rows (all cells identical) to single-cell rows.
  const lines = rawLines.map((l) =>
    l.includes("|") && isMergedRow(l) ? collapseMergedRow(l) : l
  );

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
  mode: "cell" | "row" | "table" | "split_2col" | "split_3col" | "split_4col";
  link_target: "row" | "column" | "none";
  has_description_row: boolean;
  section_headers: string[];
  reason: string;
}

const TABLE_MODE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    mode: { type: "string" },
    link_target: { type: "string" },
    has_description_row: { type: "boolean" },
    section_headers: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["mode", "link_target", "has_description_row", "section_headers", "reason"],
};

const TABLE_LAYOUT_PROMPT_2COL = `You are a semantic-layout analyzer for a Russian tabletop RPG rulebook.

Given the 2-column Markdown table below, decide how to split it into search/retrieval units.

MERGED ROWS (rows where all cells contain the same text):
- A merged row at the START of the table (before the header) is a "description row" — it describes the table's subject. Set has_description_row to true.
- A merged row in the MIDDLE of the table can be a "section header" — it starts a new category, and all subsequent data rows/cells belong to this category instead of the original column headers. List the text content of such rows in section_headers.
- A merged row can also be just a wide data entry (a single piece of content spanning all columns). Do NOT list these in section_headers — they are just data.

How to tell section headers from wide data entries:
- A section header is a short CATEGORY LABEL (e.g. "Магические навыки", "Дополнительное оборудование"). After it, the data rows change topic.
- A wide data entry is a longer piece of CONTENT that stands on its own (e.g. a rule description, a paragraph). It doesn't change the topic of subsequent rows.

- "cell" — each non-header cell is its own unit, linked to its column header.
  Use this ONLY when the left and right columns are two INDEPENDENT lists of the same kind of thing. Examples:
  • "Disadvantages | Advantages" — each cell is a standalone trait, the two columns are different categories
  • "Copper perks | Silver perks" — each cell is a standalone perk, the columns are different tiers
  The key test: could you swap a left-cell with a right-cell and it would still make sense? If yes, use "cell".

- "row" — each logical data row is one unit.
  Use this when both columns together form one entity — a key-value pair, a lookup, or a description. Examples:
  • "Value | Meaning" — the value and its meaning are one entity
  • "Рз | Эффект" — the attribute level and its effect are one entity
  • "Item | Price" — the item and its price are one entity
  • "Н 0 | Полное незнание." — the skill level and its description are one entity
  The key test: does the left column IDENTIFY what the right column describes? If yes, use "row".

- "table" — the whole table is a single unit.
  Use this VERY RARELY, only when the table has NO meaningful rows at all — e.g. a single paragraph of text split into columns for visual reasons, or a table with only one data row. If the table has multiple data rows with different content, do NOT use "table" — use "row" or "cell" instead.

Return ONLY a JSON object:
{"mode": "cell" | "row" | "table", "link_target": "column" | "row" | "none", "has_description_row": true | false, "section_headers": ["text of section header rows"], "reason": "short explanation in English"}

For "cell" mode, use link_target "column". For "row" mode, use link_target "none". For "table" mode, use link_target "none".
section_headers should contain the exact text content (without | markers) of each merged row that is a section header. Empty array if none.

Table:
{{TABLE_CONTENT}}

Return JSON:`;

const TABLE_LAYOUT_PROMPT_EVEN = `You are a semantic-layout analyzer for a Russian tabletop RPG rulebook.

Given the Markdown table below (which has an even number of columns ≥ 4), decide if it is:
1. A true multi-column table where all columns together describe one entity per row → choose "row"
2. Two or more 2-column sub-tables placed side-by-side for compactness → choose "split_2col"
3. Three or more 3-column sub-tables placed side-by-side → choose "split_3col"
4. Four or more 4-column sub-tables placed side-by-side → choose "split_4col"

MERGED ROWS (rows where all cells contain the same text):
- A merged row at the START of the table (before the header) is a "description row" — it describes the table's subject. Set has_description_row to true.
- A merged row in the MIDDLE of the table can be a "section header" — it starts a new category, and all subsequent data rows belong to this category. List the text content of such rows in section_headers.
- A merged row can also be just a wide data entry. Do NOT list these in section_headers.

How to tell section headers from wide data entries:
- A section header is a short CATEGORY LABEL (e.g. "СВОЙСТВА ОРУЖИЯ", "Дополнительное оборудование"). After it, the data rows change topic.
- A wide data entry is a longer piece of CONTENT that stands on its own. It doesn't change the topic of subsequent rows.

How to distinguish split modes from "row":
- Look at the column HEADERS (the row after --- separators, or the first data row).
- In "split_2col", columns 1&2 repeat the SAME PATTERN as columns 3&4. Both pairs are key-value lookups with the SAME semantic meaning.
  Example: "Н 0 | Полное незнание. | Н 60 | Профессионал." — columns 1&2 are [skill level | description], columns 3&4 are ALSO [skill level | description]. Same meaning → split_2col.
- In "row", all columns are DIFFERENT properties of one entity.
  Example: "Сл | Оружие | Переноси-мый вес | Могучий Удар" — each column is a different property (strength level, weapon ability, weight, combat ability). Different properties → row.

CRITICAL: Do NOT confuse "row" with "split_2col" just because both pairs have [number | text] format.
- "Сл | Оружие | Вес | Могучий Удар" is "row" because: col 1 = skill level, col 3 = weight number. These are DIFFERENT types of numbers with different meanings.
- "Н 0 | Описание | Н 60 | Описание" is "split_2col" because: col 1 and col 3 are BOTH skill levels with the same meaning.

The test: do columns 1 and 3 (or 1 and 4 for split_3col) represent the SAME type of value with the SAME meaning? If they represent different properties (even if both are numeric), it's "row".

Strong signal for split modes: the same TYPE of value repeats in columns 1, 3 (for split_2col), or 1, 4 (for split_3col), etc., AND the column headers repeat the same labels or synonyms.

Only choose split_3col if the total column count is divisible by 3. Only choose split_4col if divisible by 4. Otherwise choose split_2col (requires divisible by 2) or "row".

Return ONLY a JSON object:
{"mode": "row" | "split_2col" | "split_3col" | "split_4col", "link_target": "none", "has_description_row": true | false, "section_headers": ["text of section header rows"], "reason": "short explanation in English"}

section_headers should contain the exact text content (without | markers) of each merged row that is a section header. Empty array if none.

Table:
{{TABLE_CONTENT}}

Return JSON:`;

async function detectTableMode(env: Env, node: StructureNode): Promise<TableMode> {
  const lines = node.content.split("\n");

  // Compute column count from the row with the most columns, not just the
  // first row. This handles tables where the first row is a merged-cell
  // description (all cells identical) that would otherwise undercount.
  let colCount = 0;
  for (const l of lines) {
    if (!l.includes("|")) continue;
    if (/^[\|\s]*[-:]+/.test(l)) continue; // separator
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    // Skip merged rows (all cells identical) — they don't reflect true width.
    if (cells.length >= 2 && cells.every((c) => c === cells[0]) && cells[0]) continue;
    colCount = Math.max(colCount, cells.length);
  }

  // 2-column tables: LLM decides cell vs row vs table.
  if (colCount === 2) {
    try {
      const prompt = TABLE_LAYOUT_PROMPT_2COL.replace("{{TABLE_CONTENT}}", node.content);
      const raw = await llmJson<TableMode>(
        env,
        prompt,
        "Return the JSON object with the table layout decision.",
        { model: env.ANSWER_MODEL, maxRetries: 1, schema: TABLE_MODE_SCHEMA }
      );

      let mode = raw?.mode === "cell" || raw?.mode === "row" || raw?.mode === "table" ? raw.mode : "row";
      let has_description_row = raw?.has_description_row === true;

      // Guard: never allow "table" mode if the table has multiple data rows.
      // "table" mode is only for visual layouts with no meaningful row structure.
      if (mode === "table") {
        const dataRowCount = lines.filter((l) => {
          if (!l.includes("|")) return false;
          if (/^[\|\s]*[-:]+/.test(l)) return false;
          const cells = l.split("|").slice(1, -1).map((c) => c.trim());
          if (cells.length >= 2 && cells.every((c) => c === cells[0]) && cells[0]) return false;
          return cells.some((c) => c.length > 0);
        }).length;
        if (dataRowCount > 2) {
          console.log(`Table mode for ${node.id}: overriding "table" to "row" (${dataRowCount} data rows)`);
          mode = "row";
        }
      }

      // Auto-detect description row if the LLM missed it.
      if (!has_description_row && (mode === "row" || mode === "cell")) {
        const firstDataLine = lines.find((l) => {
          if (!l.includes("|")) return false;
          if (/^[\|\s]*[-:]+/.test(l)) return false;
          const cells = l.split("|").slice(1, -1).map((c) => c.trim());
          return cells.length >= 2 && cells.every((c) => c === cells[0]) && cells[0];
        });
        if (firstDataLine) {
          has_description_row = true;
          console.log(`Table mode for ${node.id}: auto-detected description row`);
        }
      }
      let link_target: TableMode["link_target"] = "none";
      if (raw?.link_target === "row" || raw?.link_target === "column") {
        link_target = raw.link_target;
      }
      const section_headers = Array.isArray(raw?.section_headers) ? raw.section_headers.map((s: string) => s.trim()) : [];

      console.log(`Table mode for ${node.id}: ${mode} (link_target=${link_target}, desc=${has_description_row}, sections=${section_headers.length}): ${raw?.reason ?? "no reason"}`);
      return { mode, link_target, has_description_row, section_headers, reason: raw?.reason ?? "" };
    } catch (err) {
      console.warn(`Table layout detection failed for ${node.id}, using row mode: ${String(err)}`);
      return { mode: "row", link_target: "none", has_description_row: false, section_headers: [], reason: "fallback" };
    }
  }

  // Multi-column tables (≥ 4 cols): LLM decides row vs split_2col/split_3col/split_4col.
  // This covers even-column tables (4, 6, 8...) and also odd-column tables
  // divisible by 3 (6, 9, 12...) which could be split_3col.
  if (colCount >= 4 && (colCount % 2 === 0 || colCount % 3 === 0 || colCount % 4 === 0)) {
    try {
      const prompt = TABLE_LAYOUT_PROMPT_EVEN.replace("{{TABLE_CONTENT}}", node.content);
      const raw = await llmJson<TableMode>(
        env,
        prompt,
        "Return the JSON object with the table layout decision.",
        { model: env.ANSWER_MODEL, maxRetries: 1, schema: TABLE_MODE_SCHEMA }
      );

      let mode: TableMode["mode"] = "row";
      if (raw?.mode === "split_2col" || raw?.mode === "split_3col" || raw?.mode === "split_4col" || raw?.mode === "row") {
        // Validate divisibility: split_2col needs %2, split_3col needs %3, split_4col needs %4.
        if (raw.mode === "split_2col" && colCount % 2 === 0) mode = "split_2col";
        else if (raw.mode === "split_3col" && colCount % 3 === 0) mode = "split_3col";
        else if (raw.mode === "split_4col" && colCount % 4 === 0) mode = "split_4col";
        else if (raw.mode === "row") mode = "row";
        else {
          console.log(`Table mode for ${node.id}: LLM chose ${raw.mode} but colCount=${colCount} not divisible, falling back to row`);
          mode = "row";
        }
      }
      const has_description_row = raw?.has_description_row === true;
      const section_headers = Array.isArray(raw?.section_headers) ? raw.section_headers.map((s: string) => s.trim()) : [];
      console.log(`Table mode for ${node.id}: ${mode} (desc=${has_description_row}, sections=${section_headers.length}): ${raw?.reason ?? "no reason"}`);
      return { mode, link_target: "none", has_description_row, section_headers, reason: raw?.reason ?? "" };
    } catch (err) {
      console.warn(`Table layout detection failed for ${node.id}, using row mode: ${String(err)}`);
      return { mode: "row", link_target: "none", has_description_row: false, section_headers: [], reason: "fallback" };
    }
  }

  // Remaining tables (5, 7, 11 cols — not divisible by 2, 3, or 4): always row mode.
  // Auto-detect description row for deterministic tables.
  const hasDesc = lines.some((l) => {
    if (!l.includes("|")) return false;
    if (/^[\|\s]*[-:]+/.test(l)) return false;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    return cells.length >= 2 && cells.every((c) => c === cells[0]) && cells[0];
  });
  return { mode: "row", link_target: "none", has_description_row: hasDesc, section_headers: [], reason: `deterministic: ${colCount} columns` };
}

function buildTableUnits(node: StructureNode, decision: TableMode): DetectedUnit[] {
  if (decision.mode === "table") {
    return [{ type: "Rule", name: "", content: node.content }];
  }

  // Helper: check if a cell/row content matches any section header.
  const sectionHeaderSet = new Set(decision.section_headers.map((s) => s.trim().toLowerCase()));
  const matchSectionHeader = (content: string): boolean => {
    // Extract text from "| text |" format and compare.
    const text = content.replace(/^\s*\|?\s*/, "").replace(/\s*\|?\s*$/, "").trim().toLowerCase();
    return sectionHeaderSet.has(text);
  };

  // split_Ncol modes: split each row into N-column sub-rows.
  const splitN = decision.mode === "split_2col" ? 2
    : decision.mode === "split_3col" ? 3
    : decision.mode === "split_4col" ? 4
    : 0;

  if (splitN > 0) {
    const lines = node.content.split("\n");
    const units: DetectedUnit[] = [];
    let currentSectionIdx: number | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) continue;
      if (/^[\|\s]*[-:]+/.test(trimmed)) continue; // separator row
      if (isMergedRow(trimmed)) {
        // Merged-cell row: emit as a single-cell unit.
        const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
        if (!cells[0]) continue;
        const unit: DetectedUnit = { type: "Rule", name: "", content: `| ${cells[0]} |` };
        // If this is a section header, it becomes the parent for subsequent rows.
        if (matchSectionHeader(cells[0])) {
          currentSectionIdx = units.length;
        }
        units.push(unit);
        continue;
      }

      const parts = trimmed.split("|");
      const cells = parts.slice(1, -1).map((c) => c.trim());
      if (cells.length < splitN * 2 || cells.length % splitN !== 0) continue;

      // Emit each N-cell group as its own unit.
      for (let i = 0; i < cells.length; i += splitN) {
        const group = cells.slice(i, i + splitN);
        if (group.every((c) => !c)) continue;
        const d: DetectedUnit = { type: "Rule", name: "", content: `| ${group.join(" | ")} |` };
        if (currentSectionIdx !== null) d.parentIndex = currentSectionIdx;
        units.push(d);
      }
    }
    return units;
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

    let currentSectionIdx: number | null = null;

    // Data cells link to their row or column header based on the decision.
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];

      // Check if this is a single-cell row (merged row after collapse).
      if (row.length === 1) {
        const d: DetectedUnit = { type: "Rule", name: "", content: row[0].content };
        if (matchSectionHeader(row[0].content)) {
          currentSectionIdx = units.length;
        }
        units.push(d);
        continue;
      }

      const rowFirstIdx = units.length;
      for (let c = 0; c < row.length; c++) {
        const d: DetectedUnit = { type: "Rule", name: "", content: row[c].content };
        if (currentSectionIdx !== null) {
          // Section header overrides column headers.
          d.parentIndex = currentSectionIdx;
        } else if (decision.link_target === "row" && c > 0 && c <= headerIndices.length) {
          d.parentIndex = rowFirstIdx;
        } else if (decision.link_target === "column" && c < headerIndices.length) {
          d.parentIndex = headerIndices[c];
        }
        units.push(d);
      }
    }
    return units;
  }

  // Row mode: each row is one unit. Link data rows to header, header to description.
  // Section headers override the header as parent for subsequent rows.
  const rows = chunkTableContent(node.content);
  const units: DetectedUnit[] = rows.map((c) => ({ type: "Rule", name: "", content: c.content }));

  let headerIdx = 0;
  let dataStart = 1;
  let currentParent: number | null = null;

  if (decision.has_description_row && rows.length >= 2) {
    // First row is description, second is header.
    headerIdx = 1;
    dataStart = 2;
    units[headerIdx].parentIndex = 0; // header links to description
    currentParent = headerIdx;
  } else if (rows.length >= 2) {
    currentParent = 0;
  }

  for (let i = dataStart; i < units.length; i++) {
    if (matchSectionHeader(units[i].content)) {
      // This row is a section header — it becomes the new parent.
      // If there's a header, the section header links to it.
      if (currentParent !== null) units[i].parentIndex = currentParent;
      currentParent = i;
    } else {
      // Data row links to current parent (header or section header).
      if (currentParent !== null) units[i].parentIndex = currentParent;
    }
  }
  return units;
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

/** Merge consecutive non-heading chunks into the surrounding heading block.
 *  Numbered/bullet items that follow a colon-introduced list are merged into
 *  the parent block instead of starting new units. */
function mergeCohesiveChunks(chunks: Chunk[]): DetectedUnit[] {
  if (chunks.length === 0) return [];

  const units: DetectedUnit[] = [];
  let mergingList = false;

  for (const chunk of chunks) {
    const isHeading = isBlockHeading(chunk.content);
    const isNumberedOrBullet = /^\s*(\d+[.\)]\s+|[-+•]\s+)/.test(chunk.content.trim());

    // Check if the previous unit's content ends with ":" (colon-introduced list)
    const prevContent = units.length > 0 ? units[units.length - 1].content : "";
    const prevEndsColon = prevContent.trimEnd().endsWith(":");

    if (units.length === 0) {
      units.push({ type: "Rule", name: "", content: chunk.content });
      mergingList = false;
    } else if (isNumberedOrBullet && (mergingList || prevEndsColon)) {
      // This is a list item belonging to a colon-introduced list — merge it.
      units[units.length - 1].content += chunk.content;
      mergingList = true;
    } else if (isHeading) {
      units.push({ type: "Rule", name: "", content: chunk.content });
      mergingList = false;
    } else {
      // Append verbatim; chunk.content includes the leading separator from the source.
      units[units.length - 1].content += chunk.content;
      mergingList = false;
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
