/**
 * /api/ai/models serves three provider groups with LIVE pricing when the
 * sources are reachable and the snapshot when they are not; the theme
 * generator forwards a validated reasoning effort and rejects garbage.
 *
 * The worker is dispatched in-isolate (direct import), so stubbing
 * globalThis.fetch intercepts every outbound call. Each test deletes the KV
 * cache the setup file seeded so the refresh path actually runs.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";
import { getLiveModels, MODELS_KV_KEY, MODELS_LAST_GOOD_KV_KEY } from "../src/services/model-registry";
import { feedResponses } from "./fixtures/model-feeds";

const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | null;
let stub: FetchStub | null = null;

/** The three list endpoints from the recorded fixtures; `down` makes them all throw. */
function listStub(opts: { down?: boolean } = {}): FetchStub {
  return (url) => {
    const isList =
      url.startsWith("https://openrouter.ai/api/v1/models") ||
      url.startsWith("https://api.openai.com/v1/models") ||
      url.startsWith("https://api.anthropic.com/v1/models");
    if (!isList) return null;
    // Throw synchronously: the async fetch wrapper turns this into its own
    // rejection, which the handler awaits — a detached Promise.reject()
    // here would trip workerd's unhandled-rejection detector.
    if (opts.down) throw new Error("network down");
    if (url.startsWith("https://openrouter.ai/")) return Promise.resolve(feedResponses.openrouter());
    if (url.startsWith("https://api.openai.com/")) return Promise.resolve(feedResponses.openai());
    return Promise.resolve(feedResponses.anthropic());
  };
}

function compose(...stubs: FetchStub[]): FetchStub {
  return (url, init) => {
    for (const s of stubs) {
      const r = s(url, init);
      if (r) return r;
    }
    return null;
  };
}

beforeEach(async () => {
  await env.KV.delete(MODELS_KV_KEY);
  await env.KV.delete(MODELS_LAST_GOOD_KV_KEY);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handled = stub?.(url, init);
    if (handled) return handled;
    return originalFetch(input as never, init as never);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  stub = null;
});

async function devToken(): Promise<string> {
  const userId = await seedUser("developer", null);
  return tokenFor(userId, "developer", null);
}

describe("GET /api/ai/models", () => {
  it("serves the three groups joined with live pricing", async () => {
    stub = listStub();

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(29);

    const sonnet = body.data.find((m) => m.id === "anthropic/claude-sonnet-5")!;
    expect(sonnet.provider).toBe("openrouter");
    expect(sonnet.vendor).toBe("anthropic");
    expect(sonnet.costPer1MInput).toBe(2);
    expect(sonnet.costPer1MOutput).toBe(10);
    expect(sonnet.livePricing).toBe(true);
    expect(sonnet.recommended).toBe(true);

    const astra = body.data.find((m) => m.id === "openai-api/gpt-6-astra")!;
    expect(astra.provider).toBe("openai");
    expect(astra.providerLabel).toBe("OpenAI API");
    expect(astra.costPer1MInput).toBe(10);
    expect(astra.livePricing).toBe(true);

    const fable = body.data.find((m) => m.id === "anthropic-api/claude-fable-5.1")!;
    expect(fable.provider).toBe("anthropic");
    expect(fable.effortLevels).toEqual(["low", "medium", "high"]);

    // The refresh wrote both cache keys.
    expect(await env.KV.get(MODELS_KV_KEY)).not.toBeNull();
    expect(await env.KV.get(MODELS_LAST_GOOD_KV_KEY)).not.toBeNull();
  });

  it("serves the snapshot when every source is unreachable and does not keep it for long", async () => {
    stub = listStub({ down: true });

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(29);
    expect(body.data.every((m) => m.livePricing === false)).toBe(true);
    for (const m of body.data) {
      expect(typeof m.costPer1MInput).toBe("number");
      expect(typeof m.costPer1MOutput).toBe("number");
      expect(typeof m.providerLabel).toBe("string");
      expect(typeof m.vendorLabel).toBe("string");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.effortLevels)).toBe(true);
    }
    // Degraded build: served, but the last-good copy is not overwritten.
    expect(await env.KV.get(MODELS_LAST_GOOD_KV_KEY)).toBeNull();
  });

  it("hides a direct group when its platform key is missing", async () => {
    stub = listStub();
    const seen: string[] = [];
    const inner = stub;
    stub = (url, init) => {
      seen.push(url);
      return inner(url, init);
    };

    const models = await getLiveModels(env.KV, { openrouter: "k" });
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "anthropic")).toBe(false);
    expect(models.some((m) => m.provider === "openrouter")).toBe(true);
    expect(seen.some((u) => u.includes("api.openai.com") || u.includes("api.anthropic.com"))).toBe(false);
  });

  it("serves the cached list without refetching", async () => {
    stub = listStub();
    await getLiveModels(env.KV, { openrouter: "k", openai: "k", anthropic: "k" });
    stub = listStub({ down: true });
    const models = await getLiveModels(env.KV, { openrouter: "k", openai: "k", anthropic: "k" });
    expect(models).toHaveLength(29);
    expect(models.some((m) => m.livePricing)).toBe(true);
  });
});

describe("POST /api/ai/generate-theme effort", () => {
  it("rejects an invalid effort with 400", async () => {
    stub = listStub();
    const shopId = await seedShop("Effort Validation Shop");
    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", effort: "extreme" },
    });
    expect(res.status).toBe(400);
  });

  it("forwards a valid effort to OpenRouter as reasoning.effort", async () => {
    const shopId = await seedShop("Effort Forwarding Shop");
    let captured: Record<string, unknown> | null = null;

    const theme = {
      primaryColor: "#1A1A1A",
      accentColor: "#C9A84C",
      fontHeading: "Playfair Display",
      fontBody: "DM Sans",
      tagline: "t",
      heroHeadline: "h",
      heroSubheadline: "s",
      shortDescription: "d",
      ctaText: "Book now",
      aestheticKeywords: ["luxury"],
      servicesIntro: "i",
      trustStatement: "trust",
      urgencyText: "u",
    };

    stub = compose(listStub(), (url, init) => {
      if (url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(theme) } }] }));
      }
      return null;
    });

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", effort: "high", regenerate: true },
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("anthropic/claude-sonnet-5");
    expect(captured!.reasoning).toEqual({ effort: "high" });
    // Effort raises the completion budget so reasoning doesn't starve output.
    expect(captured!.max_tokens).toBe(8192);
  });
});
