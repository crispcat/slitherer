import type { Citation, Env, QueryResult } from "../types";
import type { RetrievedUnit } from "./query";
import { llmText } from "../utils/llm";

const SYSTEM_PROMPT = `You are a rules-lookup assistant for a tabletop RPG. You answer strictly from the
supplied evidence (semantic units extracted from the rulebook).

Rules you MUST follow:
- Use only the supplied evidence. Never invent rules or fill gaps with assumptions.
- Every factual claim must cite the unit id(s) it came from, inline, like "(RULE-00042)".
- If two units conflict, explicitly mention the conflict and which one takes precedence if stated
  (e.g. via an "overrides"/"supersedes" relation), otherwise say the conflict is unresolved.
- If the evidence is incomplete or ambiguous, say so explicitly instead of guessing.
- Answer in the same language as the question.`;

export async function generateAnswer(env: Env, question: string, retrieved: RetrievedUnit[]): Promise<QueryResult> {
  if (retrieved.length === 0) {
    return {
      answer: "В базе знаний не найдено информации, относящейся к этому вопросу.",
      citations: [],
      usedUnitIds: [],
    };
  }

  const evidence = retrieved
    .map(
      (r) =>
        `[${r.unit.id}] (${r.unit.type}, ${r.unit.section.join(" > ")}, page ${r.unit.page})\n${r.unit.content}`
    )
    .join("\n\n---\n\n");

  const userPrompt = `QUESTION:\n${question}\n\nEVIDENCE:\n${evidence}`;
  const answer = await llmText(env, SYSTEM_PROMPT, userPrompt, env.ANSWER_MODEL);

  const usedUnitIds = [...new Set((answer.match(/[A-Z]+-\d{5}/g) ?? []))].filter((id) =>
    retrieved.some((r) => r.unit.id === id)
  );

  const citations: Citation[] = retrieved
    .filter((r) => usedUnitIds.includes(r.unit.id))
    .map((r) => ({ unitId: r.unit.id, section: r.unit.section.join(" > "), page: r.unit.page }));

  return { answer, citations, usedUnitIds };
}
