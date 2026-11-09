import { chatComplete, type ChatDeps, type ProviderKeys } from "@repo/llm";
import { DEFAULT_CHATBOT_MODEL } from "./model.js";

export type HistoryMessage = { role: "user" | "assistant" | "system"; content: string };

export type ChatCallResult =
  | {
      ok: true;
      content: string;
      /** Route-qualified id that actually answered (chosen model or the default rescue). */
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      /** The route that was called, for the audit entry. */
      route: string;
      /** The provider's own counts, null when it sent none (usage above then reads 0). */
      rawUsage: { inputTokens: number; outputTokens: number } | null;
    }
  | { ok: false };

/**
 * One reply for the shop chatbot. The chosen model is tried once (a visitor
 * is waiting, so no HTTP back-off); if it fails for any reason (missing
 * direct key, vendor error) the code default is tried once. Effort is never
 * sent for the chatbot.
 */
export async function generateReply(
  params: {
    keys: ProviderKeys;
    modelId: string;
    systemPrompt: string;
    history: HistoryMessage[];
    userMessage: string;
  },
  deps: ChatDeps = {}
): Promise<ChatCallResult> {
  const messages = [
    ...params.history
      .slice(-10)
      .filter((m): m is { role: "user" | "assistant"; content: string } => m.role === "user" || m.role === "assistant"),
    { role: "user" as const, content: params.userMessage },
  ];
  const candidates = params.modelId === DEFAULT_CHATBOT_MODEL ? [params.modelId] : [params.modelId, DEFAULT_CHATBOT_MODEL];

  for (const modelId of candidates) {
    try {
      const r = await chatComplete(
        {
          modelId,
          system: params.systemPrompt,
          messages,
          maxTokens: 150,
          maxRetries: 0,
          appTitle: "Pivot Parlor Chatbot",
        },
        params.keys,
        deps
      );
      const prompt_tokens = r.usage?.inputTokens ?? 0;
      const completion_tokens = r.usage?.outputTokens ?? 0;
      console.log(`[chatbot] llm route=${r.route} model=${r.model} in=${prompt_tokens} out=${completion_tokens}`);
      return {
        ok: true,
        content: r.text,
        model: modelId,
        usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
        route: r.route,
        rawUsage: r.usage ? { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } : null,
      };
    } catch (err) {
      console.warn(`[chatbot] ${modelId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: false };
}
