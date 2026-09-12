import type { Adapter, ChatMessage } from "../types";

interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The Messages API requires the first turn to be a user turn and rejects two
 * consecutive turns with the same role: drop leading assistant turns and merge
 * runs of the same role.
 */
export function normalizeAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (out.length === 0 && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const anthropicAdapter: Adapter = {
  route: "anthropic",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          messages: normalizeAnthropicMessages(req.messages),
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse(body) {
    const o = (body ?? {}) as AnthropicBody;
    const text = (o.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (!text.trim()) return null;
    const usage =
      typeof o.usage?.input_tokens === "number" && typeof o.usage?.output_tokens === "number"
        ? { inputTokens: o.usage.input_tokens, outputTokens: o.usage.output_tokens }
        : null;
    return { text, usage };
  },
  isEffortRejection: (body) => /output_config|effort/i.test(body),
};
