/**
 * Vision extraction pipeline — extracts semantic units from PDF page images
 * using a vision-language model (Mistral Small 3.1 24B by default).
 *
 * Pipeline:
 *   1. Render PDF page to PNG (done client-side via PyMuPDF)
 *   2. Send page image to vision model with extraction prompt
 *   3. Parse JSON response → VisionUnit[]
 *   4. Pass continuation state to next page
 *
 * The prompt instructs the model to:
 *   - Split content into fine-grained semantic units
 *   - Build parent-child hierarchy (parentName = name of parent unit, resolved to index in post-processing)
 *   - Extract section paths from visible headings
 *   - Detect and describe meaningful visual elements (diagrams, charts, maps)
 *   - Continue truncated content from the previous page
 */
import { extractJsonBlock } from "../utils/llm";
import { nextId } from "../utils/ids";
import { INGESTION } from "../config.gen";
import type {
  Env,
  VisionUnit,
  VisionContinuation,
  VisionPageResult,
} from "../types";

/** System prompt loaded from config/ingestion.yaml (vision.prompt.text). */
const SYSTEM_PROMPT: string = INGESTION.vision.prompt.text;

/**
 * Generate a UUID-based ID for a vision unit.
 * Format: RULE-<uuid>, TABLE-<uuid>, or IMG-<uuid>, depending on the unit type.
 */
function unitId(type: string): string {
  const prefix = type === "Image" ? "IMG"
    : (type === "DataTableHeader" || type === "DataTableRow" || type === "ColumnListTable" || type === "ColumnListItem") ? "TABLE"
    : "RULE";
  return nextId(prefix);
}

/**
 * Resolve parentName references to parentId (the parent unit's UUID-based ID).
 * - If parentName is null, parentId = null (root).
 * - If parentName matches a unit that appeared BEFORE this one, use that unit's id.
 * - If multiple units share the same name, use the most recent one before this unit.
 * - If no match found, parentId = null (orphaned — will be flagged by validation).
 * - Self-references (parentName === own name) are set to null.
 */
function resolveParentNames(units: VisionUnit[]): void {
  // Build a map: name → last unit seen (only looking backward)
  const nameToLastUnit = new Map<string, VisionUnit>();

  for (let i = 0; i < units.length; i++) {
    const parentName = units[i].parentName;
    if (parentName === null || parentName === undefined) {
      units[i].parentId = null;
    } else if (parentName === units[i].name) {
      // Self-reference — set to null
      units[i].parentId = null;
    } else {
      const parent = nameToLastUnit.get(parentName);
      if (parent !== undefined) {
        units[i].parentId = parent.id;
      } else {
        // No match found — orphaned
        units[i].parentId = null;
      }
    }

    // Track this unit's name for future children
    if (units[i].name) {
      nameToLastUnit.set(units[i].name!, units[i]);
    }
  }
}

// (SYSTEM_PROMPT is loaded from config at the top of this file)

/**
 * Extract semantic units from a single page image.
 *
 * @param env Worker environment with AI binding
 * @param imageBase64 Base64-encoded PNG of the page
 * @param pageNumber Page number (for logging)
 * @param continuation Optional continuation state from the previous page
 * @param modelId Vision model ID (defaults to env.VISION_MODEL or Mistral Small 3.1)
 * @param maxTokens Maximum output tokens (default 16000)
 * @returns Parsed vision result with units and continuation state
 */
export async function extractPage(
  env: Env,
  imageBase64: string,
  pageNumber: number,
  continuation?: VisionContinuation | null,
  modelId?: string,
  maxTokens?: number,
): Promise<VisionPageResult> {
  const model = modelId || env.VISION_MODEL || "@cf/mistralai/mistral-small-3.1-24b-instruct";
  const maxTok = maxTokens || INGESTION.vision.maxTokens.value;
  const temperature = INGESTION.vision.temperature.value;

  // Build user message with optional continuation context
  let userText: string;
  if (continuation && (continuation.sectionPath.length > 0 || continuation.lastUnitContent || continuation.lastContainers.length > 0)) {
    const parts: string[] = ["Previous page context:"];
    if (continuation.sectionPath.length > 0) {
      parts.push(`  Section path: ${continuation.sectionPath.join(" > ")}`);
    }
    if (continuation.lastUnitName) {
      parts.push(`  Last unit name: "${continuation.lastUnitName}"`);
    }
    if (continuation.lastUnitContent) {
      parts.push(`  Last unit content (end of previous page): "${continuation.lastUnitContent}"`);
    }
    if (continuation.lastContainers.length > 0) {
      const containerStrs = continuation.lastContainers.map((c) => `"${c.name}" (content: "${c.content.slice(0, 200)}")`);
      parts.push(`  Recent container units (for cross-page parent linking): ${containerStrs.join(", ")}`);
    }
    parts.push("", "Extract all semantic units from this rulebook page. Return the JSON object.");
    userText = parts.join("\n");
  } else {
    userText = "Extract all semantic units from this rulebook page. Return the JSON object.";
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageBase64}` },
        },
        { type: "text", text: userText },
      ],
    },
  ];

  console.log(`[vision] page ${pageNumber}: calling ${model}, ${imageBase64.length} chars image, ${maxTok} max_tokens`);

  const start = Date.now();
  const res: any = await env.AI.run(model, {
    messages,
    temperature,
    max_tokens: maxTok,
  } as any);
  const elapsed = Date.now() - start;

  // Extract text from response (handle various response formats)
  let text: string;
  if (typeof res === "string") text = res;
  else if (typeof res?.response === "string") text = res.response;
  else if (res?.response && typeof res.response === "object") text = JSON.stringify(res.response);
  else text = JSON.stringify(res);

  // Handle OpenAI-style choices array (some models return this)
  let reasoning = "";
  try {
    const parsed = JSON.parse(text);
    if (parsed?.choices?.[0]?.message?.content) {
      text = parsed.choices[0].message.content;
      reasoning = parsed.choices[0].message.reasoning_content ?? "";
    }
  } catch {}

  // If content is empty but reasoning has content (reasoning models like Gemma 4),
  // try to extract JSON from the reasoning text as a fallback.
  if (!text.trim() && reasoning) {
    text = reasoning;
  }

  console.log(`[vision] page ${pageNumber}: ${elapsed}ms, ${text.length} chars response`);

  // Parse JSON from response
  let parsed: VisionPageResult;
  try {
    const jsonText = extractJsonBlock(text);
    parsed = JSON.parse(jsonText);
  } catch {
    try {
      const jsonText = extractJsonBlock(text);
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(`Failed to parse vision response as JSON. Raw text (first 500): ${text.slice(0, 500)}`);
    }
  }

  // Normalize the result — override page number with the PDF page number
  const units: VisionUnit[] = (parsed.units || []).map((u: any, i: number) => ({
    id: "", // assigned below
    type: u.type || "Rule",
    name: u.name || null,
    content: u.content || "",
    parentName: u.parentName ?? null,
    parentId: null, // resolved from parentName below
    page: pageNumber,
    section: u.section || [],
  }));

  // Assign UUID-based IDs first (so resolveParentNames can reference them)
  for (let i = 0; i < units.length; i++) {
    units[i].id = unitId(units[i].type);
  }

  // Resolve parentName → parentId
  resolveParentNames(units);

  // Build continuation state deterministically from the extracted units.
  // The LLM does NOT produce the continuation — it's computed from the actual
  // units on this page. This is a purely mechanical task:
  //   - sectionPath: the section of the last unit (carried forward if no new heading)
  //   - lastUnitName/lastUnitContent: the last unit on this page
  //   - lastContainers: units that have children, carried forward + new ones
  const lastUnit = units.length > 0 ? units[units.length - 1] : null;
  const cont: VisionContinuation = {
    sectionPath: lastUnit?.section ?? continuation?.sectionPath ?? [],
    lastUnitName: lastUnit?.name ?? null,
    lastUnitContent: lastUnit?.content.slice(-100) ?? "",
    lastContainers: [],
  };

  // Update lastContainers: maintain a stack of containers across pages.
  // A unit is a container if another unit on the same page references it as
  // parentName. Push new containers onto the stack (re-push if already present
  // so it moves to the top). Peek the top N for the next page's continuation.
  const containerCount = INGESTION.vision.continuationContainerCount.value;
  const stack: { name: string; content: string }[] = [...(continuation?.lastContainers || [])];
  for (const unit of units) {
    const hasChildren = units.some((u) => u.parentName === unit.name && u.name !== unit.name);
    if (hasChildren && unit.name) {
      // Remove if already on the stack, then push to top
      const idx = stack.findIndex((c) => c.name === unit.name);
      if (idx >= 0) stack.splice(idx, 1);
      stack.push({ name: unit.name, content: unit.content });
    }
  }
  // Peek top N
  cont.lastContainers = stack.slice(-containerCount);

  console.log(`[vision] page ${pageNumber}: ${units.length} units`);

  return { units, continuation: cont };
}

/**
 * Extract units from a batch of page images sequentially, passing
 * continuation state between pages.
 *
 * @returns All units from all pages, with parentId resolved globally
 */
export async function extractPages(
  env: Env,
  pages: { imageBase64: string; pageNumber: number }[],
  modelId?: string,
  maxTokens?: number,
): Promise<{
  units: VisionUnit[];
  raw: { pageNumber: number; result: VisionPageResult; elapsedMs: number }[];
}> {
  const allUnits: VisionUnit[] = [];
  const raw: { pageNumber: number; result: VisionPageResult; elapsedMs: number }[] = [];
  let continuation: VisionContinuation | null = null;
  // Global name → unit map for cross-page parent resolution
  const globalNameToUnit = new Map<string, VisionUnit>();

  for (const page of pages) {
    const start = Date.now();
    const result = await extractPage(
      env,
      page.imageBase64,
      page.pageNumber,
      continuation,
      modelId,
      maxTokens,
    );
    const elapsedMs = Date.now() - start;

    // For units where parentName didn't resolve locally (orphaned), try global resolution
    for (const unit of result.units) {
      if (unit.parentName && unit.parentId === null) {
        // Local resolution failed — try global (cross-page parent)
        const globalParent = globalNameToUnit.get(unit.parentName);
        if (globalParent) {
          unit.parentId = globalParent.id;
        }
      }
      allUnits.push(unit);

      // Track this unit's name globally
      if (unit.name) {
        globalNameToUnit.set(unit.name, unit);
      }
    }

    raw.push({ pageNumber: page.pageNumber, result, elapsedMs });

    continuation = result.continuation;
  }

  return { units: allUnits, raw };
}
