import type { Env, SemanticUnit, SemanticUnitType, StructureNode } from "../types";
import { SEMANTIC_UNIT_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";

interface DetectedUnit {
  type: SemanticUnitType;
  name: string;
  content: string;
}

const UNIT_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
    },
    required: ["type", "content"],
  },
};

function buildDetectionPrompt(node: StructureNode): string {
  const sectionPath = node.path.length > 0 ? node.path.join(" > ") : "(root)";
  const nodeContext = [
    `Node type: ${node.type}`,
    `Page: ${node.page ?? "unknown"}`,
    `Section path: ${sectionPath}`,
    node.type === "table" ? "This node is a Markdown table: detect one unit per meaningful row (or tightly related row group)." : null,
    node.type === "rule" ? "This node is a rule/paragraph: keep one cohesive mechanic as one unit, including modifiers and exceptions." : null,
    node.type === "note" ? "This node is a note/sidebar: keep it as one unit unless it contains several independent rules." : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are a rules-parsing engine for a tabletop RPG rulebook (Russian language).
Given the raw text of ONE document node (a heading, paragraph, list, or Markdown table), identify every distinct
semantic unit it contains.

${nodeContext}

A semantic unit is one coherent mechanic, definition, item, spell, ability, rule, weapon, armor piece, skill, trait, etc.

A "cohesive block" that describes a SINGLE entity should stay as ONE unit, including its attached modifiers,
exceptions, and special cases. Examples of cohesive blocks:
- An age category: "**Старый.** 40-55 лет. -1 атрибут. Бремя старости..."
- A stat block: a weapon with its stats, price, weight, and special rules.
- A trait with its mechanical effects.

Do NOT split a cohesive block into separate units.
Do NOT merge distinct list items, distinct spells, distinct weapons, or independent rules into one unit.
For Markdown tables, each meaningful row (or a tightly related group of rows) is its own unit.

Valid semantic unit types: ${SEMANTIC_UNIT_TYPES.join(", ")}.

Respond with ONLY a JSON array, no prose, of the form:
[{"type": "Rule", "name": "short Russian name", "content": "verbatim excerpt of the source text belonging to this unit"}]

Rules:
- "content" must be a verbatim substring of the input. Do not paraphrase, translate, or summarize.
- If the input contains multiple distinct mechanics (e.g. a numbered list of perks, a table of weapons, several spells), return one array item per mechanic.
- If the input is one coherent block, return exactly one item with the full input as content.
- For Markdown tables, return one item per meaningful data row; skip the header/separator rows. Derive the name from the first column.
- Preserve original language, case, and formatting.
- If a unit has no clear name, use a concise descriptive name in Russian.`;
}

const RECONCILE_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
    },
    required: ["type", "content"],
  },
};

function buildReconciliationPrompt(node: StructureNode, units: DetectedUnit[]): string {
  const sectionPath = node.path.length > 0 ? node.path.join(" > ") : "(root)";
  const unitList = units
    .map((u, i) => `--- Unit ${i + 1} (${u.type}${u.name ? ", name: " + u.name : ""}) ---\n${u.content}`)
    .join("\n\n");

  return `You are a rules-parsing engine for a tabletop RPG rulebook (Russian language).
Review the following proposed semantic-unit split for a document node and correct any boundary errors.

Node type: ${node.type}
Section path: ${sectionPath}

Original text:
${node.content}

Proposed units:
${unitList}

Look for these common errors and fix them:
1. Over-split cohesive blocks: a single mechanic split into multiple units should be merged.
2. Under-split merged blocks: distinct list items, spells, weapons, or independent rules crammed together should be separated.
3. Missing attached modifiers/exceptions that belong to a heading.
4. For Markdown tables, each meaningful row (or tightly related group of rows) should be one unit.

Respond with ONLY a JSON array of corrected units, no prose, of the form:
[{"type": "Rule", "name": "short Russian name", "content": "verbatim excerpt from the original text"}]

Rules:
- "content" must be a verbatim substring of the original text. Do not paraphrase.
- Preserve original language, case, and formatting.
- Valid types: ${SEMANTIC_UNIT_TYPES.join(", ")}.`;
}

function getFirstTableCell(row: string): string {
  const line = row.split("\n")[0].trim();
  // Match first non-empty Markdown table cell: text between | markers.
  const match = line.match(/^\s*\|?\s*([^|]*)\|/);
  return match ? match[1].trim() : line.split("|")[0]?.trim() ?? "";
}

/** Group visually-continued Markdown table rows with the row they belong to. */
function groupTableRows(units: DetectedUnit[]): DetectedUnit[] {
  const grouped: DetectedUnit[] = [];
  let lastFirstCell = "";
  for (const unit of units) {
    const firstCell = getFirstTableCell(unit.content);
    const isContinuation =
      grouped.length > 0 &&
      (firstCell === "" ||
        firstCell === "…" ||
        firstCell === "..." ||
        /^[\s—–\-•‣▸»]+/.test(firstCell) ||
        // Same first-cell as previous row often means a multi-line continuation.
        (firstCell === lastFirstCell && firstCell.length > 0));

    if (isContinuation) {
      const last = grouped[grouped.length - 1];
      last.content = `${last.content.trim()}\n${unit.content.trim()}`;
      if (!last.name && unit.name) last.name = unit.name;
    } else {
      grouped.push({ ...unit });
      lastFirstCell = firstCell;
    }
  }
  return grouped;
}

function needsReconciliation(node: StructureNode, units: DetectedUnit[], usedFuzzy: boolean): boolean {
  // Cheap signals that the first-pass split may be suspect. Keeps the extra LLM
  // call off the common happy path (one coherent block, exact alignment).
  if (units.length === 0) return false;
  if (usedFuzzy) return true;
  if (node.type === "table" && units.length > 1) return true; // tables benefit from row-group review
  if (units.length > 3) return true;
  if (units.some((u) => u.content.length < 30 && node.type !== "table")) return true;
  return false;
}

function alphaNumChars(text: string): { chars: string[]; positions: number[] } {
  const chars: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(c)) {
      chars.push(c);
      positions.push(i);
    }
  }
  return { chars, positions };
}

interface OriginalSpan {
  text: string;
  start: number;
}

interface WordToken {
  word: string;
  start: number;
  end: number;
}

function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ word: match[0].toLowerCase(), start: match.index, end: re.lastIndex });
  }
  return tokens;
}

/** Find a contiguous source span whose word-level LCS with the target is maximal. */
function alignWords(source: WordToken[], target: WordToken[]): { startIdx: number; endIdx: number; matched: number } | null {
  if (target.length === 0 || source.length === 0) return null;
  // Guard against pathological sizes. A semantic-unit excerpt should be modest;
  // if the model returned a huge block, skip the expensive DP and fall back.
  const maxSourceLen = Math.min(source.length, 4000);
  const sourceWindow = source.length <= maxSourceLen ? source : source.slice(0, maxSourceLen);
  if (sourceWindow.length * target.length > 4_000_000) return null;

  // DP: lcs[i][j] = length of LCS of sourceWindow[0..i-1] and target[0..j-1]
  const rows = sourceWindow.length + 1;
  const cols = target.length + 1;
  const lcs = new Uint16Array(rows * cols);

  let bestI = 0;
  let bestJ = 0;
  let bestValue = 0;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const idx = i * cols + j;
      if (sourceWindow[i - 1].word === target[j - 1].word) {
        lcs[idx] = lcs[(i - 1) * cols + (j - 1)] + 1;
      } else {
        const up = lcs[(i - 1) * cols + j];
        const left = lcs[i * cols + (j - 1)];
        lcs[idx] = up > left ? up : left;
      }
      if (lcs[idx] > bestValue) {
        bestValue = lcs[idx];
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (bestValue === 0) return null;

  // Trace back to find which source tokens participated in the optimal alignment.
  const alignedSourceIndices = new Set<number>();
  let i = bestI;
  let j = bestJ;
  while (i > 0 && j > 0) {
    const idx = i * cols + j;
    if (sourceWindow[i - 1].word === target[j - 1].word) {
      alignedSourceIndices.add(i - 1);
      i--;
      j--;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }

  const sorted = Array.from(alignedSourceIndices).sort((a, b) => a - b);
  return { startIdx: sorted[0], endIdx: sorted[sorted.length - 1], matched: bestValue };
}

/** Try to map an LLM-generated excerpt back to a verbatim substring of the source.
 *  First attempts an exact alphanumeric match, then falls back to a word-level
 *  LCS alignment so small LLM edits (normalization, dropped parentheticals)
 *  don't destroy source-order accuracy. */
function extractOriginalSpan(source: string, approximate: string): OriginalSpan | null {
  const src = alphaNumChars(source);
  const tgt = alphaNumChars(approximate);
  if (tgt.chars.length === 0) return null;

  // Simple sliding-window search for the target character sequence.
  for (let i = 0; i <= src.chars.length - tgt.chars.length; i++) {
    let match = true;
    for (let j = 0; j < tgt.chars.length; j++) {
      if (src.chars[i + j] !== tgt.chars[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const start = src.positions[i];
      const end = src.positions[i + tgt.chars.length - 1] + 1;
      return { text: source.slice(start, end), start };
    }
  }

  // Fuzzy fallback: word-level LCS alignment. Expands the matched source span
  // slightly to capture punctuation/whitespace around the aligned words.
  const sourceWords = tokenizeWords(source);
  const targetWords = tokenizeWords(approximate);
  const alignment = alignWords(sourceWords, targetWords);
  if (alignment) {
    const { startIdx, endIdx, matched } = alignment;
    const coverage = matched / targetWords.length;
    if (coverage >= 0.5) {
      // Expand the span to include a few surrounding words if available.
      const expandStart = Math.max(0, startIdx - 1);
      const expandEnd = Math.min(sourceWords.length - 1, endIdx + 1);
      const start = sourceWords[expandStart].start;
      const end = sourceWords[expandEnd].end;
      return { text: source.slice(start, end), start };
    }
  }

  return null;
}

async function alignDetectedUnits(node: StructureNode, detected: DetectedUnit[]): Promise<{ withPosition: { detected: DetectedUnit; start: number }[]; usedFuzzy: boolean }> {
  interface DetectedWithPosition {
    detected: DetectedUnit;
    start: number;
  }
  const withPosition: DetectedWithPosition[] = [];
  let usedFuzzy = false;

  for (let i = 0; i < detected.length; i++) {
    // The model occasionally collapses a short/single-cell row (e.g. a table
    // abbreviation) into a bare string or a single-element array instead of
    // the {type, name, content} object. Normalize those recoverable shapes
    // rather than aborting the whole node over one malformed item.
    let d: any = detected[i];
    if (typeof d === "string") {
      d = { type: "Rule", name: d, content: d };
    } else if (Array.isArray(d) && d.length > 0 && typeof d[0] === "string") {
      d = { type: "Rule", name: d[0], content: d[0] };
    }

    if (typeof d.content !== "string" || d.content.trim().length === 0) {
      throw new Error(`Semantic unit detection for ${node.id} returned empty content: ${JSON.stringify(d)}`);
    }
    const verbatim = extractOriginalSpan(node.content, d.content);
    if (verbatim) {
      d.content = verbatim.text;
      withPosition.push({ detected: d, start: verbatim.start });
      // Exact alphanumeric match always starts at a real source position.
    } else {
      // Fuzzy alignment failed too; preserve document order as a last resort.
      usedFuzzy = true;
      withPosition.push({ detected: d, start: Number.MAX_SAFE_INTEGER - detected.length + i });
    }
  }

  // Preserve document order so adjacency relations can be created later.
  withPosition.sort((a, b) => a.start - b.start);
  return { withPosition, usedFuzzy };
}

export async function detectSemanticUnits(env: Env, node: StructureNode): Promise<SemanticUnit[]> {
  if (!node.content.trim()) return [];

  const initialDetected = await llmJson<DetectedUnit[]>(env, buildDetectionPrompt(node), node.content, {
    model: env.EXTRACTION_MODEL,
    maxRetries: 2,
    schema: UNIT_SCHEMA,
  });

  if (!Array.isArray(initialDetected) || initialDetected.length === 0) {
    throw new Error(`Semantic unit detection for ${node.id} returned an empty or invalid response`);
  }

  const { withPosition, usedFuzzy } = await alignDetectedUnits(node, initialDetected);

  // Merge over-split cohesive blocks deterministically. The LLM prompt asks for
  // this, but the merge step is a safety net for cases like age categories where
  // modifiers were split into separate units.
  let merged: DetectedUnit[] =
    node.type === "table" ? withPosition.map((p) => p.detected) : mergeCohesiveBlocks(withPosition);

  // Second-pass review when the first-pass split looks suspect. This catches
  // cases the deterministic merge misses, especially tables, long lists, and
  // nodes where alignment had to fall back to fuzzy matching.
  if (needsReconciliation(node, merged, usedFuzzy)) {
    try {
      const reconciled = await llmJson<DetectedUnit[]>(
        env,
        buildReconciliationPrompt(node, merged),
        "Return the corrected JSON array of units.",
        { model: env.EXTRACTION_MODEL, maxRetries: 1, schema: RECONCILE_SCHEMA }
      );
      if (Array.isArray(reconciled) && reconciled.length > 0) {
        const aligned = await alignDetectedUnits(node, reconciled);
        merged = node.type === "table" ? aligned.withPosition.map((p) => p.detected) : mergeCohesiveBlocks(aligned.withPosition);
      }
    } catch (err) {
      // Reconciliation is a quality booster, not a hard dependency.
      console.warn(`Reconciliation failed for ${node.id}, using first-pass units: ${String(err)}`);
    }
  }

  if (node.type === "table") {
    merged = groupTableRows(merged);
  }

  const units: SemanticUnit[] = [];
  for (let i = 0; i < merged.length; i++) {
    const d = merged[i];
    const type = SEMANTIC_UNIT_TYPES.includes(d.type as SemanticUnitType) ? (d.type as SemanticUnitType) : "Rule";
    units.push(await buildUnit(node, { ...d, type }, i));
  }
  return units;
}

/** Determine whether a detected excerpt starts a new semantic block/entity. */
function isBlockHeading(content: string): boolean {
  const firstLine = content.split("\n")[0].trim();
  if (firstLine.startsWith("**")) return true;
  if (/^[0-9]+[\.\)]+\s/.test(firstLine)) return true;
  if (/^[\-\+\•\—\–\*]\s/.test(firstLine)) return false;
  if (/[:\.]$/.test(firstLine) && firstLine.length < 60) return true;
  return false;
}

/** Merge consecutive non-heading fragments into the surrounding heading block. */
function mergeCohesiveBlocks(items: { detected: DetectedUnit; start: number }[]): DetectedUnit[] {
  if (items.length === 0) return [];

  const blocks: { detected: DetectedUnit; start: number; hasHeading: boolean }[] = [];

  for (const item of items) {
    const heading = isBlockHeading(item.detected.content);
    if (blocks.length === 0) {
      blocks.push({ ...item, hasHeading: heading });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (heading && last.hasHeading) {
      // New heading starts a new block.
      blocks.push({ ...item, hasHeading: true });
    } else {
      // Merge into current block.
      last.detected.content = `${last.detected.content.trim()}\n${item.detected.content.trim()}`;
      if (!last.detected.name && item.detected.name) last.detected.name = item.detected.name;
      last.hasHeading = last.hasHeading || heading;
    }
  }

  return blocks.map((b) => b.detected);
}

async function buildUnit(node: StructureNode, d: DetectedUnit, sourceOrder: number): Promise<SemanticUnit> {
  const contentHash = await sha256(d.content);
  return {
    id: nextId(d.type),
    sourceNodeId: node.id,
    parentUnitId: null,
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
