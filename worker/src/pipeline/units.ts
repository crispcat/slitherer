import type { Env, SemanticUnit, SemanticUnitType, StructureNode } from "../types";
import { SEMANTIC_UNIT_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";
import { detectTableStructure, buildTableUnitsFromTree, decidePrevRuleLinking } from "./table_tree";
import { INGESTION } from "../config.gen";

interface DetectedUnit {
  type: SemanticUnitType;
  name: string;
  content: string;
  /** Set during orphan resolution or table tree building if this unit should be linked to a parent unit. */
  parentIndex?: number;
  /** Secondary parent (column tree parent for table units). */
  secondaryParentIndex?: number;
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

const ORPHAN_PROMPT_TEMPLATE = INGESTION.prompts.orphanResolution.text;
const ORPHAN_BOLD_HEADING_MAX = INGESTION.orphanResolution.boldHeadingMaxLength.value;
const ORPHAN_CONTENT_MAX = INGESTION.orphanResolution.contentMaxLength.value;
const ORPHAN_MAX_RETRIES = INGESTION.orphanResolution.maxRetries.value;

function buildOrphanResolutionPrompt(node: StructureNode, units: DetectedUnit[]): string {
  const sectionPath = node.path.length > 0 ? node.path.join(" > ") : "(root)";
  const unitList = units
    .map((u, i) => `--- Unit ${i} (${u.type}${u.name ? ", name: " + u.name : ""}) ---\n${u.content}`)
    .join("\n\n");

  return ORPHAN_PROMPT_TEMPLATE
    .replace("${node.type}", node.type)
    .replace("${sectionPath}", sectionPath)
    .replace("${node.content}", node.content)
    .replace("${unitList}", unitList);
}

function isOrphanCandidate(unit: DetectedUnit): boolean {
  // A short bold heading is a complete entity, not an orphan modifier.
  const firstLine = unit.content.trim().split("\n")[0].trim();
  if (firstLine.startsWith("**") && firstLine.length < ORPHAN_BOLD_HEADING_MAX) return false;

  // Short fragments, unnamed modifiers, and stat-like lines are the most common orphans.
  if (unit.content.length < ORPHAN_CONTENT_MAX) return true;
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
      { model: env.EXTRACTION_MODEL, maxRetries: ORPHAN_MAX_RETRIES, schema: ORPHAN_SCHEMA }
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
  parentUnitId: string | null = null,
  secondaryParentUnitId: string | null = null
): Promise<SemanticUnit> {
  const contentHash = await sha256(d.content);
  return {
    id: nextId(d.type),
    sourceNodeId: node.id,
    parentUnitId,
    secondaryParentUnitId,
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

/** Context from the previous leaf node's units, used to link tables to preceding rules. */
export interface PreviousUnitContext {
  id: string;
  content: string;
}

export async function detectSemanticUnits(
  env: Env,
  node: StructureNode,
  previousUnit?: PreviousUnitContext | null,
): Promise<SemanticUnit[]> {
  if (!node.content.trim()) return [];

  let detected: DetectedUnit[] = [];

  if (node.type === "table") {
    const structure = await detectTableStructure(env, node);
    detected = buildTableUnitsFromTree(node, structure);
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
    const secondaryParentUnitId =
      d.secondaryParentIndex !== undefined && d.secondaryParentIndex < i
        ? units[d.secondaryParentIndex].id
        : null;
    units.push(await buildUnit(node, { ...d, type }, i, parentUnitId, secondaryParentUnitId));
  }

  // For tables: if the LLM decides the table belongs to the preceding rule,
  // link the table's root unit(s) (those with parentUnitId === null) to the
  // previous rule's unit. This makes the entire table hierarchy a child of
  // the preceding rule, so retrieving the rule also retrieves its table data.
  if (node.type === "table" && previousUnit && units.length > 0) {
    const hasRootUnits = units.some((u) => u.parentUnitId === null);
    if (hasRootUnits) {
      try {
        const shouldLink = await decidePrevRuleLinking(env, node, previousUnit.content);
        if (shouldLink) {
          for (const u of units) {
            if (u.parentUnitId === null) {
              u.parentUnitId = previousUnit.id;
            }
          }
          console.log(`Linked table ${node.id} to previous rule ${previousUnit.id}`);
        }
      } catch (err) {
        console.warn(`Prev-rule linking failed for ${node.id}: ${String(err)}`);
      }
    }
  }

  return units;
}
