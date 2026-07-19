/**
 * /api/ai/models must serve the shared-catalog models with LIVE OpenRouter
 * pricing when the catalogue is reachable, and the fallback snapshot when it
 * is not — and the theme generator must forward a validated reasoning effort
 * to OpenRouter (and reject garbage efforts with a 400).
 *
 * The worker is dispatched in-isolate (direct import), so stubbing
 * globalThis.fetch intercepts the handler's outbound OpenRouter calls.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

const MODELS_KV_KEY = "ai:models:openrouter:v2";
const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | null;
let stub: FetchStub | null = null;

beforeEach(async () => {
  await env.KV.delete(MODELS_KV_KEY);
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
  it("serves the curated list joined with live OpenRouter pricing", async () => {
    stub = (url) => {
      if (url.startsWith("https://openrouter.ai/api/v1/models")) {
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "anthropic/claude-sonnet-5",
                pricing: { prompt: "0.0000042", completion: "0.000021" },
                supported_parameters: ["reasoning", "max_tokens"],
              },
            ],
          })
        );
      }
      return null;
    };

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(18);

    const sonnet = body.data.find((m) => m.id === "anthropic/claude-sonnet-5")!;
    expect(sonnet.costPer1MInput).toBe(4.2); // live value, not the 2.00 fallback
    expect(sonnet.costPer1MOutput).toBe(21);
    expect(sonnet.livePricing).toBe(true);
    expect(sonnet.supportsEffort).toBe(true);

    // Models absent from the live payload keep their fallback pricing.
    const grok = body.data.find((m) => m.id === "x-ai/grok-4.5")!;
    expect(grok.livePricing).toBe(false);
    expect(grok.costPer1MInput).toBe(2);
  });

  it("serves the fallback snapshot when OpenRouter is unreachable", async () => {
    stub = (url) => {
      if (url.startsWith("https://openrouter.ai/")) {
        // Throw synchronously: the async fetch wrapper turns this into its own
        // rejection, which the handler awaits — a detached Promise.reject()
        // here would trip workerd's unhandled-rejection detector.
        throw new Error("network down");
      }
      return null;
    };

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(18);
    expect(body.data.every((m) => m.livePricing === false)).toBe(true);
    // Every entry still carries usable pricing and the pipe-able display fields.
    for (const m of body.data) {
      expect(typeof m.costPer1MInput).toBe("number");
      expect(typeof m.costPer1MOutput).toBe("number");
      expect(typeof m.providerLabel).toBe("string");
      expect(typeof m.supportsEffort).toBe("boolean");
    }
  });
});

describe("POST /api/ai/generate-theme effort", () => {
  it("rejects an invalid effort with 400", async () => {
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

    stub = (url, init) => {
      if (url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(
          Response.json({ choices: [{ message: { content: JSON.stringify(theme) } }] })
        );
      }
      return null;
    };

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: {
        shop_id: shopId,
        model_id: "anthropic/claude-sonnet-5",
        effort: "high",
        regenerate: true,
      },
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("anthropic/claude-sonnet-5");
    expect(captured!.reasoning).toEqual({ effort: "high" });
    // Effort raises the completion budget so reasoning doesn't starve output.
    expect(captured!.max_tokens).toBe(8192);
  });
});
