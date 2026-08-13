/**
 * Phase 7 — Evidence selection and hierarchical context reconstruction.
 *
 * Given a pool of reranked candidates, select the best evidence units to pass
 * to the answer model. The selection is deterministic and follows these rules:
 *
 * 1. Sort by final_score (descending).
 * 2. Remove near duplicates (by content hash and hierarchy/content overlap).
 * 3. Guarantee subquery coverage (at least one candidate per subquery if possible).
 * 4. Prefer direct retrieval when scores are comparable (within comparableScoreDelta).
 * 5. Preserve complementary rules (identified from metadata `mentions` field —
 *    matched against candidate names/aliases).
 * 6. Enforce the hard evidence budget.
 *
 * For list queries (isListQuery: true), the normal cap is skipped — all candidates
 * that passed the rerank threshold are included.
 *
 * Hierarchical context reconstruction: for each selected evidence unit, include
 * its parent chain (names only) to provide structural context to the answer model.
 */
import type { SemanticUnit, UnitMetadata } from "../types";
import type { RetrievedUnit } from "./query";
import { RETRIEVAL } from "../config.gen";

const EVIDENCE_BUDGET = RETRIEVAL.evidence.budget.value;
const EVIDENCE_MAX_BUDGET = RETRIEVAL.evidence.maxBudget.value;
const COMPARABLE_SCORE_DELTA = RETRIEVAL.evidence.comparableScoreDelta.value;

/** Metadata fields that identify complementary rules.
 *  With the simplified metadata schema, `mentions` covers all relationships
 *  (references, requires, exceptions, modifies, etc.) that were previously
 *  split across multiple fields. `defines` is not complementary — it's the
 *  primary definition, not a cross-reference. */
const COMPLEMENTARY_FIELDS: (keyof UnitMetadata)[] = [
  "mentions",
];

export interface SelectedEvidence {
  unit: SemanticUnit;
  finalScore: number;
  rerankScore: number;
  /** Hierarchical context: parent chain names (root → immediate parent). */
  parentChain: string[];
  /** Whether this unit was found via direct retrieval. */
  directHit: boolean;
  /** Which sub-queries found this candidate. */
  sourceSubQueries: number[];
}

/** Select evidence from a pool of reranked candidates.
 *
 *  @param candidates The reranked candidate pool.
 *  @param subQueryCount Total number of sub-queries (for coverage check).
 *  @param isListQuery If true, skip the normal cap — include all candidates
 *                     that passed the rerank threshold.
 *  @param allUnits Optional map of all units (for parent chain reconstruction
 *                  and complementary rule matching). If not provided, parent
 *                  chains will be incomplete. */
export function selectEvidence(
  candidates: RetrievedUnit[],
  subQueryCount: number,
  isListQuery: boolean = false,
  allUnits?: Map<string, SemanticUnit>,
): SelectedEvidence[] {
  if (candidates.length === 0) return [];

  // Rule 1: Sort by final score (descending)
  const sorted = [...candidates].sort(
    (a, b) => (b.finalScore ?? (b.rerankScore ?? 0)) - (a.finalScore ?? (a.rerankScore ?? 0))
  );

  // For list queries: include all candidates, no cap
  if (isListQuery) {
    return sorted.map((c) => toSelectedEvidence(c, allUnits));
  }

  // Rule 2: Remove near duplicates
  const deduped = removeNearDuplicates(sorted);

  // Rule 3: Guarantee subquery coverage
  const withCoverage = guaranteeSubqueryCoverage(deduped, subQueryCount);

  // Rule 4: Prefer direct retrieval when scores are comparable
  const withDirectHitPreference = preferDirectRetrieval(withCoverage, COMPARABLE_SCORE_DELTA);

  // Rule 5: Preserve complementary rules
  const withComplementary = preserveComplementaryRules(withDirectHitPreference, sorted, allUnits);

  // Rule 6: Enforce the hard evidence budget
  const budget = Math.min(EVIDENCE_BUDGET, EVIDENCE_MAX_BUDGET);
  const final = withComplementary.slice(0, budget);

  return final.map((c) => toSelectedEvidence(c, allUnits));
}

/** Convert a RetrievedUnit to a SelectedEvidence with parent chain reconstruction. */
function toSelectedEvidence(
  candidate: RetrievedUnit,
  allUnits?: Map<string, SemanticUnit>,
): SelectedEvidence {
  const parentChain = reconstructParentChain(candidate.unit, allUnits);
  const directHit = candidate.provenance?.sources.some(
    (s) => s.type === "vector_subject" || s.type === "vector_content" || s.type === "lexical"
  ) ?? false;

  return {
    unit: candidate.unit,
    finalScore: candidate.finalScore ?? candidate.rerankScore ?? 0,
    rerankScore: candidate.rerankScore ?? 0,
    parentChain,
    directHit,
    sourceSubQueries: candidate.sourceSubQueries ?? [],
  };
}

/** Reconstruct the parent chain for a unit (root → immediate parent).
 *  Returns parent names only — not full content — to provide structural context. */
function reconstructParentChain(unit: SemanticUnit, allUnits?: Map<string, SemanticUnit>): string[] {
  const chain: string[] = [];
  let currentId = unit.parentUnitId;
  const visited = new Set<string>(); // guard against cycles

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = allUnits?.get(currentId);
    if (!parent) break;
    if (parent.name) chain.unshift(parent.name);
    currentId = parent.parentUnitId;
  }

  return chain;
}

/** Rule 2: Remove near duplicates.
 *  Two candidates are near-duplicates if:
 *  - They have the same content hash, OR
 *  - One is a parent of the other AND their content overlaps significantly */
function removeNearDuplicates(candidates: RetrievedUnit[]): RetrievedUnit[] {
  const result: RetrievedUnit[] = [];
  const seenHashes = new Set<string>();
  const seenIds = new Set<string>();

  for (const candidate of candidates) {
    // Skip if same content hash already seen
    if (candidate.unit.contentHash && seenHashes.has(candidate.unit.contentHash)) continue;

    // Skip if same unit ID already seen
    if (seenIds.has(candidate.unit.id)) continue;

    // Skip if this unit is a parent of an already-selected unit (or vice versa)
    const isDuplicateParent = result.some((r) =>
      r.unit.parentUnitId === candidate.unit.id ||
      candidate.unit.parentUnitId === r.unit.id
    );

    if (isDuplicateParent) {
      // Keep the one with the higher score (already in result since we process in score order)
      continue;
    }

    result.push(candidate);
    if (candidate.unit.contentHash) seenHashes.add(candidate.unit.contentHash);
    seenIds.add(candidate.unit.id);
  }

  return result;
}

/** Rule 3: Guarantee subquery coverage.
 *  Ensure at least one candidate per subquery index if possible. */
function guaranteeSubqueryCoverage(candidates: RetrievedUnit[], subQueryCount: number): RetrievedUnit[] {
  if (subQueryCount <= 1) return candidates;

  const result: RetrievedUnit[] = [];
  const coveredSubqueries = new Set<number>();
  const addedIds = new Set<string>();

  // First pass: ensure at least one candidate per subquery
  for (let sqIdx = 0; sqIdx < subQueryCount; sqIdx++) {
    const candidate = candidates.find(
      (c) => !addedIds.has(c.unit.id) && c.sourceSubQueries?.includes(sqIdx)
    );
    if (candidate) {
      result.push(candidate);
      addedIds.add(candidate.unit.id);
      coveredSubqueries.add(sqIdx);
    }
  }

  // Second pass: add remaining candidates in score order
  for (const candidate of candidates) {
    if (!addedIds.has(candidate.unit.id)) {
      result.push(candidate);
      addedIds.add(candidate.unit.id);
    }
  }

  return result;
}

/** Rule 4: Prefer direct retrieval when scores are comparable.
 *  When two adjacent candidates have final scores within comparableScoreDelta,
 *  prefer the one with directHit=true. */
function preferDirectRetrieval(candidates: RetrievedUnit[], delta: number): RetrievedUnit[] {
  if (candidates.length <= 1) return candidates;

  const result = [...candidates];

  // Stable sort: when scores are comparable, direct hits come first
  for (let i = 0; i < result.length - 1; i++) {
    const a = result[i];
    const b = result[i + 1];
    const scoreA = a.finalScore ?? a.rerankScore ?? 0;
    const scoreB = b.finalScore ?? b.rerankScore ?? 0;

    if (Math.abs(scoreA - scoreB) <= delta) {
      const aDirect = a.provenance?.sources.some(
        (s) => s.type === "vector_subject" || s.type === "vector_content" || s.type === "lexical"
      ) ?? false;
      const bDirect = b.provenance?.sources.some(
        (s) => s.type === "vector_subject" || s.type === "vector_content" || s.type === "lexical"
      ) ?? false;

      // If b is direct and a is not, swap them
      if (bDirect && !aDirect) {
        result[i] = b;
        result[i + 1] = a;
      }
    }
  }

  return result;
}

/** Rule 5: Preserve complementary rules.
 *  If a selected unit's metadata mentions another candidate by name/alias,
 *  ensure that candidate is also included (within budget). */
function preserveComplementaryRules(
  selected: RetrievedUnit[],
  allCandidates: RetrievedUnit[],
  allUnits?: Map<string, SemanticUnit>,
): RetrievedUnit[] {
  const selectedIds = new Set(selected.map((c) => c.unit.id));
  const toAdd: RetrievedUnit[] = [];

  // For each selected unit, check its metadata for complementary references
  for (const candidate of selected) {
    const meta = candidate.unit.metadata;
    if (!meta) continue;

    // Collect all terms from complementary fields
    const complementaryTerms: string[] = [];
    for (const field of COMPLEMENTARY_FIELDS) {
      const terms = meta[field] ?? [];
      complementaryTerms.push(...terms);
    }

    if (complementaryTerms.length === 0) continue;

    // Normalize terms for matching
    const normalizedTerms = complementaryTerms.map((t) => t.trim().toLowerCase());

    // Find candidates whose name or aliases match any complementary term
    for (const other of allCandidates) {
      if (selectedIds.has(other.unit.id)) continue;
      if (toAdd.some((t) => t.unit.id === other.unit.id)) continue;

      const otherName = (other.unit.name ?? "").trim().toLowerCase();
      const otherAliases = other.unit.metadata?.aliases ?? [];
      const otherAllNames = [otherName, ...otherAliases.map((a) => a.trim().toLowerCase())];

      const isComplementary = otherAllNames.some((name) =>
        normalizedTerms.some((term) =>
          name === term || name.includes(term) || term.includes(name)
        )
      );

      if (isComplementary) {
        toAdd.push(other);
        selectedIds.add(other.unit.id);
      }
    }
  }

  // Add complementary candidates at the end (they're contextually important)
  return [...selected, ...toAdd];
}

/** Build the context string for the answer model from selected evidence.
 *  Includes hierarchical context (parent chain) for each evidence unit. */
export function buildEvidenceContext(evidence: SelectedEvidence[]): string {
  const parts: string[] = [];

  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    const contextPath = e.parentChain.length > 0 ? e.parentChain.join(" > ") : "(root)";
    parts.push(`--- Evidence ${i + 1} ---`);
    parts.push(`Path: ${contextPath} > ${e.unit.name ?? "(unnamed)"}`);
    parts.push(`Type: ${e.unit.type}`);
    if (e.unit.summary) parts.push(`Summary: ${e.unit.summary}`);
    parts.push(`Content:`);
    parts.push(e.unit.content);
    parts.push("");
  }

  return parts.join("\n");
}
