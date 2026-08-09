import type { Env, SemanticUnit, UnitMetadata } from "../types";
import { llmJson } from "../utils/llm";
import { INGESTION } from "../config.gen";

const METADATA_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    defines: { type: "array", items: { type: "string" } },
    references: { type: "array", items: { type: "string" } },
    requires: { type: "array", items: { type: "string" } },
    exceptions: { type: "array", items: { type: "string" } },
    modifies: { type: "array", items: { type: "string" } },
    modified_by: { type: "array", items: { type: "string" } },
    overrides: { type: "array", items: { type: "string" } },
    related_to: { type: "array", items: { type: "string" } },
    incompatible_with: { type: "array", items: { type: "string" } },
    creates: { type: "array", items: { type: "string" } },
    consumes: { type: "array", items: { type: "string" } },
    supersedes: { type: "array", items: { type: "string" } },
    example_of: { type: "array", items: { type: "string" } },
    part_of: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
  },
  required: [],
};

const SYSTEM_PROMPT = INGESTION.prompts.metadata.text;

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

function normalize(m: Partial<UnitMetadata>): UnitMetadata {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return {
    defines: arr(m.defines),
    references: arr(m.references),
    requires: arr(m.requires),
    exceptions: arr(m.exceptions),
    modifies: arr(m.modifies),
    modified_by: arr(m.modified_by),
    overrides: arr(m.overrides),
    related_to: arr(m.related_to),
    incompatible_with: arr(m.incompatible_with),
    creates: arr(m.creates),
    consumes: arr(m.consumes),
    supersedes: arr(m.supersedes),
    example_of: arr(m.example_of),
    part_of: arr(m.part_of),
    aliases: arr(m.aliases),
  };
}
