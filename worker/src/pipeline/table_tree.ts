// ---- Table double-tree unitization (OHD-inspired) ----

import type { Env, SemanticUnitType, StructureNode } from "../types";
import { llmJson } from "../utils/llm";
import { INGESTION } from "../config.gen";

export interface DetectedUnit {
  type: SemanticUnitType;
  name: string;
  content: string;
  parentIndex?: number;
  secondaryParentIndex?: number;
}

interface TreeNode {
  id: number;
  type: "description" | "header" | "section" | "structural" | "subheader" | "data" | "visual";
  rows?: number[];
  cols?: number[];
  parent: number | null;
  label?: string;
}

interface TableStructure {
  row_tree: TreeNode[];
  column_tree: TreeNode[];
  reason: string;
}

// --- Phase 2a: Row refinement prompt ---
// The LLM receives the deterministic row skeleton and returns ONLY corrections.
const ROW_REFINEMENT_PROMPT = INGESTION.prompts.tableRowRefinement.text;

// --- Phase 2b: Column tree prompt ---
// The LLM builds the column tree from scratch, using the refined row skeleton as context.
const COLUMN_TREE_PROMPT = INGESTION.prompts.tableColumnTree.text;

// --- Phase 2c: Previous-rule linking prompt ---
// The LLM decides whether a table with no header/description belongs to the preceding rule.
const PREV_RULE_LINKING_PROMPT = INGESTION.prompts.tablePrevRuleLinking.text;

/** Check if a table line is a separator row (---, :--:, etc.).
 *  A separator row has ALL cells consisting only of dashes, colons, and spaces. */
function isSeparatorRow(trimmed: string): boolean {
  if (!trimmed.startsWith("|")) return false;
  const parts = trimmed.split("|").slice(1, -1);
  if (parts.length === 0) return false;
  return parts.every((c) => c.trim().length > 0 && /^[-:\s]+$/.test(c.trim()));
}

/** Parse a markdown table into a 2D grid of cells, with row indices.
 *  rowIndices uses the same numbering as buildPrefixedTable: every table line
 *  (including --- separators) gets an incrementing index. Separator rows are
 *  skipped from the cells array but still counted, so the indices match what
 *  the LLM sees in the [N]-prefixed prompt and returns in "rows" arrays. */
function parseTableGrid(content: string): { cells: string[][]; rowIndices: number[] } {
  const lines = content.split("\n");
  const cells: string[][] = [];
  const rowIndices: number[] = [];
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("|")) continue;
    if (isSeparatorRow(trimmed)) {
      idx++; // count separator but don't add to cells
      continue;
    }
    const parts = trimmed.split("|");
    const row = parts.slice(1, -1).map((c) => c.trim());
    cells.push(row);
    rowIndices.push(idx);
    idx++;
  }
  return { cells, rowIndices };
}

/** Check if all cells in a row are identical (merged-cell artifact). */
function isMergedRowCells(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const first = cells[0];
  if (!first) return false;
  return cells.every((c) => c === first);
}

/** Build a prefixed table representation for the LLM prompt.
 *  Every table line (including --- separators) gets an incrementing [N] index,
 *  matching the numbering in parseTableGrid and the prompt examples. */
function buildPrefixedTable(content: string): string {
  const lines = content.split("\n");
  let idx = 0;
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (isSeparatorRow(trimmed)) {
      result.push(`[${idx}] ${trimmed}  ← separator`);
      idx++;
      continue;
    }
    result.push(`[${idx}] ${trimmed}`);
    idx++;
  }
  return result.join("\n");
}

// ---- Phase 1: Deterministic Row Skeleton ----

interface RowCorrection {
  row?: number;
  new_role?: string;
  new_parent?: number;
  action?: string;
}

/** Build a deterministic row skeleton using only universal markdown table structure.
 *  - Row after --- separator → "header"
 *  - Merged row (all cells identical) → "structural"
 *  - Everything else → "data"
 *  - First row is root, all others link to the most recent structural/header node.
 *  - Each data node has exactly 1 row (no grouping).
 *  Guarantees: every row covered, exactly one root, valid parent chain. */
export function buildRowSkeleton(content: string): { rowTree: TreeNode[]; colCount: number } {
  const { cells, rowIndices } = parseTableGrid(content);
  if (cells.length === 0) return { rowTree: [], colCount: 0 };

  const colCount = cells[0].length;
  const rowTree: TreeNode[] = [];
  // In standard markdown tables, the header row comes BEFORE the --- separator.
  // Track which source row indices are immediately before a separator (headers)
  // and which are immediately after (first data row).
  const beforeSeparator = new Set<number>();
  const afterSeparator = new Set<number>();
  const lines = content.split("\n");
  let idx = 0;
  let prevIdx: number | null = null;
  let prevWasSeparator = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (isSeparatorRow(trimmed)) {
      if (prevIdx !== null) beforeSeparator.add(prevIdx);
      prevWasSeparator = true;
      idx++;
      continue;
    }
    if (prevWasSeparator) afterSeparator.add(idx);
    prevWasSeparator = false;
    prevIdx = idx;
    idx++;
  }

  let currentParentId: number | null = null;
  for (let i = 0; i < cells.length; i++) {
    const ri = rowIndices[i];
    const rowCells = cells[i];
    const merged = isMergedRowCells(rowCells);
    // Header = row immediately before a --- separator (standard markdown table header).
    const isHeader = beforeSeparator.has(ri);
    // If the pre-separator row was merged (structural/description), the
    // post-separator row is the actual column header (not data).
    const isHeaderAfterMergedDesc = afterSeparator.has(ri) && !merged
      && rowTree.length > 0 && rowTree[rowTree.length - 1].type === "structural";

    let type: TreeNode["type"];
    if (merged) {
      // Merged rows are structural (description/section), even if before a separator.
      type = "structural";
    } else if (pseudoHeaders.has(ri)) {
      // Deterministic pseudo-header: pre-separator row that's actually data.
      type = "data";
    } else if (isHeader || isHeaderAfterMergedDesc) {
      type = "header";
    } else {
      type = "data";
    }

    const nodeId = rowTree.length;
    // First node is always root. Subsequent nodes link to currentParentId
    // (which is the most recent structural/header node, or the first node
    // if no structural/header has been seen yet).
    const parent = i === 0 ? null : currentParentId;
    rowTree.push({ id: nodeId, type, rows: [ri], parent });

    // Update currentParentId:
    // - Structural and header nodes become the parent for subsequent data rows.
    // - For the first node, always set currentParentId (even if it's data)
    //   so that subsequent nodes have a parent to link to.
    if (type === "structural" || type === "header" || i === 0) {
      currentParentId = nodeId;
    }
  }

  return { rowTree, colCount };
}

/** Format the row skeleton for the LLM prompt. */
function formatRowSkeleton(rowTree: TreeNode[]): string {
  return rowTree.map((tn) => {
    const rows = tn.rows ?? [];
    const parentStr = tn.parent === null ? "null" : `[${tn.parent}]`;
    return `[${rows[0]}] ${tn.type} → parent: ${parentStr}`;
  }).join("\n");
}

/** Format the row skeleton (by source row index) for the column tree prompt. */
function formatRowSkeletonForColumnPrompt(rowTree: TreeNode[]): string {
  return rowTree.map((tn) => {
    const rows = tn.rows ?? [];
    return `[${rows[0]}] ${tn.type}`;
  }).join("\n");
}

// ---- Phase 2a: Row Refinement ----

/** Validate and apply row corrections to the skeleton.
 *  Returns the refined row tree. Invalid corrections are silently skipped.
 *  `allowVisual` overrides the data-row-count guard for visual reclassification. */
export function applyRowCorrections(
  rowTree: TreeNode[],
  corrections: RowCorrection[],
  allowVisual = false,
): TreeNode[] {
  // Check for "visual" action — reclassify entire table.
  // Guard: only allow visual if the table has very few data rows (≤2),
  // or if allowVisual is set (caller determined the table is a grid/diagram).
  if (corrections.some((c) => c.action === "visual")) {
    const dataRowCount = rowTree.filter((tn) => tn.type === "data").length;
    if (allowVisual || dataRowCount <= INGESTION.tableProcessing.visualReclassificationMaxDataRows.value) {
      const allRows = rowTree.flatMap((tn) => tn.rows ?? []);
      return [{ id: 0, type: "visual", rows: allRows, parent: null }];
    }
    // Ignore visual reclassification for tables with substantial data.
  }

  // Build a map from source row index → tree node id.
  const rowIdxToNodeId = new Map<number, number>();
  for (const tn of rowTree) {
    for (const ri of tn.rows ?? []) {
      rowIdxToNodeId.set(ri, tn.id);
    }
  }

  // Work on a copy.
  const refined = rowTree.map((tn) => ({ ...tn, rows: [...(tn.rows ?? [])] }));

  for (const corr of corrections) {
    if (corr.row === undefined) continue;
    const nodeId = rowIdxToNodeId.get(corr.row);
    if (nodeId === undefined) continue; // invalid row index

    const node = refined.find((tn) => tn.id === nodeId);
    if (!node) continue;

    // Apply role reclassification.
    if (corr.new_role) {
      const validRoles = ["description", "header", "section", "data", "structural"];
      if (!validRoles.includes(corr.new_role)) continue;
      // The root node (parent === null) can be reclassified between "header"
      // and "data" freely — this is the common pseudo-header case where the
      // first row before --- is actually data, not a column header. The root
      // stays the root regardless of its type, so the single-root guarantee
      // is preserved.
      node.type = corr.new_role as TreeNode["type"];
    }

    // Apply reparenting.
    if (corr.new_parent !== undefined) {
      const newParentNodeId = rowIdxToNodeId.get(corr.new_parent);
      if (newParentNodeId === undefined) continue; // invalid parent row
      // Don't allow reparenting the root.
      if (node.parent === null) continue;
      // Don't allow self-parenting.
      if (newParentNodeId === nodeId) continue;
      // Don't allow parenting to a later row (would create cycles).
      const targetNode = refined.find((tn) => tn.id === newParentNodeId);
      if (!targetNode) continue;
      const targetRow = targetNode.rows?.[0] ?? Infinity;
      if (targetRow > corr.row) continue;
      // Check for cycles: walk up from new parent, ensure we don't reach this node.
      let checkNode: number | null = newParentNodeId;
      let safe = true;
      while (checkNode !== null) {
        if (checkNode === nodeId) { safe = false; break; }
        const n = refined.find((tn) => tn.id === checkNode);
        if (!n) break;
        checkNode = n.parent;
      }
      if (!safe) continue;
      node.parent = newParentNodeId;
    }
  }

  return refined;
}

/** Refine the row skeleton via LLM. Retries once on failure. */
async function refineRowSkeleton(
  env: Env,
  node: StructureNode,
  rowTree: TreeNode[],
  prefixed: string,
  allowVisual = false,
): Promise<TreeNode[]> {
  const skeletonStr = formatRowSkeleton(rowTree);
  const prompt = ROW_REFINEMENT_PROMPT
    .replace("{{SKELETON}}", skeletonStr)
    .replace("{{TABLE_CONTENT}}", prefixed);

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const corrections = await llmJson<RowCorrection[]>(
        env,
        prompt,
        "Return a JSON array of corrections. If none needed, return [].",
        { model: env.ANSWER_MODEL, maxRetries: INGESTION.tableProcessing.rowRefinementMaxRetries.value }
      );

      if (!Array.isArray(corrections)) {
        console.warn(`Row refinement for ${node.id}: not an array, using skeleton`);
        return rowTree;
      }

      const refined = applyRowCorrections(rowTree, corrections, allowVisual);
      console.log(`Row refinement for ${node.id}: ${corrections.length} corrections, skeleton=${rowTree.length} → refined=${refined.length} nodes`);
      return refined;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`Row refinement attempt 1 failed for ${node.id}, retrying: ${String(err)}`);
      } else {
        console.warn(`Row refinement failed for ${node.id}, using skeleton: ${String(err)}`);
        return rowTree;
      }
    }
  }
  return rowTree;
}

// ---- Phase 2b: Column Tree Detection ----

interface ColumnTreeResult {
  column_tree: TreeNode[];
  reason: string;
}

/** Detect the column tree via LLM, using the refined row skeleton as context. */
async function detectColumnTree(
  env: Env,
  node: StructureNode,
  rowTree: TreeNode[],
  prefixed: string,
  colCount: number
): Promise<TreeNode[]> {
  const skeletonStr = formatRowSkeletonForColumnPrompt(rowTree);
  const prompt = COLUMN_TREE_PROMPT
    .replace("{{ROW_SKELETON}}", skeletonStr)
    .replace("{{TABLE_CONTENT}}", prefixed);

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const raw = await llmJson<ColumnTreeResult>(
        env,
        prompt,
        "Return the JSON object with the column tree.",
        { model: env.ANSWER_MODEL, maxRetries: INGESTION.tableProcessing.columnTreeMaxRetries.value }
      );

      if (!raw?.column_tree || !Array.isArray(raw.column_tree) || raw.column_tree.length === 0) {
        console.warn(`Column tree for ${node.id}: empty, using fallback`);
        break;
      }

      // Validate: all columns covered, no overlaps.
      const allCols = new Set<number>();
      for (let i = 0; i < colCount; i++) allCols.add(i);
      const coveredCols = new Set<number>();
      for (const tn of raw.column_tree) {
        for (const c of tn.cols ?? []) coveredCols.add(c);
      }
      // Accept if all columns are covered (extra columns are OK, we'll filter later).
      let allCovered = true;
      for (const c of allCols) {
        if (!coveredCols.has(c)) { allCovered = false; break; }
      }
      if (!allCovered) {
        console.warn(`Column tree for ${node.id}: not all columns covered, using fallback`);
        break;
      }

      console.log(`Column tree for ${node.id}: ${raw.column_tree.length} nodes: ${raw.reason ?? "no reason"}`);
      return raw.column_tree;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`Column tree attempt 1 failed for ${node.id}, retrying: ${String(err)}`);
      } else {
        console.warn(`Column tree failed for ${node.id}, using fallback: ${String(err)}`);
        break;
      }
    }
  }

  // Fallback: one data node with all columns.
  return [{ id: 0, type: "data", cols: Array.from({ length: colCount }, (_, i) => i), parent: null }];
}

// ---- Main: Detect Table Structure ----

/** Detect table structure via deterministic skeleton + LLM refinement. */
export async function detectTableStructure(env: Env, node: StructureNode): Promise<TableStructure> {
  const { rowTree, colCount } = buildRowSkeleton(node.content);

  if (rowTree.length === 0) {
    return { row_tree: [], column_tree: [], reason: "empty table" };
  }

  // Visual table (single visual node from skeleton or refinement).
  if (rowTree.length === 1 && rowTree[0].type === "visual") {
    return {
      row_tree: rowTree,
      column_tree: [{ id: 0, type: "visual", cols: Array.from({ length: colCount }, (_, i) => i), parent: null }],
      reason: "visual",
    };
  }

  const prefixed = buildPrefixedTable(node.content);

  // Compute fill ratio to detect visual grids (many empty cells).
  // If < 70% of cells are non-empty, the table is likely a grid/diagram.
  const { cells: gridCells, rowIndices: gridRowIndices } = parseTableGrid(node.content);
  const totalCells = gridCells.reduce((sum, row) => sum + row.length, 0);
  const nonEmptyCells = gridCells.reduce((sum, row) => sum + row.filter((c) => c).length, 0);
  const fillRatio = totalCells > 0 ? nonEmptyCells / totalCells : 1;
  const allowVisual = fillRatio < INGESTION.tableProcessing.visualCollapseFillRatio.value;

  // Phase 2a: Refine row skeleton.
  const refinedRowTree = await refineRowSkeleton(env, node, rowTree, prefixed, allowVisual);

  // Check if refinement reclassified the table as visual.
  if (refinedRowTree.length === 1 && refinedRowTree[0].type === "visual") {
    return {
      row_tree: refinedRowTree,
      column_tree: [{ id: 0, type: "visual", cols: Array.from({ length: colCount }, (_, i) => i), parent: null }],
      reason: "visual (LLM reclassified)",
    };
  }

  // Phase 2b: Detect column tree.
  const columnTree = await detectColumnTree(env, node, refinedRowTree, prefixed, colCount);

  // Apply deterministic overrides for ambiguous 2-col tables and sparse grids.
  // These rules override the LLM when there's a clear structural signal.
  const overriddenColumnTree = overrideColumnTree(columnTree, gridCells, gridRowIndices, refinedRowTree, fillRatio, colCount);

  // Deduplicate column headers: if two header nodes cover the same columns and
  // would produce the same content, merge them (remap data node parents).
  // This fixes MULTI-MERGED tables where the LLM creates duplicate header hierarchies.
  const dedupedColumnTree = deduplicateColumnHeaders(overriddenColumnTree, refinedRowTree, node.content);

  return { row_tree: refinedRowTree, column_tree: dedupedColumnTree, reason: "skeleton + LLM refinement" };
}

// ---- Phase 2c: Previous-Rule Linking ----

interface PrevRuleLinkingResult {
  link: boolean;
  reason: string;
}

/** Ask the LLM whether a table with no header/description belongs to the preceding rule.
 *  If yes, the table's root units should be linked to the previous rule's unit.
 *  Only the first few rows of the table are sent — enough for the LLM to judge
 *  the table's structure and relationship to the previous rule. */
export async function decidePrevRuleLinking(
  env: Env,
  node: StructureNode,
  previousRuleContent: string,
): Promise<boolean> {
  const maxChars = INGESTION.tableProcessing.prevRuleContentMaxChars.value;
  const truncatedPrev = previousRuleContent.slice(0, maxChars);
  const previewRows = INGESTION.tableProcessing.prevRuleTablePreviewRows.value;
  const tableLines = node.content.split("\n").filter((l) => l.trim().startsWith("|"));
  const truncatedTable = tableLines.slice(0, previewRows).join("\n");
  const prompt = PREV_RULE_LINKING_PROMPT
    .replace("{{PREVIOUS_RULE_CONTENT}}", truncatedPrev)
    .replace("{{TABLE_CONTENT}}", truncatedTable);

  for (let attempt = 0; attempt <= INGESTION.tableProcessing.prevRuleLinkingMaxRetries.value; attempt++) {
    try {
      const result = await llmJson<PrevRuleLinkingResult>(
        env,
        prompt,
        "Return the JSON object with the linking decision.",
        { model: env.ANSWER_MODEL, maxRetries: INGESTION.tableProcessing.prevRuleLinkingMaxRetries.value },
      );

      if (result && typeof result.link === "boolean") {
        console.log(`Prev-rule linking for ${node.id}: link=${result.link}, reason=${result.reason ?? "none"}`);
        return result.link;
      }
      console.warn(`Prev-rule linking for ${node.id}: invalid response, defaulting to no link`);
      return false;
    } catch (err) {
      if (attempt === 0) {
        console.warn(`Prev-rule linking attempt 1 failed for ${node.id}, retrying: ${String(err)}`);
      } else {
        console.warn(`Prev-rule linking failed for ${node.id}, defaulting to no link: ${String(err)}`);
        return false;
      }
    }
  }
  return false;
}

/** Apply deterministic overrides to the column tree based on structural signals.
 *  These rules override the LLM only when there's a clear, language-agnostic
 *  AND document-agnostic structural signal:
 *  1. Table with a merged description row (all cells identical before the header)
 *     AND ALL col 0 data values being short integers (0-999) → SIMPLE
 *     (the merged description indicates the table describes one entity; the
 *     numeric col 0 indicates sequential keys/levels with properties in other
 *     columns. Both signals together are a strong, portable indicator.)
 *  2. Very sparse, wide grid (fillRatio < 0.6, ncols > 10) → VISUAL
 *
 *  Note: We require BOTH a merged description row AND numeric col 0 because
 *  numeric col 0 alone is not sufficient — a table like "| # | List A | List B |"
 *  with row numbers has numeric col 0 but the columns may be independent lists.
 *  The merged description row is a structural pattern that indicates the table
 *  is a property/reference table for a single entity, which makes SIMPLE the
 *  correct choice. Without it, the decision is left to the LLM.
 *
 *  We also do NOT override non-numeric tables to SPLIT because that would break
 *  common patterns like Name|Description, Item|Price, Question|Answer which are
 *  SIMPLE (one entity per row). */
function overrideColumnTree(
  columnTree: TreeNode[],
  gridCells: string[][],
  gridRowIndices: number[],
  rowTree: TreeNode[],
  fillRatio: number,
  colCount: number,
): TreeNode[] {
  // Rule 2: Very sparse, wide grid → force visual.
  if (fillRatio < INGESTION.tableProcessing.sparseGridFillRatio.value && colCount > INGESTION.tableProcessing.sparseGridColumnCount.value) {
    return [{ id: 0, type: "visual", cols: Array.from({ length: colCount }, (_, i) => i), parent: null }];
  }

  // Check for a merged description row: a row before the header where all cells
  // are identical. This is a structural pattern (not content-dependent) that
  // indicates the table describes properties of one entity.
  let hasMergedDescription = false;
  for (const tn of rowTree) {
    if (tn.type === "structural") {
      const tnRows = tn.rows ?? [];
      for (const ri of tnRows) {
        const cellIdx = gridRowIndices.indexOf(ri);
        if (cellIdx >= 0) {
          const row = gridCells[cellIdx];
          if (row && row.length >= 2 && row.every((c) => c === row[0]) && row[0].trim()) {
            hasMergedDescription = true;
            break;
          }
        }
      }
      if (hasMergedDescription) break;
    }
  }

  if (!hasMergedDescription) return columnTree;

  // Build a map from source row index → gridCells index.
  const rowToCellIdx = new Map<number, number>();
  for (let i = 0; i < gridRowIndices.length; i++) {
    rowToCellIdx.set(gridRowIndices[i], i);
  }

  // Get col 0 values from DATA rows only (using the row tree to identify them).
  // Skip merged rows (all cells identical) since those are typically section
  // headers or descriptions that were reclassified as data by the LLM.
  const col0Values: string[] = [];
  for (const tn of rowTree) {
    if (tn.type !== "data") continue;
    const rows = tn.rows ?? [];
    for (const ri of rows) {
      const cellIdx = rowToCellIdx.get(ri);
      if (cellIdx !== undefined) {
        const row = gridCells[cellIdx];
        if (!row) continue;
        // Skip merged rows (all cells identical).
        if (row.length >= 2 && row.every((c) => c === row[0])) continue;
        const val = row[0];
        if (val && val.trim()) col0Values.push(val.trim());
      }
    }
  }

  if (col0Values.length === 0) return columnTree;

  // Rule 1: Merged description row + ALL col 0 values are short integers
  // → force SIMPLE (one data node with ALL columns).
  const allNumeric = col0Values.every((v) => /^\d{1,3}$/.test(v));
  if (allNumeric) {
    const allCols = Array.from({ length: colCount }, (_, i) => i);
    const hasSimple = columnTree.some(
      (tn) => tn.type === "data" && (tn.cols ?? []).length === colCount,
    );
    if (!hasSimple) {
      return [
        { id: 0, type: "header", cols: allCols, parent: null },
        { id: 1, type: "data", cols: allCols, parent: 0 },
      ];
    }
  }

  return columnTree;
}

/** Deduplicate column tree nodes that cover the same columns.
 *  When two nodes (header or data) have identical cols arrays, the second one
 *  is removed and any children pointing to it are reparented to the first.
 *  This fixes MULTI-MERGED tables where the LLM creates duplicate column
 *  hierarchies for each section, causing data duplication. */
function deduplicateColumnHeaders(
  columnTree: TreeNode[],
  _rowTree: TreeNode[],
  _content: string,
): TreeNode[] {
  // Find duplicate nodes (same cols, same type).
  const nodeByCols = new Map<string, number>(); // colsKey → first node id
  const remap = new Map<number, number>(); // old id → new id (for reparenting)
  const result: TreeNode[] = [];

  for (const tn of columnTree) {
    // Only deduplicate header and data nodes (not structural/root).
    if (tn.type === "header" || tn.type === "data") {
      const colsKey = `${tn.type}:${(tn.cols ?? []).join(",")}`;
      const existingId = nodeByCols.get(colsKey);
      if (existingId !== undefined) {
        // Duplicate — remap this node's id to the existing one.
        remap.set(tn.id, existingId);
        continue; // skip this duplicate
      }
      nodeByCols.set(colsKey, tn.id);
    }
    result.push(tn);
  }

  // If no duplicates found, return as-is.
  if (remap.size === 0) return columnTree;

  // Remap parent references in remaining nodes.
  for (const tn of result) {
    if (tn.parent !== null && remap.has(tn.parent)) {
      tn.parent = remap.get(tn.parent)!;
    }
  }

  return result;
}

/** Build semantic units from the double-tree structure. */
export function buildTableUnitsFromTree(node: StructureNode, structure: TableStructure): DetectedUnit[] {
  const { row_tree, column_tree } = structure;
  if (row_tree.length === 0) return [{ type: "Table", name: "", content: node.content }];

  const { cells, rowIndices } = parseTableGrid(node.content);
  if (cells.length === 0) return [];

  // Map source row index → cells index.
  const rowToCellsIdx = new Map<number, number>();
  rowIndices.forEach((ri, i) => rowToCellsIdx.set(ri, i));

  // Handle visual tables: one unit with full content.
  if (row_tree.length === 1 && row_tree[0].type === "visual") {
    return [{ type: "Table", name: "", content: node.content }];
  }

  const units: DetectedUnit[] = [];

  // Map tree node ids → unit array indices (for parent linking).
  // We create units in this order:
  // 1. Row tree non-data nodes (description, header, section, structural)
  // 2. Column tree non-data nodes (column headers)
  // 3. Data units (row tree data × column tree data)

  const rowNodeToUnitIdx = new Map<number, number>();
  const colNodeToUnitIdx = new Map<number, number>();

  // 1. Create units for row tree structural nodes (description, header, section, structural).
  for (const tn of row_tree) {
    if (tn.type === "data" || tn.type === "visual") continue;
    const tnRows = tn.rows ?? [];
    // Build content from the row's cells (collapsed if merged).
    const contentParts: string[] = [];
    for (const ri of tnRows) {
      const ci = rowToCellsIdx.get(ri);
      if (ci === undefined) continue;
      const row = cells[ci];
      if (isMergedRowCells(row)) {
        contentParts.push(`| ${row[0]} |`);
      } else {
        contentParts.push(`| ${row.join(" | ")} |`);
      }
    }
    const content = contentParts.join("\n");
    if (!content) continue;
    const parentUnitIdx = tn.parent !== null ? rowNodeToUnitIdx.get(tn.parent) : undefined;
    rowNodeToUnitIdx.set(tn.id, units.length);
    units.push({
      type: "Table",
      name: tn.label ?? "",
      content,
      parentIndex: parentUnitIdx,
    });
  }

  // 2. Create units for column tree structural nodes (headers).
  // Column headers link to the row-tree structural node that the data nodes
  // point to as their parent (the "table header"). This gives the hierarchy:
  // row-tree header → column header → data items.
  // Fallback: if data nodes have no parent, use the first non-data row-tree node.
  const firstDataNode = row_tree.find((r) => r.type === "data");
  const tableHeaderTreeNode = firstDataNode?.parent !== null && firstDataNode?.parent !== undefined
    ? row_tree.find((r) => r.id === firstDataNode.parent)
    : row_tree.find((r) => r.type !== "data" && r.type !== "visual");
  const rowHeaderUnitIdx = tableHeaderTreeNode
    ? rowNodeToUnitIdx.get(tableHeaderTreeNode.id)
    : undefined;
  for (const tn of column_tree) {
    if (tn.type === "data" || tn.type === "visual") continue;
    const tnCols = tn.cols ?? [];
    // Build content from the header row's cells for these columns.
    let contentCells: string[] = [];
    if (tableHeaderTreeNode && tableHeaderTreeNode.rows && tableHeaderTreeNode.rows.length > 0) {
      const ci = rowToCellsIdx.get(tableHeaderTreeNode.rows[0]);
      if (ci !== undefined) {
        contentCells = tnCols.map((c) => cells[ci][c] ?? "").filter((c) => c);
      }
    }
    const content = contentCells.length > 0 ? `| ${contentCells.join(" | ")} |` : tn.label ?? "";
    if (!content) continue;

    // Skip if this column header produces the same content as the row header
    // unit (happens in SIMPLE tables where one column header covers all columns
    // and the row header already contains the full header row).
    if (rowHeaderUnitIdx !== undefined && units[rowHeaderUnitIdx].content === content) {
      // Map this column node to the existing row header unit so data nodes
      // can still reference it as their parent.
      colNodeToUnitIdx.set(tn.id, rowHeaderUnitIdx);
      continue;
    }

    // If the column tree node has its own parent, use it; otherwise link to the
    // row-tree header unit so column headers are children of the table header.
    // Fall back to rowHeaderUnitIdx if the column parent is not found (invalid ref).
    const parentUnitIdx = tn.parent !== null
      ? (colNodeToUnitIdx.get(tn.parent) ?? rowHeaderUnitIdx)
      : rowHeaderUnitIdx;
    colNodeToUnitIdx.set(tn.id, units.length);
    units.push({
      type: "Table",
      name: tn.label ?? "",
      content,
      parentIndex: parentUnitIdx,
    });
  }

  // 3. Create data units: one per row in each row-tree data node × column-tree data node.
  // Each row becomes its own semantic unit for independent retrieval/embedding.
  // Parent linking:
  // - If the row node's parent is another DATA node (e.g. spell description → name),
  //   chain to that data row as primary parent. Column header is secondary.
  // - Otherwise: column header is the primary parent (hierarchy:
  //   row-tree header → column header → data item). Row-tree parent is secondary.
  // Data nodes are processed in tree order (parents before children) so that
  // data→data chaining can reference already-created parent units.
  const dataNodes = row_tree.filter((tn) => tn.type === "data");
  // Sort by parent chain depth so parents are processed before children.
  const nodeDepth = new Map<number, number>();
  function getDepth(id: number): number {
    if (nodeDepth.has(id)) return nodeDepth.get(id)!;
    const node = row_tree.find((r) => r.id === id);
    if (!node || node.parent === null) { nodeDepth.set(id, 0); return 0; }
    const d = getDepth(node.parent) + 1;
    nodeDepth.set(id, d);
    return d;
  }
  dataNodes.sort((a, b) => getDepth(a.id) - getDepth(b.id));

  // Track the first unit index created for each data node (for data→data chaining).
  const dataNodeToFirstUnitIdx = new Map<number, number>();

  // Track (rowIndex, validColsKey) pairs to avoid creating duplicate units
  // when multiple column data nodes cover the same columns for a row.
  const seenRowColPairs = new Set<string>();

  // Count column-tree data nodes. If there are multiple (SPLIT columns),
  // a root data node (pseudo-header reclassified to data) is redundant —
  // its column-split children already cover the content. Skip it so its
  // children become roots and link to the table's parent (previous rule).
  const colDataNodes = column_tree.filter((tn) => tn.type === "data");
  const isSplitColumns = colDataNodes.length > 1;

  for (const rowNode of dataNodes) {
    // Skip root data nodes in SPLIT tables — they're pseudo-headers whose
    // content is fully covered by their column-split children.
    if (isSplitColumns && rowNode.parent === null) continue;

    const rowParentNode = rowNode.parent !== null
      ? row_tree.find((r) => r.id === rowNode.parent)
      : undefined;
    const rowParentIsData = rowParentNode?.type === "data";
    // For data→data chaining, use the first unit of the parent data node.
    // For non-data parents, use the structural unit index from phase 1.
    const rowParentIdx = rowParentIsData
      ? (rowNode.parent !== null ? dataNodeToFirstUnitIdx.get(rowNode.parent) : undefined)
      : (rowNode.parent !== null ? rowNodeToUnitIdx.get(rowNode.parent) : rowHeaderUnitIdx);
    const rowRows = rowNode.rows ?? [];

    for (const colNode of column_tree) {
      if (colNode.type !== "data") continue;
      const colParentIdx = colNode.parent !== null ? colNodeToUnitIdx.get(colNode.parent) : undefined;
      const colCols = colNode.cols ?? [];

      for (const ri of rowRows) {
        const ci = rowToCellsIdx.get(ri);
        if (ci === undefined) continue;
        const row = cells[ci];

        // Skip rows where all cells are empty (visual/diagram tables).
        if (row.every((c) => !c.trim())) continue;

        // Filter out column indices beyond this row's width.
        // This prevents duplication when multiple column data nodes exist for
        // different sections of the table (e.g. one with cols=[0,1,2,3,4] for
        // a 5-col section and another with cols=[0,1,2,3] for a 4-col section).
        const validCols = colCols.filter((c) => c < row.length);
        if (validCols.length === 0) continue;

        // Skip if we've already processed this (row, cols) combination.
        // This prevents duplicate units when two column data nodes resolve to
        // the same valid columns for a given row.
        const pairKey = `${ri}:${validCols.join(",")}`;
        if (seenRowColPairs.has(pairKey)) continue;
        seenRowColPairs.add(pairKey);

        let content: string;
        if (isMergedRowCells(row)) {
          // Merged rows in data context: include only if col covers all columns.
          if (validCols.length !== row.length) continue;
          content = `| ${row[0]} |`;
        } else {
          const selectedCells = validCols.map((c) => row[c] ?? "").filter((c) => c);
          if (selectedCells.length === 0) continue;
          content = `| ${selectedCells.join(" | ")} |`;
        }
        if (!content.trim()) continue;

        let primaryParent: number | undefined;
        let secondaryParent: number | undefined;
        if (rowParentIsData) {
          // Data→data chaining (e.g. spell description chains to spell name).
          primaryParent = rowParentIdx;
          secondaryParent = colParentIdx;
        } else if (colParentIdx !== undefined) {
          primaryParent = colParentIdx;
          secondaryParent = rowParentIdx;
        } else {
          primaryParent = rowParentIdx;
        }

        const unitIdx = units.length;
        // Track the first unit for this data node (for potential children).
        if (!dataNodeToFirstUnitIdx.has(rowNode.id)) {
          dataNodeToFirstUnitIdx.set(rowNode.id, unitIdx);
        }
        units.push({
          type: "Table",
          name: rowNode.label ?? "",
          content,
          parentIndex: primaryParent,
          secondaryParentIndex: secondaryParent,
        });
      }
    }
  }

  return units;
}
