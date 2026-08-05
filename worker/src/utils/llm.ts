import type { Env } from "../types";
import { jsonrepair } from "jsonrepair";

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const start = first === -1 ? firstArr : firstArr === -1 ? first : Math.min(first, firstArr);
  if (start === -1) return text.trim();
  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end === -1) return text.trim();
  return text.slice(start, end + 1).trim();
}

/** Runs a chat completion against Workers AI and parses a JSON response.
 *  When a JSON schema is provided, JSON Mode is used to force a valid response. */
export async function llmJson<T>(
  env: Env,
  system: string,
  user: string,
  opts: { model?: string; maxRetries?: number; schema?: Record<string, unknown> } = {}
): Promise<T> {
  const model = opts.model ?? env.EXTRACTION_MODEL;
  const maxRetries = opts.maxRetries ?? 2;
  const schema = opts.schema ?? { type: "object", additionalProperties: true };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res: any = await env.AI.run(model as any, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_schema", json_schema: schema },
      });

      // JSON Mode may return the parsed JSON object directly in res.response.
      if (res && typeof res === "object" && res.response && typeof res.response !== "string") {
        return res.response as T;
      }

      let text: string;
      if (typeof res === "string") {
        text = res;
      } else if (res && typeof res.response === "string") {
        text = res.response;
      } else {
        text = JSON.stringify(res);
      }

      const jsonText = extractJsonBlock(text);
      try {
        return JSON.parse(jsonText) as T;
      } catch {
        return JSON.parse(jsonrepair(jsonText)) as T;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`llmJson failed after retries: ${String(lastErr)}`);
}

/** Free-form text completion (used for answer generation). */
export async function llmText(env: Env, system: string, user: string, model?: string): Promise<string> {
  const res: any = await env.AI.run((model ?? env.ANSWER_MODEL) as any, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });
  return typeof res === "string" ? res : res.response ?? "";
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res: any = await env.AI.run(env.EMBEDDING_MODEL as any, { text: texts });
  const data = res.data ?? res.response ?? res;
  return data as number[][];
}

export async function rerank(
  env: Env,
  query: string,
  documents: string[]
): Promise<{ index: number; score: number }[]> {
  try {
    const res: any = await env.AI.run(env.RERANK_MODEL as any, {
      query,
      contexts: documents.map((text) => ({ text })),
    });
    const results = res.response ?? res;
    return (results as any[])
      .map((r) => ({ index: r.id ?? r.index, score: r.score }))
      .sort((a, b) => b.score - a.score);
  } catch {
    // Fallback: no reranker available, preserve original order with descending fake scores.
    return documents.map((_, index) => ({ index, score: documents.length - index }));
  }
}
