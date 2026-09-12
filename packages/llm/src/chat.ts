import { parseModelId, type Route } from "./ids";
import { abortedError, httpError, LlmError, missingKeyError, networkError, noContentError } from "./errors";
import { extractJsonObject } from "./json";
import { maxOutputTokensFor } from "./tokens";
import { openRouterAdapter } from "./adapters/openrouter";
import { openAiAdapter } from "./adapters/openai";
import { anthropicAdapter } from "./adapters/anthropic";
import type { Adapter, AdapterRequest, ChatDeps, ChatRequest, ChatResult, ProviderKeys } from "./types";

const ADAPTERS: Record<Route, Adapter> = {
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
};

const BACKOFF_MS = [3000, 6000, 9000] as const;
const DEFAULT_MAX_RETRIES = 3;

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

/**
 * One chat completion through whichever route the id names. Shared rules:
 * effort retry (one 400 mentioning effort is retried without it), 429 / 5xx /
 * network back-off, JSON extraction, uniform LlmError text.
 */
export async function chatComplete(req: ChatRequest, keys: ProviderKeys, deps: ChatDeps = {}): Promise<ChatResult> {
  const { route, model } = parseModelId(req.modelId);
  const apiKey = keys[route];
  if (!apiKey) throw missingKeyError(route, model);

  const adapter = ADAPTERS[route];
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;

  const base: AdapterRequest = {
    model,
    system: req.system,
    messages: req.messages,
    effort: req.effort,
    maxTokens: maxOutputTokensFor(req.modelId, req.maxTokens),
    jsonOnly: req.jsonOnly === true,
    signal: req.signal,
    appTitle: req.appTitle ?? "Pivot Parlor",
  };

  let effort = base.effort;
  let attempt = 0;

  const backoff = async (): Promise<void> => {
    await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
    attempt++;
    if (req.signal?.aborted) throw abortedError(route, model);
  };

  for (;;) {
    const { url, init } = adapter.buildRequest({ ...base, effort }, apiKey);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (isAbort(err, req.signal)) throw abortedError(route, model);
      if (attempt < maxRetries) {
        await backoff();
        continue;
      }
      throw networkError(route, model, err);
    }

    const raw = await res.text();
    if (res.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new LlmError({
          route,
          model,
          status: res.status,
          retryable: false,
          message: `${route}/${model}: HTTP ${res.status} non-JSON body`,
        });
      }
      const out = adapter.parseResponse(parsed);
      if (!out) throw noContentError(route, model, res.status, raw);
      return {
        text: base.jsonOnly ? extractJsonObject(out.text) : out.text.trim(),
        usage: out.usage,
        route,
        model,
      };
    }

    if (effort && res.status === 400 && adapter.isEffortRejection(raw)) {
      effort = undefined; // exactly one retry without effort
      continue;
    }
    const err = httpError(route, model, res.status, raw);
    if (err.retryable && attempt < maxRetries) {
      await backoff();
      continue;
    }
    throw err;
  }
}
