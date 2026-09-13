import type { Adapter, ChatUsage } from "../types";

interface OpenAiStyleBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Shared by OpenRouter and OpenAI: both speak the chat/completions shape. */
export function parseOpenAiStyle(body: unknown): { text: string; usage: ChatUsage | null } | null {
  const o = (body ?? {}) as OpenAiStyleBody;
  const content = o.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  const usage =
    typeof o.usage?.prompt_tokens === "number" && typeof o.usage?.completion_tokens === "number"
      ? { inputTokens: o.usage.prompt_tokens, outputTokens: o.usage.completion_tokens }
      : null;
  return { text: content, usage };
}

export const openRouterAdapter: Adapter = {
  route: "openrouter",
  buildRequest(req, apiKey) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://pivotparlor.com",
          "X-Title": req.appTitle,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
          ...(req.jsonOnly ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            ...req.messages,
          ],
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse: parseOpenAiStyle,
  // Some OpenRouter providers reject the reasoning block with an unspecific
  // 400; the research and text workers always retried without it.
  isEffortRejection: () => true,
};
