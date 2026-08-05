import type { Env, SemanticUnit, SemanticUnitType, StructureNode } from "../types";
import { SEMANTIC_UNIT_TYPES } from "../types";
import { llmJson } from "../utils/llm";
import { sha256 } from "../utils/hash";
import { nextId } from "../utils/ids";

interface DetectedUnit {
  type: SemanticUnitType;
  name: string;
  content: string;
}

const UNIT_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
    },
    required: ["type", "content"],
  },
};

const SYSTEM_PROMPT = `You are a rules-parsing engine for a tabletop RPG rulebook (Russian language).
Given the raw text of ONE document node (a heading, paragraph, list, or Markdown table), identify every distinct
semantic unit it contains.

A semantic unit is one coherent mechanic, definition, item, spell, ability, rule, weapon, armor piece, skill, trait, etc.
Do NOT merge distinct mechanics into one unit just because they appear together.
Do NOT split a single coherent mechanic into pieces.
For Markdown tables, each meaningful row (or a tightly related group of rows) is its own unit.

Valid semantic unit types: ${SEMANTIC_UNIT_TYPES.join(", ")}.

Respond with ONLY a JSON array, no prose, of the form:
[{"type": "Rule", "name": "short Russian name", "content": "verbatim excerpt of the source text belonging to this unit"}]

Rules:
- "content" must be a verbatim substring of the input. Do not paraphrase, translate, or summarize.
- If the input contains multiple distinct mechanics (e.g. a numbered list of perks, a table of weapons, several spells), return one array item per mechanic.
- If the input is one coherent block, return exactly one item with the full input as content.
- For Markdown tables, return one item per meaningful data row; skip the header/separator rows. Derive the name from the first column.
- Preserve original language, case, and formatting.
- If a unit has no clear name, use a concise descriptive name in Russian.`;

function alphaNumChars(text: string): { chars: string[]; positions: number[] } {
  const chars: string[] = [];
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(c)) {
      chars.push(c);
      positions.push(i);
    }
  }
  return { chars, positions };
}

/** Try to map an LLM-generated excerpt back to a verbatim substring of the source. */
function extractOriginalSpan(source: string, approximate: string): string | null {
  const src = alphaNumChars(source);
  const tgt = alphaNumChars(approximate);
  if (tgt.chars.length === 0) return null;

  // Simple sliding-window search for the target character sequence.
  for (let i = 0; i <= src.chars.length - tgt.chars.length; i++) {
    let match = true;
    for (let j = 0; j < tgt.chars.length; j++) {
      if (src.chars[i + j] !== tgt.chars[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const start = src.positions[i];
      const end = src.positions[i + tgt.chars.length - 1] + 1;
      return source.slice(start, end);
    }
  }
  return null;
}

export async function detectSemanticUnits(env: Env, node: StructureNode): Promise<SemanticUnit[]> {
  if (!node.content.trim()) return [];

  const detected = await llmJson<DetectedUnit[]>(env, SYSTEM_PROMPT, node.content, {
    model: env.EXTRACTION_MODEL,
    maxRetries: 2,
    schema: UNIT_SCHEMA,
  });

  if (!Array.isArray(detected) || detected.length === 0) {
    throw new Error(`Semantic unit detection for ${node.id} returned an empty or invalid response`);
  }

  for (let i = 0; i < detected.length; i++) {
    // The model occasionally collapses a short/single-cell row (e.g. a table
    // abbreviation) into a bare string or a single-element array instead of
    // the {type, name, content} object. Normalize those recoverable shapes
    // rather than aborting the whole node over one malformed item.
    let d: any = detected[i];
    if (typeof d === "string") {
      d = { type: "Rule", name: d, content: d };
    } else if (Array.isArray(d) && d.length > 0 && typeof d[0] === "string") {
      d = { type: "Rule", name: d[0], content: d[0] };
    }
    detected[i] = d;

    if (typeof d.content !== "string" || d.content.trim().length === 0) {
      throw new Error(`Semantic unit detection for ${node.id} returned empty content: ${JSON.stringify(d)}`);
    }
    const verbatim = extractOriginalSpan(node.content, d.content);
    if (verbatim) {
      d.content = verbatim;
    }
    // If alignment fails, keep the model's text rather than blocking the pipeline.
  }

  const units: SemanticUnit[] = [];
  for (const d of detected) {
    const type = SEMANTIC_UNIT_TYPES.includes(d.type as SemanticUnitType) ? (d.type as SemanticUnitType) : "Rule";
    units.push(await buildUnit(node, { ...d, type }));
  }
  return units;
}

async function buildUnit(node: StructureNode, d: DetectedUnit): Promise<SemanticUnit> {
  const contentHash = await sha256(d.content);
  return {
    id: nextId(d.type),
    sourceNodeId: node.id,
    parentUnitId: null,
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
