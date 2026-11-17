import { chatComplete, type ChatDeps, type Effort, type ProviderKeys } from "@repo/llm";
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
 * Output budget for one reply. The prompt asks for 2-3 short sentences, about
 * a hundred tokens, but a model that reasons spends its thinking from the same
 * budget first; at the old flat 150 a reasoning model ran out before writing
 * anything, the call failed and the default model answered instead. `effort`
 * is the level that will run: the chosen one, else the model's own default.
 * Unknown (a record saved before effort existed, or the default-model rescue)
 * gets room for medium, the most common default.
 */
export function chatReplyBudget(effort: Effort | undefined): number {
  switch (effort) {
    case "none":
      return 300;
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
    case undefined:
      return 4096;
    default:
      // high, xhigh, max: only ever a model's own default, never chosen for the chatbot.
      return 8192;
  }
}

/** A visitor is waiting: a model that has not answered by then is abandoned for the next candidate. */
export const CHAT_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * One reply for the shop chatbot. The chosen model is tried once (a visitor
 * is waiting, so no HTTP back-off) with the chosen effort, if any; if it fails
 * for any reason (missing direct key, vendor error, no answer within the time
 * limit) the code default is tried once, without effort.
 */
export async function generateReply(
  params: {
    keys: ProviderKeys;
    modelId: string;
    /** Sent to the chosen model only. */
    effort?: Effort;
    /** The chosen model's own default, for sizing when no effort is chosen. */
    defaultEffort?: Effort;
    systemPrompt: string;
    history: HistoryMessage[];
    userMessage: string;
    /** Per-attempt limit; tests shorten it. */
    attemptTimeoutMs?: number;
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
    const chosen = modelId === params.modelId;
    const effort = chosen ? params.effort : undefined;
    const budgetEffort = chosen ? (params.effort ?? params.defaultEffort) : undefined;
    try {
      const r = await chatComplete(
        {
          modelId,
          system: params.systemPrompt,
          messages,
          ...(effort ? { effort } : {}),
          maxTokens: chatReplyBudget(budgetEffort),
          maxRetries: 0,
          signal: AbortSignal.timeout(params.attemptTimeoutMs ?? CHAT_ATTEMPT_TIMEOUT_MS),
          appTitle: "Pivot Parlor Chatbot",
        },
        params.keys,
        deps
      );
      const prompt_tokens = r.usage?.inputTokens ?? 0;
      const completion_tokens = r.usage?.outputTokens ?? 0;
      console.log(
        `[chatbot] llm route=${r.route} model=${r.model}${effort ? ` effort=${effort}` : ""} in=${prompt_tokens} out=${completion_tokens}`
      );
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
