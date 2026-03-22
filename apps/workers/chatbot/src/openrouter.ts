import type { ChatMessage } from "./types.js";
import { OPENROUTER_MODEL } from "./types.js";

export type OpenRouterResult =
  | {
      ok: true;
      content: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
  | { ok: false };

export async function callOpenRouter(params: {
  apiKey: string;
  systemPrompt: string;
  history: ChatMessage[];
  userMessage: string;
  referer: string;
  title: string;
}): Promise<OpenRouterResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...params.history.slice(-10),
    { role: "user", content: params.userMessage },
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": params.referer,
        "X-Title": params.title,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 300,
        messages,
      }),
    });

    const raw = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false };
    }

    if (!res.ok) return { ok: false };

    const obj = data as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = obj.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false };

    const pt = Number(obj.usage?.prompt_tokens ?? 0);
    const ct = Number(obj.usage?.completion_tokens ?? 0);
    const tt = Number(obj.usage?.total_tokens ?? pt + ct);

    return {
      ok: true,
      content,
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: tt },
    };
  } catch {
    return { ok: false };
  }
}
