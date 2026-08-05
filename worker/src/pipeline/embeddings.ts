import type { Env, SemanticUnit } from "../types";
import { embed } from "../utils/llm";

// bge-m3 supports 8192 input tokens; stay well under it with a conservative budget.
const MAX_EMBED_TOKENS = 6000;
const BYTES_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}

/** Phase 6 — build the enriched embedding document for a semantic unit.
 *  Keeps the input within the model's token budget by relying on structured
 *  metadata + summary, and only including the full original text when the
 *  complete document is guaranteed to fit. */
export function buildEnrichedDocument(unit: SemanticUnit): string {
  const chapter = unit.section[0] ?? "";
  const section = unit.section.slice(1).join(" > ");
  const meta = unit.metadata;

  const parts = [
    `Chapter: ${chapter}`,
    `Section: ${section}`,
    `Unit Name: ${unit.name ?? unit.id}`,
    `Type: ${unit.type}`,
    `Summary: ${unit.summary ?? meta?.summary ?? ""}`,
    `Keywords: ${meta?.keywords?.join(", ") ?? ""}`,
    `Aliases: ${meta?.aliases?.join(", ") ?? ""}`,
    `Defines: ${meta?.defines?.join(", ") ?? ""}`,
    `References: ${meta?.references?.join(", ") ?? ""}`,
    `Requires: ${meta?.requires?.join(", ") ?? ""}`,
    `Exceptions: ${meta?.exceptions?.join(", ") ?? ""}`,
    `Modifies: ${meta?.modifies?.join(", ") ?? ""}`,
    `Modified By: ${meta?.modified_by?.join(", ") ?? ""}`,
  ];

  const prefix = parts.join("\n");
  const content = unit.content;

  // Only attach the full original text if the combined document fits entirely.
  // Otherwise the structured metadata already carries the semantic signal and
  // the full content is still available to the answer-generation stage.
  const fullDoc = `${prefix}\nOriginal Text: ${content}`;
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
