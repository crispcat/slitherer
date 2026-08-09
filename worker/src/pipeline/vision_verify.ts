/**
 * Post-processing of vision-extracted units.
 *
 * normalizeUnits maps unknown types to "Rule" and inherits empty section
 * paths from parent units. This is a mechanical transform — no verification
 * or issue detection is performed. The vision model output is trusted as-is.
 */
import { SEMANTIC_UNIT_TYPES } from "../types";
import type { VisionUnit } from "../types";

/**
 * Post-process units: fix empty sections by inheriting from parent,
 * map unknown types to "Rule".
 */
export function normalizeUnits(units: VisionUnit[]): VisionUnit[] {
  const validTypes = new Set<string>(SEMANTIC_UNIT_TYPES);
  const result = units.map((u) => ({ ...u }));

  // Build id → index map
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    idToIndex.set(result[i].id, i);
  }

  for (let i = 0; i < result.length; i++) {
    // Map unknown types to "Rule"
    if (!validTypes.has(result[i].type)) {
      result[i].type = "Rule";
    }

    // Inherit section from parent if empty
    if (result[i].section.length === 0 && result[i].parentId !== null) {
      const parentIdx = idToIndex.get(result[i].parentId!);
      if (parentIdx !== undefined && result[parentIdx].section.length > 0) {
        result[i].section = [...result[parentIdx].section];
      }
    }
  }

  return result;
}
