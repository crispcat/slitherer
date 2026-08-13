import type { Env, SemanticUnit } from "../types";
import { embed } from "../utils/llm";
import { INGESTION } from "../config.gen";

// bge-m3 supports 8192 input tokens; stay well under it with a conservative budget.
const MAX_EMBED_TOKENS = INGESTION.embedding.maxTokens.value;
const BYTES_PER_TOKEN = INGESTION.embedding.bytesPerToken.value;

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN);
}

/** Build the hierarchical path for a unit: section path + semantic tree path + unit name.
 *  Walks parentUnitId up to the root, collecting parent names. Prepends the section
 *  array (document structure) and joins everything with " > ". */
export function buildUnitPath(unit: SemanticUnit, parentNames: string[]): string {
  const sectionPath = unit.section.join(" > ");
  const treePath = [...parentNames, unit.name ?? ""].filter(Boolean);
  if (sectionPath && treePath.length > 0) {
    return `${sectionPath} > ${treePath.join(" > ")}`;
  }
  return sectionPath || treePath.join(" > ");
}

/** Phase 1 — build the subject embedding document for a semantic unit.
 *
 *  The subject embedding is a "what is this unit about" signal. It contains:
 *  - Document name (for document-scoped context)
 *  - Path (section path + semantic tree path through all parents, ending at unit name)
 *  - Name (canonical term)
 *  - Summary (concise description)
 *  - Aliases (alternate names/synonyms)
 *
 *  Deliberately excludes full content — the subject index is for semantic subject
 *  discovery, not exact rule retrieval. Content embeddings handle that. */
export function buildSubjectDocument(unit: SemanticUnit, documentName: string, parentPath: string[]): string {
  const meta = unit.metadata;
  const aliases = meta?.aliases?.join(", ") ?? "";
  const path = buildUnitPath(unit, parentPath);

  const parts: string[] = [];
  parts.push(`Document: ${documentName}`);
  if (path) parts.push(`Path: ${path}`);
  if (unit.name) parts.push(`Name: ${unit.name}`);
  if (unit.summary) parts.push(`Summary: ${unit.summary}`);
  if (aliases) parts.push(`Aliases: ${aliases}`);

  return parts.join("\n");
}

/** Phase 1 — build the content embedding document for a semantic unit.
 *
 *  The content embedding is for exact rule retrieval. It contains everything
 *  from the subject document plus the full unit content. If content exceeds
 *  the embedding token budget, only the content portion is truncated —
 *  path, name, summary, and aliases are always preserved. */
export function buildContentDocument(unit: SemanticUnit, documentName: string, parentPath: string[]): string {
  const meta = unit.metadata;
  const aliases = meta?.aliases?.join(", ") ?? "";
  const path = buildUnitPath(unit, parentPath);

  const parts: string[] = [];
  parts.push(`Document: ${documentName}`);
  if (path) parts.push(`Path: ${path}`);
  if (unit.name) parts.push(`Name: ${unit.name}`);
  if (unit.summary) parts.push(`Summary: ${unit.summary}`);
  if (aliases) parts.push(`Aliases: ${aliases}`);
  const prefix = parts.join("\n");

  const content = unit.content;
  const fullDoc = `${prefix}\n\nContent:\n${content}`;

  if (estimateTokens(fullDoc) <= MAX_EMBED_TOKENS) {
    return fullDoc;
  }

  // Truncate only the content portion, preserving prefix
  const prefixTokens = estimateTokens(prefix);
  const remainingTokens = MAX_EMBED_TOKENS - prefixTokens - 10; // 10 token margin for "\n\nContent:\n"
  if (remainingTokens <= 0) {
    // Edge case: prefix alone exceeds budget — return prefix without content
    return prefix;
  }
  const remainingBytes = Math.floor(remainingTokens * BYTES_PER_TOKEN);
  const truncatedContent = content.slice(0, remainingBytes);
  return `${prefix}\n\nContent:\n${truncatedContent}`;
}

/** Embed a batch of units into subject vectors. Returns a map of unit ID → vector. */
export async function embedSubjectUnits(env: Env, units: SemanticUnit[], docs: string[]): Promise<Map<string, number[]>> {
  if (units.length === 0) return new Map();
  const vectors = await embed(env, docs);
  const map = new Map<string, number[]>();
  units.forEach((u, i) => map.set(u.id, vectors[i]));
  return map;
}

/** Embed a batch of units into content vectors. Returns a map of unit ID → vector. */
export async function embedContentUnits(env: Env, units: SemanticUnit[], docs: string[]): Promise<Map<string, number[]>> {
  if (units.length === 0) return new Map();
  const vectors = await embed(env, docs);
  const map = new Map<string, number[]>();
  units.forEach((u, i) => map.set(u.id, vectors[i]));
  return map;
}

/** Build compact Vectorize metadata for a unit — single JSON string under 1KB. */
function buildVectorizeMetadata(unit: SemanticUnit): Record<string, string> {
  const meta = {
    unit_id: unit.id,
    document_id: unit.documentId ?? "",
    type: unit.type,
    name: unit.name ?? "",
    section_path: unit.section.join(" > "),
    parent_unit_id: unit.parentUnitId ?? "",
    page: unit.page,
    source_order: unit.sourceOrder,
    content_hash: unit.contentHash,
  };
  return { id: unit.id, meta: JSON.stringify(meta) };
}

/** Upsert subject embeddings to the VECTORIZE_SUBJECTS index. */
export async function upsertSubjectEmbeddings(env: Env, units: SemanticUnit[], vectors: Map<string, number[]>) {
  const points = units
    .filter((u) => vectors.has(u.id))
    .map((u) => ({
      id: u.id,
      values: vectors.get(u.id)!,
      metadata: buildVectorizeMetadata(u),
    }));
  if (points.length === 0) return;
  await env.VECTORIZE_SUBJECTS.upsert(points);
}

/** Upsert content embeddings to the VECTORIZE_CONTENT index. */
export async function upsertContentEmbeddings(env: Env, units: SemanticUnit[], vectors: Map<string, number[]>) {
  const points = units
    .filter((u) => vectors.has(u.id))
    .map((u) => ({
      id: u.id,
      values: vectors.get(u.id)!,
      metadata: buildVectorizeMetadata(u),
    }));
  if (points.length === 0) return;
  await env.VECTORIZE_CONTENT.upsert(points);
}

/** Build a compact document for reranking. Uses the unit's own fields without
 *  requiring external context (document name, parent path). Suitable for the
 *  reranker which needs a text representation of each candidate. */
export function buildRerankDocument(unit: SemanticUnit): string {
  const meta = unit.metadata;
  const aliases = meta?.aliases?.join(", ") ?? "";
  const sectionPath = unit.section?.join(" > ") ?? "";

  const parts: string[] = [];
  if (sectionPath) parts.push(`Section: ${sectionPath}`);
  if (unit.name) parts.push(`Name: ${unit.name}`);
  if (unit.summary) parts.push(`Summary: ${unit.summary}`);
  if (aliases) parts.push(`Aliases: ${aliases}`);
  const prefix = parts.join("\n");

  return `${prefix}\n\nContent:\n${unit.content}`;
}
