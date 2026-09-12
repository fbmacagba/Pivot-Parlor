import { describe, it, expect } from "vitest";
import { chatComplete, LlmError, type ChatRequest, type ProviderKeys } from "../src/index";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** Queue of response factories; every call is recorded with its parsed JSON body. */
function makeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), init: init ?? {}, body });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sleeper() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

const KEYS: ProviderKeys = { openrouter: "or-key", openai: "oa-key", anthropic: "an-key" };

const openAiStyle = (content: string) => () =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

const anthropicStyle = (parts: string[]) => () =>
  Response.json({
    content: parts.map((text) => ({ type: "text", text })),
    usage: { input_tokens: 5, output_tokens: 3 },
  });

const base: Omit<ChatRequest, "modelId"> = {
  system: "You are terse.",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 500,
};

describe("chatComplete request shapes", () => {
  it("OpenRouter: chat/completions with today's headers, reasoning.effort and response_format when jsonOnly", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle('{"ok":true}')]);
    const res = await chatComplete(
      { ...base, modelId: "anthropic/claude-sonnet-5", effort: "high", jsonOnly: true, appTitle: "Pivot Parlor Research" },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key");
    expect(headers["HTTP-Referer"]).toBe("https://pivotparlor.com");
    expect(headers["X-Title"]).toBe("Pivot Parlor Research");
    expect(call.body.model).toBe("anthropic/claude-sonnet-5");
    expect(call.body.max_tokens).toBe(500);
    expect(call.body.reasoning).toEqual({ effort: "high" });
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
    expect(res).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 11, outputTokens: 7 },
      route: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("OpenRouter: omits reasoning and response_format when not asked", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("hello")]);
    await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl });
    expect(calls[0]!.body).not.toHaveProperty("reasoning");
    expect(calls[0]!.body).not.toHaveProperty("response_format");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Title"]).toBe("Pivot Parlor");
  });

  it("OpenAI: /v1/chat/completions with max_completion_tokens and reasoning_effort", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("hello")]);
    const res = await chatComplete(
      { ...base, modelId: "openai-api/gpt-6-astra", effort: "low", jsonOnly: true },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer oa-key");
    expect(call.body.model).toBe("gpt-6-astra");
    expect(call.body.max_completion_tokens).toBe(500);
    expect(call.body).not.toHaveProperty("max_tokens");
    expect(call.body.reasoning_effort).toBe("low");
    expect(call.body).not.toHaveProperty("reasoning");
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect((call.body.messages as unknown[])[0]).toEqual({ role: "system", content: "You are terse." });
    expect(res.route).toBe("openai");
    expect(res.model).toBe("gpt-6-astra");
  });

  it("Anthropic: /v1/messages with x-api-key, anthropic-version, top-level system and output_config.effort", async () => {
    const { fetchImpl, calls } = makeFetch([anthropicStyle(["Hel", "lo"])]);
    const res = await chatComplete(
      { ...base, modelId: "anthropic-api/claude-opus-5", effort: "medium" },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("an-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body.model).toBe("claude-opus-5");
    expect(call.body.max_tokens).toBe(500);
    expect(call.body.system).toBe("You are terse.");
    expect(call.body.output_config).toEqual({ effort: "medium" });
    expect(call.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("Hello");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("Anthropic: drops leading assistant turns and merges consecutive same-role turns", async () => {
    const { fetchImpl, calls } = makeFetch([anthropicStyle(["ok"])]);
    await chatComplete(
      {
        modelId: "anthropic-api/claude-haiku-4.5",
        maxTokens: 100,
        messages: [
          { role: "assistant", content: "Welcome!" },
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "c" },
          { role: "user", content: "d" },
        ],
      },
      KEYS,
      { fetch: fetchImpl },
    );
    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
    expect(calls[0]!.body).not.toHaveProperty("system");
  });

  it("applies the token cap for the model before sending", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("x")]);
    await chatComplete({ ...base, modelId: "meta-llama/llama-4-maverick", maxTokens: 9000 }, KEYS, { fetch: fetchImpl });
    expect(calls[0]!.body.max_tokens).toBe(4096);
  });

  it("extracts the JSON object from a chatty reply when jsonOnly", async () => {
    const { fetchImpl } = makeFetch([openAiStyle('Here you go:\n```json\n{"a":1}\n```\nEnjoy')]);
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6", jsonOnly: true }, KEYS, { fetch: fetchImpl });
    expect(res.text).toBe('{"a":1}');
  });
});

describe("chatComplete failure handling", () => {
  it("retries once without effort when OpenAI rejects reasoning_effort with a 400", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 }),
      openAiStyle("fine"),
    ]);
    const res = await chatComplete({ ...base, modelId: "openai-api/gpt-5.6-luna", effort: "high" }, KEYS, { fetch: fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.reasoning_effort).toBe("high");
    expect(calls[1]!.body).not.toHaveProperty("reasoning_effort");
    expect(res.text).toBe("fine");
  });

  it("retries once without effort on any OpenRouter 400 (today's worker rule)", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("bad request", { status: 400 }),
      openAiStyle("fine"),
    ]);
    await chatComplete({ ...base, modelId: "deepseek/deepseek-v4-pro", effort: "low" }, KEYS, { fetch: fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).not.toHaveProperty("reasoning");
  });

  it("does not retry a 400 that was sent without effort", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("bad request", { status: 400 })]);
    await expect(chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      name: "LlmError",
      status: 400,
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("backs off 3 s, 6 s, 9 s on 429 / 5xx and then succeeds", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("slow down", { status: 429 }),
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 500 }),
      openAiStyle("finally"),
    ]);
    const s = sleeper();
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl, sleep: s.sleep });
    expect(res.text).toBe("finally");
    expect(calls).toHaveLength(4);
    expect(s.sleeps).toEqual([3000, 6000, 9000]);
  });

  it("gives up after maxRetries with a retryable LlmError naming route, model and status", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
    ]);
    const s = sleeper();
    const err = await chatComplete({ ...base, modelId: "anthropic/claude-sonnet-5" }, KEYS, { fetch: fetchImpl, sleep: s.sleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toBe("openrouter/anthropic/claude-sonnet-5: HTTP 429 rate limited");
    expect((err as LlmError).retryable).toBe(true);
    expect((err as LlmError).status).toBe(429);
    expect(calls).toHaveLength(4);
  });

  it("honours maxRetries: 0", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("boom", { status: 500 })]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", maxRetries: 0 }, KEYS, { fetch: fetchImpl, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("nope", { status: 401 })]);
    await expect(chatComplete({ ...base, modelId: "openai-api/gpt-6-astra" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      status: 401,
      retryable: false,
      message: "openai/gpt-6-astra: HTTP 401 nope",
    });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and reports them as <route>: <message>", async () => {
    const { fetchImpl } = makeFetch([
      () => {
        throw new Error("socket hang up");
      },
      openAiStyle("ok"),
    ]);
    const s = sleeper();
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl, sleep: s.sleep });
    expect(res.text).toBe("ok");
    expect(s.sleeps).toEqual([3000]);

    const { fetchImpl: dead } = makeFetch([
      () => {
        throw new Error("socket hang up");
      },
    ]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", maxRetries: 0 }, KEYS, { fetch: dead }),
    ).rejects.toMatchObject({ message: "openrouter: socket hang up", retryable: true });
  });

  it("stops on abort without retrying", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = makeFetch([
      () => {
        controller.abort();
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        throw e;
      },
    ]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", signal: controller.signal }, KEYS, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ message: "openrouter: aborted", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("throws before any fetch when the route's key is missing", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const err = await chatComplete({ ...base, modelId: "openai-api/gpt-6-astra" }, { openrouter: "k" }, { fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toBe("openai: API key not configured");
    expect((err as LlmError).status).toBeUndefined();
    expect((err as LlmError).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats a 200 with no usable content as a non-retryable error", async () => {
    const { fetchImpl } = makeFetch([() => Response.json({ choices: [] })]);
    await expect(chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      retryable: false,
      status: 200,
    });
  });
});
