import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { AUDIT_REFUSED_MESSAGE } from "../src/audit/context";

async function dev() {
  const id = await seedUser("developer", null);
  return tokenFor(id, "developer", null);
}

const byAction = (action: string) =>
  env.DB.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY occurred_at")
    .bind(action)
    .all<Record<string, unknown>>()
    .then((r) => r.results ?? []);

afterEach(() => vi.restoreAllMocks());

describe("AI routes are audited", () => {
  it("chatbot-model records the old and new model", async () => {
    const token = await dev();
    const models = await dispatch("GET", "/api/ai/models", { headers: authHeaders(token) });
    const listed = ((await models.json()) as { data: { id: string; kind?: string }[] }).data.find((m) => !m.id.includes("image"))!;
    await dispatch("POST", "/api/ai/chatbot-model", { headers: authHeaders(token), body: { model_id: listed.id } });
    const outcome = (await byAction("ai.chatbot_model.set")).find((r) => r.phase === "outcome")!;
    expect(outcome.outcome).toBe("succeeded");
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ chatbot_model: [null, listed.id] });
  });

  it("apply-theme commits the theme and its entry together", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Shop");
    const before = await env.DB.prepare("SELECT ai_model FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string | null }>();
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: "openai-api/gpt-6-astra" } });
    expect(res.status, await res.clone().text()).toBe(200);
    const e = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(e.changes_json as string)).toMatchObject({
      ai_model: [before?.ai_model ?? null, "openai-api/gpt-6-astra"],
      primaryColor: [null, "#111111"],
    });
    // Ruling 19: the server cannot know whether this client-supplied preview
    // was itself a fallback theme, so it must not claim `false`.
    expect(JSON.parse(e.details_json as string)).toMatchObject({ fallback: null });
  });

  it("apply-theme records an unregistered-but-shape-valid model id as-is, in both the row and the entry", async () => {
    const token = await dev();
    const shopId = await seedShop("Unregistered Model Shop");
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: "z-ai/glm-5.2" } });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await env.DB.prepare("SELECT ai_model FROM shops WHERE id = ?").bind(shopId).first<{ ai_model: string }>();
    expect(row!.ai_model).toBe("z-ai/glm-5.2");
    const e = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(e.changes_json as string)).toMatchObject({ ai_model: [expect.anything(), "z-ai/glm-5.2"] });
  });

  it("apply-theme rejects a malformed model_id (400, no entry, no row change)", async () => {
    const token = await dev();
    const shopId = await seedShop("Malformed Model Shop");
    const before = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    for (const badId of ["<script>alert(1)</script>", "a".repeat(101)]) {
      const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: badId } });
      expect(res.status, `model_id=${badId}`).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
    expect((await byAction("theme.apply")).find((r) => r.shop_id === shopId)).toBeUndefined();
    const after = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    expect(after).toEqual(before);
  });

  it("generate-theme records ai.call as failed and flags the fallback theme", async () => {
    const token = await dev();
    const shopId = await seedShop("Fallback Shop");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    const call = (await byAction("ai.call")).filter((r) => r.shop_id === shopId && r.phase === "outcome");
    expect(call[0]).toMatchObject({ outcome: "failed" });
    const applied = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(applied.details_json as string)).toMatchObject({ fallback: true });
  });

  it("compare refuses (503) when the audit entry cannot be written", async () => {
    const token = await dev();
    const shopId = await seedShop("Compare Refused Shop");
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("POST", "/api/ai/compare", {
        headers: authHeaders(token),
        body: { shop_id: shopId, model_a_id: "anthropic/claude-sonnet-5", model_b_id: "openai-api/gpt-6-astra" },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
  });

  it("compare logs a registry-validated model id or null, never the raw client string", async () => {
    const token = await dev();
    const shopId = await seedShop("Compare Log Shop");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const res = await dispatch("POST", "/api/ai/compare", {
      headers: authHeaders(token),
      body: { shop_id: shopId, model_a_id: "anthropic/claude-sonnet-5", model_b_id: "z-ai/glm-5.2" },
    });
    expect(res.status).toBe(200);
    const entry = (await byAction("theme.compare")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(entry.details_json as string)).toEqual({ model_a: "anthropic/claude-sonnet-5", model_b: null });
  });
});
