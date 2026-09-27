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
    // Ruling 20: heroHeadline/tagline never appear in changes_json at all.
    expect(e.changes_json as string).not.toMatch(/heroHeadline|tagline/);
    // Ruling 19: the server cannot know whether this client-supplied preview
    // was itself a fallback theme, so it must not claim `false`.
    // Ruling 20: going from no stored theme to this one is a copy change.
    expect(JSON.parse(e.details_json as string)).toMatchObject({ fallback: null, copy_changed: true });
  });

  it("apply-theme's copy_changed reflects whether heroHeadline/tagline actually changed", async () => {
    const token = await dev();
    const shopId = await seedShop("Copy Changed Shop");
    const base = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "Original Tagline", heroHeadline: "Original Headline", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };

    await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme: base, model_id: "manual" } });
    const first = (await byAction("theme.apply")).filter((r) => r.shop_id === shopId).at(-1)!;
    expect(JSON.parse(first.details_json as string)).toMatchObject({ copy_changed: true }); // no theme -> this one

    const sameCopy = { ...base, primaryColor: "#333333" };
    await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme: sameCopy, model_id: "manual" } });
    const second = (await byAction("theme.apply")).filter((r) => r.shop_id === shopId).at(-1)!;
    expect(JSON.parse(second.details_json as string)).toMatchObject({ copy_changed: false }); // only colour changed

    const newCopy = { ...sameCopy, tagline: "New Tagline" };
    await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme: newCopy, model_id: "manual" } });
    const third = (await byAction("theme.apply")).filter((r) => r.shop_id === shopId).at(-1)!;
    expect(JSON.parse(third.details_json as string)).toMatchObject({ copy_changed: true }); // tagline changed
  });

  it("apply-theme logs null for a malformed font, keeping the raw value on the row", async () => {
    const token = await dev();
    const shopId = await seedShop("Malformed Font Shop");
    const base = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme: base, model_id: "manual" } });

    const badFont = { ...base, fontHeading: "Comic Sans <script>" };
    const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme: badFont, model_id: "manual" } });
    expect(res.status, await res.clone().text()).toBe(200);

    const row = await env.DB.prepare("SELECT ai_theme FROM shops WHERE id = ?").bind(shopId).first<{ ai_theme: string }>();
    expect(JSON.parse(row!.ai_theme).fontHeading).toBe("Comic Sans <script>"); // business data: unvalidated, unchanged

    const entries = (await byAction("theme.apply")).filter((r) => r.shop_id === shopId);
    const last = entries[entries.length - 1]!;
    expect(JSON.parse(last.changes_json as string).fontHeading).toEqual(["Playfair Display", null]);
  });

  it("apply-theme changes nothing (row, entry, KV) when the batch fails", async () => {
    const token = await dev();
    const shopId = await seedShop("Blocked Update Shop");
    const before = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    // Static, unscoped, no interpolation (constraints.md "never interpolate
    // input"); this file's tests run sequentially, so it can only affect the
    // one dispatch below, and is dropped in `finally` either way.
    await env.DB.prepare(
      "CREATE TRIGGER test_block_shop_theme_update BEFORE UPDATE ON shops BEGIN SELECT RAISE(ABORT, 'blocked for test'); END"
    ).run();
    try {
      const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: "manual" } });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_block_shop_theme_update").run();
    }
    const after = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    expect(after).toEqual(before);
    expect((await byAction("theme.apply")).find((r) => r.shop_id === shopId)).toBeUndefined();
    expect(await env.KV.get(`shop:theme:${shopId}`)).toBeNull();
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
    const shopName = "Fallback Shop";
    const shopId = await seedShop(shopName);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    const call = (await byAction("ai.call")).filter((r) => r.shop_id === shopId && r.phase === "outcome");
    expect(call).toHaveLength(1); // exactly one outcome row for this call
    expect(call[0]).toMatchObject({ outcome: "failed" });
    // errorReason(): `${err.name} (HTTP <status>)` for an LlmError carrying a status.
    expect(call[0]!.reason).toMatch(/\(HTTP 401\)$/);
    const applied = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(applied.details_json as string)).toMatchObject({ fallback: true });
    // Ruling 20: defaultTheme() puts the shop name in heroHeadline etc., but
    // those fields never reach changes_json — only ai_model/colours/fonts do.
    expect(applied.changes_json as string).not.toContain(shopName);
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
