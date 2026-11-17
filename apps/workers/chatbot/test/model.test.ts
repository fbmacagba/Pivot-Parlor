import { describe, it, expect } from "vitest";
import { CHATBOT_MODEL_KV_KEY, DEFAULT_CHATBOT_MODEL, resolveChatbotModel } from "../src/model";
import { CHAT_ATTEMPT_TIMEOUT_MS, chatReplyBudget, generateReply } from "../src/llm";

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

  it("reads the saved effort and the model's default, and ignores values off the ladder", () => {
    expect(
      resolveChatbotModel(JSON.stringify({ model_id: "openai-api/gpt-6-luna", effort: "low", default_effort: "medium" }))
    ).toEqual({ modelId: "openai-api/gpt-6-luna", source: "platform", effort: "low", defaultEffort: "medium" });
    const odd = resolveChatbotModel(JSON.stringify({ model_id: "openai-api/gpt-6-luna", effort: "turbo", default_effort: 3 }));
    expect(odd).toEqual({ modelId: "openai-api/gpt-6-luna", source: "platform" });
    expect(odd).not.toHaveProperty("effort");
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

  it("sizes the reply budget by the effort that will run, with room for medium when it is unknown", () => {
    expect([undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"].map((e) => chatReplyBudget(e as never))).toEqual([
      4096, 300, 1024, 2048, 4096, 8192, 8192, 8192,
    ]);
    expect(CHAT_ATTEMPT_TIMEOUT_MS).toBe(20_000);
  });

  it("calls the chosen model with the system prompt, trimmed history and room to reason, without effort when none is saved", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => Response.json({ content: [{ type: "text", text: "From £12." }], usage: { input_tokens: 40, output_tokens: 5 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "anthropic-api/claude-haiku-4.5" }, { fetch: fetchImpl });
    expect(res).toEqual({
      ok: true,
      content: "From £12.",
      model: "anthropic-api/claude-haiku-4.5",
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      route: "anthropic",
      rawUsage: { inputTokens: 40, outputTokens: 5 },
      wasted: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.body.system).toBe("You are the shop assistant.");
    // A record saved before effort existed: the model's default is unknown, so it gets room for medium.
    expect(calls[0]!.body.max_tokens).toBe(4096);
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
    // A 401 is not billed: nothing for the cost log.
    expect(res).toMatchObject({ ok: true, content: "Sure.", model: "google/gemini-3.1-flash-lite-preview", wasted: [] });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("sends the saved effort to the chosen model and sizes the budget for it", async () => {
    const { fetchImpl, calls } = makeFetch([() => Response.json({ choices: [{ message: { content: "Sure." } }] })]);
    await generateReply({ ...params, modelId: "openai-api/gpt-6-luna", effort: "low", defaultEffort: "medium" }, { fetch: fetchImpl });
    expect(calls[0]!.body.reasoning_effort).toBe("low");
    expect(calls[0]!.body.max_completion_tokens).toBe(2048);
  });

  it("with no effort saved, sizes for the model's own default without sending it", async () => {
    const { fetchImpl, calls } = makeFetch([() => Response.json({ choices: [{ message: { content: "Sure." } }] })]);
    await generateReply({ ...params, modelId: "x-ai/grok-4.7", defaultEffort: "high" }, { fetch: fetchImpl });
    expect(calls[0]!.body).not.toHaveProperty("reasoning");
    expect(calls[0]!.body.max_tokens).toBe(8192);
  });

  it("the default-model rescue gets no effort and the unknown-default budget", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("down", { status: 503 }),
      () => Response.json({ choices: [{ message: { content: "Sure." } }] }),
    ]);
    const res = await generateReply({ ...params, modelId: "openai/gpt-6-luna", effort: "none" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, model: "google/gemini-3.1-flash-lite-preview" });
    expect(calls[0]!.body.reasoning).toEqual({ effort: "none" });
    expect(calls[0]!.body.max_tokens).toBe(300);
    expect(calls[1]!.body).not.toHaveProperty("reasoning");
    expect(calls[1]!.body.max_tokens).toBe(4096);
  });

  it("abandons a model that has not answered in time and lets the default model answer", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      if (seen.length === 1) {
        // The chosen model never answers; only the time limit ends the wait.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")));
        });
      }
      return Response.json({ choices: [{ message: { content: "Sure." } }] });
    }) as typeof fetch;
    const res = await generateReply({ ...params, modelId: "openai/gpt-6-luna", attemptTimeoutMs: 50 }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, content: "Sure.", model: "google/gemini-3.1-flash-lite-preview" });
    expect(seen).toHaveLength(2);
    // Abandoned, so its tokens (if any) are unknown.
    expect(res.wasted).toEqual([{ model: "openai/gpt-6-luna", usage: null, reason: "timed_out" }]);
  });

  it("reports an empty reply's billed tokens as wasted, then lets the default model answer", async () => {
    const { fetchImpl } = makeFetch([
      () => Response.json({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 90, completion_tokens: 150 } }),
      () => Response.json({ choices: [{ message: { content: "Sure." } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "openai/gpt-6.1-terra" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, content: "Sure.", model: "google/gemini-3.1-flash-lite-preview" });
    expect(res.wasted).toEqual([
      { model: "openai/gpt-6.1-terra", usage: { inputTokens: 90, outputTokens: 150 }, reason: "no_content" },
    ]);
  });

  it("does not retry the default model against itself and reports ok:false", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("boom", { status: 500 })]);
    const res = await generateReply({ ...params, modelId: "google/gemini-3.1-flash-lite-preview" }, { fetch: fetchImpl });
    expect(res).toEqual({ ok: false, wasted: [] });
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
