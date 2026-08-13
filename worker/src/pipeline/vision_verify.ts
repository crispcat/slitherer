/**
 * Post-processing of vision-extracted units.
 *
 * normalizeUnits maps unknown types to "Rule" and inherits empty section
 * paths from parent units. This is a mechanical transform — no verification
 * or issue detection is performed. The vision model output is trusted as-is.
 *
 * Phase 3: Added deterministic table type checking with parent precedence.
 */
import { SEMANTIC_UNIT_TYPES } from "../types";
import type { VisionUnit } from "../types";

const TABLE_TYPES = new Set(["DataTableHeader", "DataTableRow", "ColumnListTable", "ColumnListItem"]);
const DATA_TABLE_HEADER = "DataTableHeader";
const DATA_TABLE_ROW = "DataTableRow";
const COLUMN_LIST_TABLE = "ColumnListTable";
const COLUMN_LIST_ITEM = "ColumnListItem";

/**
 * Post-process units: fix empty sections by inheriting from parent,
 * map unknown types to "Rule", apply deterministic table type checking.
 */
export function normalizeUnits(units: VisionUnit[]): VisionUnit[] {
  const validTypes = new Set<string>(SEMANTIC_UNIT_TYPES);
  const result = units.map((u) => ({ ...u }));

  // Build id → index map
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    idToIndex.set(result[i].id, i);
  }

  // Step 1: Map unknown types to "Rule" and inherit sections
  for (let i = 0; i < result.length; i++) {
    if (!validTypes.has(result[i].type)) {
      result[i].type = "Rule";
    }

    if (result[i].section.length === 0 && result[i].parentId !== null) {
      const parentIdx = idToIndex.get(result[i].parentId!);
      if (parentIdx !== undefined && result[parentIdx].section.length > 0) {
        result[i].section = [...result[parentIdx].section];
      }
    }
  }

  // Step 2: Deterministic table type checking with parent precedence
  applyTableTypeRules(result, idToIndex);

  return result;
}

/** Apply deterministic table type rules with two-pass parent precedence.
 *
 *  Pass 1 (parent → children): If the parent is DataTableHeader or ColumnListTable,
 *  all children are reclassified to match. Parent wins.
 *
 *  Pass 2 (child → parent): Only fires when the parent is NOT already a table type.
 *  If a child is DataTableRow, reclassify parent to DataTableHeader.
 *  If a child is ColumnListItem, reclassify parent to ColumnListTable.
 *  Do not reclassify an existing ColumnListTable to DataTableHeader or vice versa. */
function applyTableTypeRules(units: VisionUnit[], idToIndex: Map<string, number>) {
  // Build parent → children map
  const parentToChildren = new Map<string, number[]>();
  for (let i = 0; i < units.length; i++) {
    const parentId = units[i].parentId;
    if (parentId !== null) {
      const arr = parentToChildren.get(parentId) ?? [];
      arr.push(i);
      parentToChildren.set(parentId, arr);
    }
  }

  // Pass 1: Parent controls children
  for (let i = 0; i < units.length; i++) {
    const parentType = units[i].type;
    if (parentType === DATA_TABLE_HEADER) {
      const children = parentToChildren.get(units[i].id) ?? [];
      for (const childIdx of children) {
        units[childIdx].type = DATA_TABLE_ROW;
      }
    } else if (parentType === COLUMN_LIST_TABLE) {
      const children = parentToChildren.get(units[i].id) ?? [];
      for (const childIdx of children) {
        units[childIdx].type = COLUMN_LIST_ITEM;
      }
    }
  }

  // Pass 2: Child can promote an ambiguous parent (only if parent is NOT already a table type)
  for (let i = 0; i < units.length; i++) {
    const childType = units[i].type;
    const parentId = units[i].parentId;
    if (!parentId) continue;

    const parentIdx = idToIndex.get(parentId);
    if (parentIdx === undefined) continue;

    const parentType = units[parentIdx].type;
    if (TABLE_TYPES.has(parentType)) continue; // Parent is already a table type — parent wins

    if (childType === DATA_TABLE_ROW) {
      units[parentIdx].type = DATA_TABLE_HEADER;
    } else if (childType === COLUMN_LIST_ITEM) {
      units[parentIdx].type = COLUMN_LIST_TABLE;
    }
  }
}
