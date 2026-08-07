import type { Env, SemanticUnit, UnitMetadata } from "../types";
import { llmJson } from "../utils/llm";
import { getSemanticUnit } from "../utils/db";

// Cap parent context so the prompt stays within the extraction model's budget.
const PARENT_CONTEXT_MAX_CHARS = 800;

const METADATA_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    defines: { type: "array", items: { type: "string" } },
    references: { type: "array", items: { type: "string" } },
    requires: { type: "array", items: { type: "string" } },
    exceptions: { type: "array", items: { type: "string" } },
    modifies: { type: "array", items: { type: "string" } },
    modified_by: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["summary"],
};

const SYSTEM_PROMPT = `You are a rules-analysis engine for a tabletop RPG rulebook (Russian language).
Given a single semantic unit, extract structured metadata about it.

If a "Parent Unit" is provided, use it as context: the current unit is a child,
modifier, or sub-rule of that parent. Incorporate the parent's meaning into the
summary and keywords where relevant, but only extract defines/references/etc.
that are explicitly present in the current unit's own text or clearly implied
by the parent-child relationship.

Respond with ONLY a JSON object of the form:
{
  "defines": ["term(s) this unit defines"],
  "references": ["other named mechanics/sections this unit references"],
  "requires": ["prerequisites for this unit to apply"],
  "exceptions": ["exceptions to this unit's normal behavior"],
  "modifies": ["mechanics this unit changes/affects"],
  "modified_by": ["mechanics that are known to change/affect this unit, if stated"],
  "keywords": ["salient keywords for search"],
  "aliases": ["alternate names/synonyms for this unit, if any"],
  "summary": "one to three sentence plain-language summary of this unit"
}

Only use information present in the text. Use empty arrays where nothing applies. Keep the original
language (Russian) for all extracted strings.`;

export async function extractMetadata(env: Env, unit: SemanticUnit): Promise<UnitMetadata> {
  // Fetch the parent unit (if any) to give the LLM structural context.
  // This helps with orphan/child units whose meaning depends on their parent
  // (e.g. a modifier that belongs to a specific spell or age category).
  let parentContext = "";
  if (unit.parentUnitId) {
    const parent = await getSemanticUnit(env, unit.parentUnitId);
    if (parent) {
      const parentName = parent.name ?? "(unnamed)";
      const parentContent = parent.content.slice(0, PARENT_CONTEXT_MAX_CHARS);
      parentContext = `\nParent Unit (${parent.type}, ${parentName}):\n${parentContent}`;
    }
  }
  if (unit.secondaryParentUnitId) {
    const colParent = await getSemanticUnit(env, unit.secondaryParentUnitId);
    if (colParent) {
      const colName = colParent.name ?? "(unnamed)";
      const colContent = colParent.content.slice(0, PARENT_CONTEXT_MAX_CHARS);
      parentContext += `\nColumn Parent (${colParent.type}, ${colName}):\n${colContent}`;
    }
  }

  const userPrompt = `Type: ${unit.type}\nName: ${unit.name ?? "(unnamed)"}\nSection: ${unit.section.join(" > ")}${parentContext}\nContent:\n${unit.content}`;

  try {
    const meta = await llmJson<Partial<UnitMetadata>>(env, SYSTEM_PROMPT, userPrompt, { model: env.EXTRACTION_MODEL, schema: METADATA_SCHEMA });
    return normalize(meta);
  } catch {
    return normalize({ summary: unit.content.slice(0, 240) });
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
    keywords: arr(m.keywords),
    aliases: arr(m.aliases),
    summary: typeof m.summary === "string" ? m.summary : "",
  };
}
