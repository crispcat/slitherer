import type { Env, SemanticUnit, UnitMetadata } from "../types";
import { llmJson } from "../utils/llm";
import { INGESTION } from "../config.gen";

const METADATA_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    defines: { type: "array", items: { type: "string" } },
    mentions: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
  },
  required: [],
};

const SYSTEM_PROMPT = INGESTION.prompts.metadata.text;

/** Fields to flatten into metadata_terms_text for FTS5 indexing. */
const METADATA_TERM_FIELDS: (keyof UnitMetadata)[] = [
  "defines", "mentions",
];

export async function extractMetadata(env: Env, unit: SemanticUnit): Promise<UnitMetadata> {
  const userPrompt = `Name: ${unit.name ?? "(unnamed)"}\nSummary: ${unit.summary ?? ""}\nContent:\n${unit.content}`;

  try {
    const meta = await llmJson<Partial<UnitMetadata>>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.REASONING_MODEL,
      schema: METADATA_SCHEMA,
    });
    return normalize(meta);
  } catch {
    return normalize({});
  }
}

/** Compute metadata_terms_text: all metadata arrays flattened into a single space-joined string. */
export function computeMetadataTermsText(meta: UnitMetadata): string {
  const terms: string[] = [];
  for (const field of METADATA_TERM_FIELDS) {
    const arr = meta[field] ?? [];
    for (const term of arr) {
      const trimmed = term.trim();
      if (trimmed) terms.push(trimmed);
    }
  }
  return terms.join(" ");
}

/** Compute aliases_text: aliases joined with ", ". */
export function computeAliasesText(meta: UnitMetadata): string {
  return (meta.aliases ?? []).join(", ");
}

/** Compute section_path_text: section array joined with " > ". */
export function computeSectionPathText(section: string[]): string {
  return section.join(" > ");
}

function normalize(m: Partial<UnitMetadata>): UnitMetadata {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    defines: arr(m.defines),
    mentions: arr(m.mentions),
    aliases: arr(m.aliases),
  };
}
