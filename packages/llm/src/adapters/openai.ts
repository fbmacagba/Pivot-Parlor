import type { Adapter } from "../types";
import { parseOpenAiStyle } from "./openrouter";

export const openAiAdapter: Adapter = {
  route: "openai",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_completion_tokens: req.maxTokens,
          ...(req.effort ? { reasoning_effort: req.effort } : {}),
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
  isEffortRejection: (body) => /reasoning_effort|reasoning|effort/i.test(body),
};
