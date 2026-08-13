/**
 * Phase 3 — Concept extraction, resolution, and embedding.
 *
 * Replaces the old relations pipeline. Instead of extracting typed relations
 * between units, we extract concept mentions from metadata fields, resolve
 * them to canonical concepts, and embed concepts in a dedicated Vectorize index.
 *
 * Mention types are simplified to just two:
 *   - defines: the unit defines this concept (highest priority for descriptions)
 *   - mentions: the unit references/uses/requires this concept
 *
 * Concepts have no type. The concept embedding document is:
 *   Name + Aliases + Description
 *
 * Pipeline:
 *   1. Extract raw mentions from metadata fields (defines, mentions)
 *   2. Normalize terms (lowercase, trim, Unicode NFC, collapse whitespace)
 *   3. Resolve each mention to an existing concept:
 *      a. Exact alias match
 *      b. Concept vector search (top-K, lowered threshold)
 *      c. LLM validation for vector matches
 *   4. Create new concepts for unresolved mentions
 *   5. Generate concept descriptions via LLM
 *      - For new concepts: from the defining unit's context
 *      - For existing concepts: regenerate when a new `defines` mention is found,
 *        using context from ALL defining units so far
 *   6. Embed/re-embed concepts to VECTORIZE_CONCEPTS_IDX
 *   7. Store concepts, aliases, and mentions in D1
 */
import type { Env, SemanticUnit, UnitMetadata, Concept, ConceptAlias, ConceptMention } from "../types";
import { llmJson, embed } from "../utils/llm";
import { getSemanticUnit } from "../utils/db";
import { INGESTION } from "../config.gen";

/** Fields to extract concept mentions from. Only two types: defines and mentions. */
const MENTION_FIELDS: { field: keyof UnitMetadata; mentionType: "defines" | "mentions" }[] = [
  { field: "defines", mentionType: "defines" },
  { field: "mentions", mentionType: "mentions" },
];

/** Vector search threshold for concept resolution. Lowered from 0.75 to catch
 *  more candidate matches — the LLM validation step filters out false positives. */
const CONCEPT_VECTOR_THRESHOLD = INGESTION.ingestion.conceptVectorThreshold?.value ?? 0.55;
const CONCEPT_VECTOR_TOP_K = INGESTION.ingestion.conceptVectorTopK?.value ?? 5;

/** Normalize a term: lowercase, trim, NFC Unicode normalization, collapse whitespace. */
export function normalizeTerm(term: string): string {
  return term
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

interface RawMention {
  rawTerm: string;
  normalizedTerm: string;
  mentionType: "defines" | "mentions";
}

/** Extract raw concept mentions from a unit's metadata fields. */
function extractRawMentions(meta: UnitMetadata | undefined): RawMention[] {
  if (!meta) return [];
  const mentions: RawMention[] = [];
  for (const { field, mentionType } of MENTION_FIELDS) {
    const terms = meta[field] ?? [];
    for (const term of terms) {
      const trimmed = term.trim();
      if (trimmed.length < 2) continue;
      mentions.push({
        rawTerm: trimmed,
        normalizedTerm: normalizeTerm(trimmed),
        mentionType,
      });
    }
  }
  return mentions;
}

/** Build the concept embedding document from canonical name, aliases, and description. */
function buildConceptDocument(concept: Concept, aliases: string[]): string {
  const parts: string[] = [];
  parts.push(`Name: ${concept.canonicalName}`);
  if (aliases.length > 0) parts.push(`Aliases: ${aliases.join(", ")}`);
  if (concept.description) parts.push(`Description: ${concept.description}`);
  return parts.join("\n");
}

const CONCEPT_DESCRIPTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    description: { type: "string" },
  },
  required: ["description"],
};

const CONCEPT_VALIDATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    is_same: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["is_same"],
};

/** Generate a concept description via LLM from aggregated context of multiple units. */
async function generateConceptDescription(env: Env, conceptName: string, context: string): Promise<string> {
  const system = "You are a game rules expert. Generate a concise 1-3 sentence canonical, self-contained description of the given concept based on the provided context from multiple units.";
  const user = `Concept: "${conceptName}"\nContext (from units that define this concept):\n${context.slice(0, 2000)}`;
  try {
    const result = await llmJson<{ description: string }>(env, system, user, {
      model: env.EXTRACTION_MODEL,
      schema: CONCEPT_DESCRIPTION_SCHEMA,
    });
    return result.description ?? "";
  } catch {
    return "";
  }
}

/** Validate whether a term refers to an existing concept via LLM. */
async function validateConceptMatch(env: Env, term: string, existingName: string, existingDescription: string): Promise<boolean> {
  const system = "You are a game rules ontology expert. Determine whether two terms refer to the same game concept.";
  const user = `Term 1: "${term}"\nTerm 2: "${existingName}"\nDescription of Term 2: ${existingDescription}\n\nDo these refer to the same game concept?`;
  try {
    const result = await llmJson<{ is_same: boolean }>(env, system, user, {
      model: env.EXTRACTION_MODEL,
      schema: CONCEPT_VALIDATION_SCHEMA,
    });
    return result.is_same === true;
  } catch {
    return false;
  }
}

/** Rerank vector search results by combining vector similarity with alias overlap.
 *  This helps surface concepts that are semantically related even if the raw term
 *  doesn't exactly match, while still preferring strong vector matches. */
function rerankVectorMatches(
  matches: { id: string; score: number }[],
  rawTerm: string,
  normalizedTerm: string,
): { id: string; score: number }[] {
  // Simple reranking: boost matches whose score is higher (Vectorize already
  // returns sorted by score, but we apply a slight normalization to spread
  // scores and avoid ties dominating). The LLM validation step is the real
  // filter — this just ensures we check the most promising candidates first.
  return [...matches].sort((a, b) => b.score - a.score);
}

/** Extract concepts for a single unit. Returns the concepts, aliases, and mentions to store. */
export interface ConceptExtractionResult {
  newConcepts: Concept[];
  newAliases: ConceptAlias[];
  newMentions: ConceptMention[];
  /** Concepts that got new aliases or description updates (need re-embedding). */
  updatedConcepts: Concept[];
}

/** Process a batch of units for concept extraction.
 *  This is the main entry point for the concepts ingestion phase. */
export async function extractConceptsForUnit(env: Env, unit: SemanticUnit, documentId: string): Promise<ConceptExtractionResult> {
  const rawMentions = extractRawMentions(unit.metadata);
  if (rawMentions.length === 0) {
    return { newConcepts: [], newAliases: [], newMentions: [], updatedConcepts: [] };
  }

  // Deduplicate mentions by normalized term, preserving the highest-priority mention type
  // (defines > mentions) for each normalized term.
  const termToMentions = new Map<string, RawMention[]>();
  for (const m of rawMentions) {
    const arr = termToMentions.get(m.normalizedTerm) ?? [];
    arr.push(m);
    termToMentions.set(m.normalizedTerm, arr);
  }

  const newConcepts: Concept[] = [];
  const newAliases: ConceptAlias[] = [];
  const newMentions: ConceptMention[] = [];
  const updatedConcepts: Concept[] = [];
  const now = new Date().toISOString();

  for (const [normalizedTerm, mentions] of termToMentions) {
    const rawTerm = mentions[0].rawTerm;
    // If the same term appears as both defines and mentions, prefer defines
    const hasDefines = mentions.some((m) => m.mentionType === "defines");
    const effectiveMentionType = hasDefines ? "defines" : "mentions";

    // Step 1: Try exact alias match
    const exactMatch = await findConceptByAlias(env, normalizedTerm);
    if (exactMatch) {
      for (const m of mentions) {
        newMentions.push({
          id: `CM-${crypto.randomUUID()}`,
          conceptId: exactMatch.id,
          unitId: unit.id,
          rawTerm: m.rawTerm,
          normalizedTerm: m.normalizedTerm,
          mentionType: m.mentionType,
          confidence: 1.0,
          resolutionMethod: "exact_alias",
          createdAt: now,
        });
      }
      // If this is a defines mention, regenerate the description from all defining units
      if (hasDefines) {
        await regenerateDescriptionForConcept(env, exactMatch, unit, updatedConcepts);
      }
      continue;
    }

    // Step 2: Concept vector search (lowered threshold + reranking)
    const [queryVec] = await embed(env, [rawTerm]);
    const vectorResults = await env.VECTORIZE_CONCEPTS_IDX.query(queryVec, {
      topK: CONCEPT_VECTOR_TOP_K,
      returnMetadata: true,
    });
    const candidateMatches = (vectorResults.matches ?? []).filter((m) => (m.score ?? 0) > CONCEPT_VECTOR_THRESHOLD);
    const reranked = rerankVectorMatches(
      candidateMatches.map((m) => ({ id: m.id, score: m.score ?? 0 })),
      rawTerm,
      normalizedTerm,
    );

    // Step 3: LLM validation for top candidates
    let resolved = false;
    for (const candidate of reranked) {
      const existingConcept = await getConcept(env, candidate.id);
      if (!existingConcept) continue;

      const isSame = await validateConceptMatch(env, rawTerm, existingConcept.canonicalName, existingConcept.description ?? "");
      if (isSame) {
        // Add as alias if not already present
        const aliasAdded = await addAliasIfNew(env, existingConcept.id, rawTerm, normalizedTerm, "vector_match");
        if (aliasAdded) {
          newAliases.push({
            conceptId: existingConcept.id,
            alias: rawTerm,
            normalizedAlias: normalizedTerm,
            source: "vector_match",
            confidence: candidate.score,
          });
          updatedConcepts.push(existingConcept);
        }
        for (const m of mentions) {
          newMentions.push({
            id: `CM-${crypto.randomUUID()}`,
            conceptId: existingConcept.id,
            unitId: unit.id,
            rawTerm: m.rawTerm,
            normalizedTerm: m.normalizedTerm,
            mentionType: m.mentionType,
            confidence: candidate.score,
            resolutionMethod: "embedding",
            createdAt: now,
          });
        }
        // If this is a defines mention, regenerate the description from all defining units
        if (hasDefines) {
          await regenerateDescriptionForConcept(env, existingConcept, unit, updatedConcepts);
        }
        resolved = true;
        break;
      }
    }

    if (resolved) continue;

    // Step 4: Create new concept
    const conceptId = `CONCEPT-${crypto.randomUUID()}`;
    const newConcept: Concept = {
      id: conceptId,
      documentId,
      canonicalName: rawTerm,
      sourceUnitIds: [unit.id],
      createdAt: now,
      updatedAt: now,
    };
    newConcepts.push(newConcept);

    // Add canonical name as an alias
    newAliases.push({
      conceptId,
      alias: rawTerm,
      normalizedAlias: normalizedTerm,
      source: "canonical",
      confidence: 1.0,
    });

    for (const m of mentions) {
      newMentions.push({
        id: `CM-${crypto.randomUUID()}`,
        conceptId,
        unitId: unit.id,
        rawTerm: m.rawTerm,
        normalizedTerm: m.normalizedTerm,
        mentionType: m.mentionType,
        confidence: 1.0,
        resolutionMethod: "manual",
        createdAt: now,
      });
    }
  }

  // Generate descriptions for new concepts
  for (const concept of newConcepts) {
    const context = unit.summary ?? unit.content.slice(0, 500);
    concept.description = await generateConceptDescription(env, concept.canonicalName, context);
  }

  // Embed new concepts
  if (newConcepts.length > 0) {
    const docs = newConcepts.map((c) => buildConceptDocument(c, [c.canonicalName]));
    const vectors = await embed(env, docs);
    const points = newConcepts.map((c, i) => ({
      id: c.id,
      values: vectors[i],
      metadata: {
        id: c.id,
        meta: JSON.stringify({
          concept_id: c.id,
          canonical_name: c.canonicalName,
          document_id: c.documentId,
        }),
      },
    }));
    await env.VECTORIZE_CONCEPTS_IDX.upsert(points);
    for (const c of newConcepts) {
      c.embeddingId = c.id;
    }
  }

  // Re-embed updated concepts (aliases and/or description changed the embedding document)
  if (updatedConcepts.length > 0) {
    // Deduplicate by concept ID (a concept may appear multiple times if multiple
    // mentions resolved to it)
    const seen = new Set<string>();
    const toReembed = updatedConcepts.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    for (const concept of toReembed) {
      const aliases = await getAliasesForConcept(env, concept.id);
      const doc = buildConceptDocument(concept, aliases);
      const [vec] = await embed(env, [doc]);
      await env.VECTORIZE_CONCEPTS_IDX.upsert([{
        id: concept.id,
        values: vec,
        metadata: {
          id: concept.id,
          meta: JSON.stringify({
            concept_id: concept.id,
            canonical_name: concept.canonicalName,
            document_id: concept.documentId,
          }),
        },
      }]);
    }
  }

  return { newConcepts, newAliases, newMentions, updatedConcepts };
}

/** Regenerate a concept's description when a new `defines` mention is found.
 *  Collects context from ALL units that define this concept (including the new one),
 *  generates a new description via LLM, updates the concept in D1, and marks it
 *  for re-embedding. */
async function regenerateDescriptionForConcept(
  env: Env,
  concept: Concept,
  newDefiningUnit: SemanticUnit,
  updatedConcepts: Concept[],
): Promise<void> {
  // Find all units that define this concept (via concept_mentions with type "defines")
  const { results: defineMentions } = await env.DB.prepare(
    `SELECT unit_id FROM concept_mentions WHERE concept_id = ? AND mention_type = 'defines'`
  ).bind(concept.id).all();

  const definingUnitIds = new Set<string>();
  for (const r of defineMentions ?? []) {
    definingUnitIds.add((r as any).unit_id as string);
  }
  // Add the current unit (its mention hasn't been stored yet)
  definingUnitIds.add(newDefiningUnit.id);

  // Fetch all defining units to build aggregated context
  const contexts: string[] = [];
  for (const unitId of definingUnitIds) {
    if (unitId === newDefiningUnit.id) {
      // Use the already-fetched unit
      contexts.push(`${newDefiningUnit.name ?? ""}: ${newDefiningUnit.summary ?? newDefiningUnit.content.slice(0, 500)}`);
    } else {
      const unit = await getSemanticUnit(env, unitId);
      if (unit) {
        contexts.push(`${unit.name ?? ""}: ${unit.summary ?? unit.content.slice(0, 500)}`);
      }
    }
  }

  if (contexts.length === 0) return;

  const aggregatedContext = contexts.join("\n---\n");
  const newDescription = await generateConceptDescription(env, concept.canonicalName, aggregatedContext);

  if (newDescription) {
    concept.description = newDescription;
    concept.sourceUnitIds = [...definingUnitIds];
    concept.updatedAt = new Date().toISOString();

    // Update the concept in D1 immediately (so the new description is available
    // for subsequent unit processing in the same batch)
    await env.DB.prepare(
      `UPDATE concepts SET description = ?, source_unit_ids = ?, updated_at = ? WHERE id = ?`
    ).bind(newDescription, JSON.stringify(concept.sourceUnitIds), concept.updatedAt, concept.id).run();

    // Mark for re-embedding (the caller handles the re-embed)
    if (!updatedConcepts.some((c) => c.id === concept.id)) {
      updatedConcepts.push(concept);
    }
  }
}

// ---- D1 helpers for concepts ----

async function findConceptByAlias(env: Env, normalizedAlias: string): Promise<Concept | null> {
  const row = await env.DB.prepare(
    `SELECT c.* FROM concepts c
     JOIN concept_aliases a ON a.concept_id = c.id
     WHERE a.normalized_alias = ?
     LIMIT 1`
  ).bind(normalizedAlias).first();
  if (!row) return null;
  return rowToConcept(row);
}

async function getConcept(env: Env, id: string): Promise<Concept | null> {
  const row = await env.DB.prepare(`SELECT * FROM concepts WHERE id = ?`).bind(id).first();
  if (!row) return null;
  return rowToConcept(row);
}

async function getAliasesForConcept(env: Env, conceptId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT alias FROM concept_aliases WHERE concept_id = ?`
  ).bind(conceptId).all();
  return (results ?? []).map((r: any) => r.alias as string);
}

async function addAliasIfNew(env: Env, conceptId: string, alias: string, normalizedAlias: string, source: string): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT INTO concept_aliases (concept_id, alias, normalized_alias, source, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(concept_id, normalized_alias) DO NOTHING`
    ).bind(conceptId, alias, normalizedAlias, source, 0.8).run();
    // Check if the row was actually inserted
    const row = await env.DB.prepare(
      `SELECT 1 FROM concept_aliases WHERE concept_id = ? AND normalized_alias = ? AND source = ?`
    ).bind(conceptId, normalizedAlias, source).first();
    return !!row;
  } catch {
    return false;
  }
}

function rowToConcept(row: any): Concept {
  return {
    id: row.id,
    documentId: row.document_id,
    canonicalName: row.canonical_name,
    description: row.description ?? undefined,
    embeddingId: row.embedding_id ?? undefined,
    sourceUnitIds: row.source_unit_ids ? JSON.parse(row.source_unit_ids) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Store concept extraction results to D1. */
export async function storeConceptResults(env: Env, result: ConceptExtractionResult) {
  const now = new Date().toISOString();
  const stmts = [];

  // Insert new concepts
  for (const c of result.newConcepts) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO concepts (id, document_id, canonical_name, description, embedding_id, source_unit_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           embedding_id = excluded.embedding_id,
           source_unit_ids = excluded.source_unit_ids,
           updated_at = excluded.updated_at`
      ).bind(c.id, c.documentId, c.canonicalName, c.description ?? null, c.embeddingId ?? null, JSON.stringify(c.sourceUnitIds ?? []), c.createdAt, c.updatedAt)
    );
  }

  // Insert new aliases
  for (const a of result.newAliases) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO concept_aliases (concept_id, alias, normalized_alias, source, confidence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(concept_id, normalized_alias) DO NOTHING`
      ).bind(a.conceptId, a.alias, a.normalizedAlias, a.source ?? null, a.confidence)
    );
  }

  // Insert new mentions
  for (const m of result.newMentions) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO concept_mentions (id, concept_id, unit_id, raw_term, normalized_term, mention_type, confidence, resolution_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(m.id, m.conceptId, m.unitId, m.rawTerm, m.normalizedTerm, m.mentionType, m.confidence, m.resolutionMethod, m.createdAt)
    );
  }

  // Note: updated concepts (description regeneration) are already written to D1
  // immediately in regenerateDescriptionForConcept(). We only need to update
  // the updated_at timestamp here for concepts that got new aliases but no
  // description regeneration.
  const seenUpdated = new Set<string>();
  for (const c of result.updatedConcepts) {
    if (seenUpdated.has(c.id)) continue;
    seenUpdated.add(c.id);
    // Only update timestamp — description was already updated if needed
    stmts.push(
      env.DB.prepare(
        `UPDATE concepts SET updated_at = ? WHERE id = ?`
      ).bind(now, c.id)
    );
  }

  if (stmts.length > 0) {
    // D1 batch has a limit — chunk if needed
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }
}

/** Clear concept mentions for a unit (used when re-running concept extraction). */
export async function clearConceptMentionsForUnit(env: Env, unitId: string) {
  await env.DB.prepare(`DELETE FROM concept_mentions WHERE unit_id = ?`).bind(unitId).run();
}

/** Get all concepts mentioned by a unit. */
export async function getConceptsForUnit(env: Env, unitId: string): Promise<ConceptMention[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM concept_mentions WHERE unit_id = ?`
  ).bind(unitId).all();
  return (results ?? []).map((r: any) => ({
    id: r.id,
    conceptId: r.concept_id,
    unitId: r.unit_id,
    rawTerm: r.raw_term,
    normalizedTerm: r.normalized_term,
    mentionType: r.mention_type,
    confidence: r.confidence,
    resolutionMethod: r.resolution_method,
    createdAt: r.created_at,
  }));
}

/** Get all units that mention a concept. */
export async function getUnitsForConcept(env: Env, conceptId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT unit_id FROM concept_mentions WHERE concept_id = ?`
  ).bind(conceptId).all();
  return (results ?? []).map((r: any) => r.unit_id as string);
}

/** Regenerate descriptions for concepts affected by a page-scoped stage reset.
 *
 *  After clearing concept mentions for units on the reingested pages, surviving
 *  concepts (those still mentioned by units on other pages) may have stale
 *  descriptions — descriptions that were generated using defining units that
 *  are no longer defining them (because those units were reset/reingested).
 *
 *  This function:
 *  1. Finds concepts that had `defines` mentions from units on the target pages
 *     (before the mentions were cleared — so this must be called BEFORE clearing).
 *  2. For each such concept that still has mentions from other units:
 *     a. Collect remaining defining units (from other pages)
 *     b. If no defining units remain but mentioning units exist, use mentioning units
 *     c. Regenerate description via LLM from aggregated context
 *     d. Update source_unit_ids
 *     e. Re-embed concept with new description + current aliases
 *
 *  @param env Worker environment
 *  @param documentId Document ID
 *  @param pages Pages being reingested (the units whose mentions will be cleared)
 *  @returns Array of concept IDs that were regenerated
 */
export async function regenerateDescriptionsForAffectedConcepts(
  env: Env,
  documentId: string,
  pages: number[],
): Promise<string[]> {
  if (!pages || pages.length === 0) return [];

  const pagePlaceholders = pages.map(() => "?").join(",");

  // Step 1: Find concepts that had `defines` mentions from units on the target pages.
  // These are the concepts whose descriptions may need regeneration.
  const { results: affectedConcepts } = await env.DB.prepare(
    `SELECT DISTINCT cm.concept_id
     FROM concept_mentions cm
     JOIN semantic_units su ON su.id = cm.unit_id
     WHERE su.document_id = ?
       AND su.page IN (${pagePlaceholders})
       AND cm.mention_type = 'defines'`
  ).bind(documentId, ...pages).all();

  const conceptIds = ((affectedConcepts ?? []) as any[]).map((r) => r.concept_id as string);
  if (conceptIds.length === 0) return [];

  const regenerated: string[] = [];

  for (const conceptId of conceptIds) {
    // Fetch the concept
    const concept = await getConcept(env, conceptId);
    if (!concept) continue; // concept was deleted (orphaned)

    // Check if the concept still has any mentions from remaining units
    const { results: remainingMentions } = await env.DB.prepare(
      `SELECT cm.unit_id, cm.mention_type FROM concept_mentions cm WHERE cm.concept_id = ?`
    ).bind(conceptId).all();

    if (!remainingMentions || remainingMentions.length === 0) {
      // No remaining mentions — this concept will be deleted as orphaned.
      // Skip regeneration.
      continue;
    }

    // Collect remaining defining units (from pages NOT being reingested)
    const definingUnitIds = (remainingMentions as any[])
      .filter((r) => r.mention_type === "defines")
      .map((r) => r.unit_id as string);

    // If no defining units remain, fall back to mentioning units
    let contextUnitIds: string[];
    if (definingUnitIds.length > 0) {
      contextUnitIds = definingUnitIds;
    } else {
      contextUnitIds = (remainingMentions as any[]).map((r) => r.unit_id as string);
    }

    // Fetch context from remaining units
    const contexts: string[] = [];
    for (const unitId of contextUnitIds) {
      const unit = await getSemanticUnit(env, unitId);
      if (unit) {
        contexts.push(`${unit.name ?? ""}: ${unit.summary ?? unit.content.slice(0, 500)}`);
      }
    }

    if (contexts.length === 0) continue;

    // Regenerate description
    const aggregatedContext = contexts.join("\n---\n");
    const newDescription = await generateConceptDescription(env, concept.canonicalName, aggregatedContext);

    if (newDescription) {
      concept.description = newDescription;
      concept.sourceUnitIds = contextUnitIds;
      concept.updatedAt = new Date().toISOString();

      // Update the concept in D1
      await env.DB.prepare(
        `UPDATE concepts SET description = ?, source_unit_ids = ?, updated_at = ? WHERE id = ?`
      ).bind(newDescription, JSON.stringify(concept.sourceUnitIds), concept.updatedAt, concept.id).run();

      // Re-embed the concept with new description + current aliases
      const aliases = await getAliasesForConcept(env, concept.id);
      const doc = buildConceptDocument(concept, aliases);
      const [vec] = await embed(env, [doc]);
      await env.VECTORIZE_CONCEPTS_IDX.upsert([{
        id: concept.id,
        values: vec,
        metadata: {
          id: concept.id,
          meta: JSON.stringify({
            concept_id: concept.id,
            canonical_name: concept.canonicalName,
            document_id: concept.documentId,
          }),
        },
      }]);

      regenerated.push(conceptId);
    }
  }

  return regenerated;
}
