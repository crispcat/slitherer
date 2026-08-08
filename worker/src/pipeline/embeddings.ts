import type { Env, SemanticUnit } from "../types";
import { embed } from "../utils/llm";
import { INGESTION } from "../config.gen";

// bge-m3 supports 8192 input tokens; stay well under it with a conservative budget.
const MAX_EMBED_TOKENS = INGESTION.embedding.maxTokens.value;
const BYTES_PER_TOKEN = INGESTION.embedding.bytesPerToken.value;

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}

/** Phase 6 — build the embedding document for a semantic unit.
 *
 *  The embedding is a clean "what is this unit" signal. It contains only:
 *  - Name (canonical term, when the unit has one)
 *  - Summary (parent-context-enriched during Phase 4 metadata extraction)
 *  - Aliases (alternate names/synonyms for terminology matching)
 *  - Original content (when it fits the token budget — primary signal for
 *    longer units; for short units like table cells the summary suffices)
 *
 *  Deliberately excluded:
 *  - Chapter/section/type — structural context handled by parent/sibling
 *    expansion at retrieval time. Type is available as Vectorize metadata
 *    for future pre-filtering.
 *  - Keywords — already used for SQL candidate selection in Phase 5; redundant
 *    in the embedding.
 *  - Defines/references/requires/exceptions/modifies/modified_by — these are
 *    relationship descriptors that become typed graph edges in Phase 5.
 *    Including them here would double-count with graph expansion and dilute
 *    the embedding's core semantic signal (Design Principle: "Use embeddings
 *    only for discovery"). */
export function buildEnrichedDocument(unit: SemanticUnit): string {
  const meta = unit.metadata;
  const aliases = meta?.aliases?.join(", ") ?? "";

  const parts: string[] = [];
  if (unit.name) parts.push(`Name: ${unit.name}`);
  parts.push(`Summary: ${unit.summary ?? ""}`);
  if (aliases) parts.push(`Aliases: ${aliases}`);

  const prefix = parts.join("\n");
  const content = unit.content;

  // Include the full original text when it fits the token budget. For longer
  // units the content is the primary signal; for short units (table cells,
  // stat modifiers) the summary already carries the semantic meaning. The full
  // content is always available to the answer-generation stage regardless.
  const fullDoc = `${prefix}\n${content}`;
  if (estimateTokens(fullDoc) <= MAX_EMBED_TOKENS) {
    return fullDoc;
  }
  return prefix;
}

export async function embedUnits(env: Env, units: SemanticUnit[]): Promise<Map<string, number[]>> {
  if (units.length === 0) return new Map();
  const docs = units.map(buildEnrichedDocument);
  const vectors = await embed(env, docs);
  const map = new Map<string, number[]>();
  units.forEach((u, i) => map.set(u.id, vectors[i]));
  return map;
}

export async function upsertEmbeddings(env: Env, units: SemanticUnit[], vectors: Map<string, number[]>) {
  const points = units
    .filter((u) => vectors.has(u.id))
    .map((u) => ({
      id: u.id,
      values: vectors.get(u.id)!,
      metadata: {
        type: u.type,
        section: u.section.join(" > "),
        page: u.page,
        name: u.name ?? "",
      },
    }));
  if (points.length === 0) return;
  await env.VECTORIZE_INDEX.upsert(points);
}
