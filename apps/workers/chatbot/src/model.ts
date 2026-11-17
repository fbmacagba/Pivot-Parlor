import { isValidModelId, parseEffort, type Effort } from "@repo/llm";

/** Code default: today's chatbot model (Gemini Flash Lite via OpenRouter). */
export const DEFAULT_CHATBOT_MODEL = "google/gemini-3.1-flash-lite-preview";
/** Written by the API worker (POST /api/ai/chatbot-model): { model_id, effort?, default_effort?, updated_at }. */
export const CHATBOT_MODEL_KV_KEY = "platform:chatbot:model";

export interface ResolvedChatbotModel {
  modelId: string;
  source: "platform" | "default";
  reason?: "unset" | "bad-json" | "invalid-id";
  /** The level chosen on AI Deploy, sent to the model. */
  effort?: Effort;
  /** The model's own default when it was saved: sizes the output budget only. */
  defaultEffort?: Effort;
}

/** The platform-wide choice from KV, or the code default with the reason. */
export function resolveChatbotModel(raw: string | null | undefined): ResolvedChatbotModel {
  if (!raw) return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "unset" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "bad-json" };
  }
  const id =
    parsed && typeof parsed === "object" && typeof (parsed as { model_id?: unknown }).model_id === "string"
      ? (parsed as { model_id: string }).model_id.trim()
      : "";
  if (!id || !isValidModelId(id)) return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "invalid-id" };
  const record = parsed as { effort?: unknown; default_effort?: unknown };
  const effort = parseEffort(record.effort);
  const defaultEffort = parseEffort(record.default_effort);
  return {
    modelId: id,
    source: "platform",
    ...(effort ? { effort } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}
