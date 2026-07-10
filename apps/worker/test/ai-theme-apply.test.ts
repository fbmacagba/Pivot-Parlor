/**
 * Theme preview/apply semantics:
 * - compare must NOT persist either side (persisting both made the slower
 *   model silently win the shop's stored theme);
 * - generate-theme preview:true must not persist; default still persists;
 * - an owner-chosen palette pair must win over the model's colour pick;
 * - /api/ai/apply-theme persists a previewed theme and rejects junk.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | null;
let stub: FetchStub | null = null;

const THEME = {
  primaryColor: "#111111",
  accentColor: "#222222",
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

function chatStub(): FetchStub {
  return (url) => {
    if (url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: JSON.stringify(THEME) } }] })
      );
    }
    return null;
  };
}

beforeEach(() => {
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

async function storedTheme(shopId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT ai_theme FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ ai_theme: string | null }>();
  return row?.ai_theme ?? null;
}

describe("theme preview/apply semantics", () => {
  it("compare never persists either side", async () => {
    stub = chatStub();
    const shopId = await seedShop("Compare No Persist Shop");

    const res = await dispatch("POST", "/api/ai/compare", {
      headers: authHeaders(await devToken()),
      body: {
        shop_id: shopId,
        model_a_id: "anthropic/claude-sonnet-5",
        model_b_id: "z-ai/glm-5.2",
      },
    });

    expect(res.status).toBe(200);
    expect(await storedTheme(shopId)).toBeNull();
  });

  it("generate-theme preview:true does not persist; default does", async () => {
    stub = chatStub();
    const shopId = await seedShop("Preview Persist Shop");
    const token = await devToken();

    const preview = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(token),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", regenerate: true, preview: true },
    });
    expect(preview.status).toBe(200);
    expect(await storedTheme(shopId)).toBeNull();

    const persisted = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(token),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", regenerate: true },
    });
    expect(persisted.status).toBe(200);
    expect(await storedTheme(shopId)).not.toBeNull();
  });

  it("an owner palette pair overrides the model's colours", async () => {
    stub = chatStub(); // model always answers #111111/#222222
    const shopId = await seedShop("Palette Override Shop");

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: {
        shop_id: shopId,
        model_id: "anthropic/claude-sonnet-5",
        regenerate: true,
        preview: true,
        color_primary: "#0D0D0D",
        color_accent: "#C9A84C",
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { primaryColor: string; accentColor: string } };
    expect(body.data.primaryColor).toBe("#0D0D0D");
    expect(body.data.accentColor).toBe("#C9A84C");
  });

  it("a partial palette pair is ignored", async () => {
    stub = chatStub();
    const shopId = await seedShop("Partial Palette Shop");

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: {
        shop_id: shopId,
        model_id: "anthropic/claude-sonnet-5",
        regenerate: true,
        preview: true,
        color_primary: "#0D0D0D", // accent missing -> pair not honoured
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { primaryColor: string } };
    expect(body.data.primaryColor).toBe("#111111"); // model's pick survives
  });

  it("apply-theme persists a previewed theme", async () => {
    const shopId = await seedShop("Apply Theme Shop");

    const res = await dispatch("POST", "/api/ai/apply-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "z-ai/glm-5.2", theme: THEME },
    });

    expect(res.status).toBe(200);
    const stored = await storedTheme(shopId);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).primaryColor).toBe("#111111");
    const kv = await env.KV.get(`shop:theme:${shopId}`);
    expect(kv).not.toBeNull();
  });

  it("apply-theme rejects an invalid theme", async () => {
    const shopId = await seedShop("Apply Invalid Shop");

    const res = await dispatch("POST", "/api/ai/apply-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, theme: { primaryColor: "red", tagline: "" } },
    });

    expect(res.status).toBe(400);
    expect(await storedTheme(shopId)).toBeNull();
  });
});
