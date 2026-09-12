import { describe, it, expect } from "vitest";
import { CHATBOT_MODEL_KV_KEY, DEFAULT_CHATBOT_MODEL, resolveChatbotModel } from "../src/model";
import { generateReply } from "../src/llm";

describe("resolveChatbotModel", () => {
  it("uses the platform choice when the KV record is valid", () => {
    expect(resolveChatbotModel(JSON.stringify({ model_id: "anthropic-api/claude-haiku-4.5", updated_at: "2026-09-12T00:00:00Z" }))).toEqual({
      modelId: "anthropic-api/claude-haiku-4.5",
      source: "platform",
    });
  });

  it("falls back to the code default when the record is absent, unparsable or malformed", () => {
    expect(resolveChatbotModel(null)).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "unset" });
    expect(resolveChatbotModel(undefined).source).toBe("default");
    expect(resolveChatbotModel("not json")).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "bad-json" });
    expect(resolveChatbotModel(JSON.stringify({ model_id: "" }))).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "invalid-id" });
    expect(resolveChatbotModel(JSON.stringify({ model_id: "openai-api/" })).reason).toBe("invalid-id");
    expect(resolveChatbotModel(JSON.stringify({ nothing: true })).reason).toBe("invalid-id");
  });

  it("pins the key and default the API worker writes", () => {
    expect(CHATBOT_MODEL_KV_KEY).toBe("platform:chatbot:model");
    expect(DEFAULT_CHATBOT_MODEL).toBe("google/gemini-3.1-flash-lite-preview");
  });
});

describe("generateReply", () => {
  type Call = { url: string; body: Record<string, unknown> };
  function makeFetch(responses: Array<() => Response>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next();
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const keys = { openrouter: "or", openai: "oa", anthropic: "an" };
  const params = {
    keys,
    systemPrompt: "You are the shop assistant.",
    history: [
      { role: "assistant" as const, content: "Hi there!" },
      { role: "user" as const, content: "Do you cut beards?" },
      { role: "system" as const, content: "should be dropped" },
    ],
    userMessage: "And prices?",
  };

  it("calls the chosen model with the system prompt, trimmed history and a 150-token budget, without effort", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => Response.json({ content: [{ type: "text", text: "From £12." }], usage: { input_tokens: 40, output_tokens: 5 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "anthropic-api/claude-haiku-4.5" }, { fetch: fetchImpl });
    expect(res).toEqual({
      ok: true,
      content: "From £12.",
      model: "anthropic-api/claude-haiku-4.5",
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.body.system).toBe("You are the shop assistant.");
    expect(calls[0]!.body.max_tokens).toBe(150);
    expect(calls[0]!.body).not.toHaveProperty("output_config");
    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: "Do you cut beards?\n\nAnd prices?" },
    ]);
  });

  it("falls back to the default model once when the chosen model fails, and reports which model answered", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("nope", { status: 401 }),
      () => Response.json({ choices: [{ message: { content: "Sure." } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "openai-api/gpt-6-astra" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, content: "Sure.", model: "google/gemini-3.1-flash-lite-preview" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("does not retry the default model against itself and reports ok:false", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("boom", { status: 500 })]);
    const res = await generateReply({ ...params, modelId: "google/gemini-3.1-flash-lite-preview" }, { fetch: fetchImpl });
    expect(res).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("falls back when the direct key is missing without calling the vendor", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => Response.json({ choices: [{ message: { content: "Sure." } }] }),
    ]);
    const res = await generateReply({ ...params, keys: { openrouter: "or" }, modelId: "openai-api/gpt-6-astra" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, model: "google/gemini-3.1-flash-lite-preview", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(calls.map((c) => c.url)).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });
});
