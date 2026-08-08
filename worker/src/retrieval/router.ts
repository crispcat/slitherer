import type { Env, ConversationMessage, RouterResult } from "../types";
import { llmJson, llmText } from "../utils/llm";
import { RETRIEVAL } from "../config.gen";

const FALLBACK_RAG = RETRIEVAL.router.fallbackRag.value;
const FALLBACK_LANGUAGE = RETRIEVAL.router.fallbackLanguage.value;

const ROUTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rag: { type: "boolean" },
    language: { type: "string" },
    russian_query: { type: "string" },
    chat_response: { type: "string" },
  },
  required: ["rag", "language", "russian_query"],
};

const SYSTEM_PROMPT = RETRIEVAL.prompts.router.text;
const CHAT_PROMPT_TEMPLATE = RETRIEVAL.prompts.chatResponse.text;

export async function route(
  env: Env,
  question: string,
  history: ConversationMessage[] = []
): Promise<RouterResult> {
  const historyText = history.length > 0
    ? `\n\nConversation history (last ${history.length} messages):\n${history.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const userPrompt = `User message: ${question}${historyText}`;

  try {
    const result = await llmJson<{
      rag: boolean;
      language: string;
      russian_query: string;
      chat_response?: string;
    }>(env, SYSTEM_PROMPT, userPrompt, {
      model: env.EXTRACTION_MODEL,
      schema: ROUTER_SCHEMA,
    });

    return {
      rag: result.rag ?? FALLBACK_RAG,
      language: result.language ?? FALLBACK_LANGUAGE,
      russianQuery: result.russian_query ?? question,
      chatResponse: result.chat_response,
    };
  } catch (err) {
    console.warn(`Router failed, defaulting to RAG=${FALLBACK_RAG}: ${String(err)}`);
    return {
      rag: FALLBACK_RAG,
      language: FALLBACK_LANGUAGE,
      russianQuery: question,
    };
  }
}

/** Generate a direct chat response when rag=false and no chat_response was provided by the router. */
export async function generateChatResponse(
  env: Env,
  question: string,
  language: string,
  history: ConversationMessage[] = []
): Promise<string> {
  const historyText = history.length > 0
    ? `\n\nConversation history:\n${history.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  try {
    const chatPrompt = CHAT_PROMPT_TEMPLATE.replace("${language}", language);
    return await llmText(
      env,
      chatPrompt,
      `User message: ${question}${historyText}`,
      env.EXTRACTION_MODEL
    );
  } catch {
    return "I'm here to help with RPG rules questions. What would you like to know?";
  }
}
