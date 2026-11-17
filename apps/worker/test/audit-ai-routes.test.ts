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

  it("chatbot-model records an effort change beside the model", async () => {
    const token = await dev();
    await dispatch("POST", "/api/ai/chatbot-model", { headers: authHeaders(token), body: { model_id: "openai-api/gpt-6-luna", effort: "low" } });
    await dispatch("POST", "/api/ai/chatbot-model", { headers: authHeaders(token), body: { model_id: "openai-api/gpt-6-luna" } });
    const outcomes = (await byAction("ai.chatbot_model.set")).filter((r) => r.phase === "outcome").slice(-2);
    expect(outcomes.map((r) => JSON.parse(r.changes_json as string))).toEqual([
      { chatbot_model: [expect.anything(), "openai-api/gpt-6-luna"], chatbot_effort: [null, "low"] },
      { chatbot_model: ["openai-api/gpt-6-luna", "openai-api/gpt-6-luna"], chatbot_effort: ["low", null] },
    ]);
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

  it("apply-theme rolls back the shops row when the entry write fails (discriminates atomic from sequential)", async () => {
    const token = await dev();
    const shopId = await seedShop("Blocked Insert Shop");
    const before = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    const theme = {
      primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    // Static, unscoped, no interpolation (constraints.md "never interpolate
    // input"). Aborts the audit_log INSERT specifically — a LATER statement
    // in persistShopTheme's batch than the shops UPDATE, so this can only
    // pass if the update (which DID run) is rolled back together with the
    // failed insert: a trigger on the UPDATE itself would abort statement 0
    // and pass even against non-atomic sequential code, proving nothing.
    // This file's tests run sequentially, so the trigger can only affect the
    // one dispatch below, and is dropped in `finally` either way.
    await env.DB.prepare(
      "CREATE TRIGGER test_block_theme_apply_insert BEFORE INSERT ON audit_log WHEN NEW.action = 'theme.apply' BEGIN SELECT RAISE(ABORT, 'blocked for test'); END"
    ).run();
    try {
      const res = await dispatch("POST", "/api/ai/apply-theme", { headers: authHeaders(token), body: { shop_id: shopId, theme, model_id: "manual" } });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER test_block_theme_apply_insert").run();
    }
    const after = await env.DB.prepare("SELECT ai_model, ai_theme FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ ai_model: string; ai_theme: string | null }>();
    expect(after).toEqual(before); // the UPDATE that DID execute was rolled back with the failed insert
    expect((await byAction("theme.apply")).find((r) => r.shop_id === shopId)).toBeUndefined();
    expect(await env.KV.get(`shop:theme:${shopId}`)).toBeNull();
  });

  it("generate-theme logs null for a model-produced non-hex colour", async () => {
    const token = await dev();
    const shopId = await seedShop("Non-Hex Colour Shop");
    const badColourTheme = {
      primaryColor: "cornflowerblue", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
      tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
      aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
    };
    // /generate-theme never runs validateBrandConfig — a model's raw JSON
    // output reaches persistShopTheme unvalidated, so the log-side shape
    // gate is the only thing standing between this and changes_json.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify(badColourTheme) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      })
    );
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status, await res.clone().text()).toBe(200);
    const applied = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(applied.changes_json as string).primaryColor).toEqual([null, null]);
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
        body: { shop_id: shopId, model_a_id: "anthropic/claude-sonnet-5.5", model_b_id: "openai-api/gpt-6-astra" },
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
      body: { shop_id: shopId, model_a_id: "anthropic/claude-sonnet-5.5", model_b_id: "z-ai/glm-5.2" },
    });
    expect(res.status).toBe(200);
    const entry = (await byAction("theme.compare")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(entry.details_json as string)).toEqual({ model_a: "anthropic/claude-sonnet-5.5", model_b: null });
  });
});

describe("theme generation cost log", () => {
  const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
  const THEME = {
    primaryColor: "#111111", accentColor: "#222222", fontHeading: "Playfair Display", fontBody: "DM Sans",
    tagline: "t", heroHeadline: "h", heroSubheadline: "s", shortDescription: "d", ctaText: "c",
    aestheticKeywords: [], servicesIntro: "i", trustStatement: "trust", urgencyText: "u",
  };

  /** Answers only the chat call, with a fresh Response each time; anything
   *  else (the model feed) gets a 404, so the registry uses its snapshot. */
  function mockChat(reply: () => Response) {
    const chatCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== CHAT_URL) return new Response("not found", { status: 404 });
      chatCalls.push(url);
      return reply();
    });
    return chatCalls;
  }

  const answer = (content: string, inTok: number, outTok: number) => () =>
    Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: inTok, completion_tokens: outTok } });

  const usageRows = (shopId: string) =>
    env.DB.prepare("SELECT * FROM ai_usage_log WHERE shop_id = ? ORDER BY created_at")
      .bind(shopId)
      .all<Record<string, unknown>>()
      .then((r) => r.results ?? []);

  const aiCalls = async (shopId: string) => (await byAction("ai.call")).filter((r) => r.shop_id === shopId);

  it("logs a generated theme's tokens under the request, beside its live ai.call", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Cost Shop");
    mockChat(answer(JSON.stringify(THEME), 120, 340));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = await usageRows(shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      worker_name: "pivot-parlor-api",
      model: "anthropic/claude-sonnet-5.5",
      usage_type: "theme",
      input_tokens: 120,
      output_tokens: 340,
      total_tokens: 460,
    });
    // The same id as the request and its ai.call, which is how the
    // historical import knows this row already has a live entry.
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    expect(rows[0]!.job_id).toBe(requestId);
    const calls = await aiCalls(shopId);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.request_id).toBe(requestId);
  });

  it("logs a preview too: it is billed even though nothing is saved", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Preview Cost Shop");
    mockChat(answer(JSON.stringify(THEME), 50, 60));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true, preview: true } });
    expect(res.status).toBe(200);
    expect((await usageRows(shopId)).map((r) => [r.input_tokens, r.output_tokens])).toEqual([[50, 60]]);
  });

  it("logs an empty reply's billed tokens, then falls back to the default theme as before", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Empty Reply Shop");
    const chatCalls = mockChat(answer("", 90, 150));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    expect(chatCalls).toHaveLength(1); // an empty reply is not retried
    const rows = await usageRows(shopId);
    expect(rows.map((r) => [r.usage_type, r.input_tokens, r.output_tokens])).toEqual([["theme", 90, 150]]);
    expect(rows[0]!.job_id).toBe(res.headers.get("X-Request-Id"));
    expect((await aiCalls(shopId)).find((r) => r.phase === "outcome")).toMatchObject({ outcome: "failed" });
    const applied = (await byAction("theme.apply")).find((r) => r.shop_id === shopId)!;
    expect(JSON.parse(applied.details_json as string)).toMatchObject({ fallback: true });
  });

  it("logs a reply that is not valid JSON: it was billed all the same", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Bad JSON Shop");
    mockChat(answer("Here is your theme, in words rather than JSON.", 30, 40));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    expect((await usageRows(shopId)).map((r) => [r.input_tokens, r.output_tokens])).toEqual([[30, 40]]);
    expect((await aiCalls(shopId)).find((r) => r.phase === "outcome")).toMatchObject({ outcome: "failed" });
  });

  it("logs nothing for a call the provider refused (not billed)", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Refused Shop");
    mockChat(() => new Response("unauthorized", { status: 401 }));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    expect(await usageRows(shopId)).toEqual([]);
  });

  it("logs nothing when the cached theme is served (no model call)", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Cached Shop");
    await env.KV.put(`shop:theme:${shopId}`, JSON.stringify(THEME));
    const chatCalls = mockChat(answer(JSON.stringify(THEME), 1, 1));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cached: true });
    expect(chatCalls).toHaveLength(0);
    expect(await usageRows(shopId)).toEqual([]);
  });

  it("compare logs one row per model, both under the one request", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Compare Cost Shop");
    mockChat(answer(JSON.stringify(THEME), 70, 80));
    const res = await dispatch("POST", "/api/ai/compare", {
      headers: authHeaders(token),
      body: { shop_id: shopId, model_a_id: "anthropic/claude-sonnet-5.5", model_b_id: "anthropic/claude-haiku-5.5" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = await usageRows(shopId);
    expect(rows.map((r) => r.model).sort()).toEqual(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"]);
    const requestId = res.headers.get("X-Request-Id");
    for (const r of rows) expect(r).toMatchObject({ worker_name: "pivot-parlor-api", usage_type: "theme", job_id: requestId });
  });

  it("the historical import never copies a theme row: it already has a live ai.call", async () => {
    const token = await dev();
    const shopId = await seedShop("Theme Import Shop");
    mockChat(answer(JSON.stringify(THEME), 120, 340));
    const res = await dispatch("POST", "/api/ai/generate-theme", { headers: authHeaders(token), body: { shop_id: shopId, regenerate: true } });
    expect(res.status).toBe(200);
    const [row] = await usageRows(shopId);
    expect(row).toBeDefined();
    // Control: an API-worker row with no live twin does import, so the check
    // below would fail if the import simply skipped this worker's rows.
    const control = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, cost_basis, job_id)
       VALUES (?, ?, 'pivot-parlor-api', 'anthropic/claude-sonnet-5.5', 'theme', 1, 1, 2, 0, NULL, ?)`
    ).bind(control, shopId, crypto.randomUUID()).run();
    const imported = await dispatch("POST", "/api/audit/import-historical", { headers: authHeaders(token) });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const hist = (id: unknown) =>
      env.DB.prepare("SELECT id FROM audit_log WHERE id = ?").bind(`hist_${String(id)}`).first();
    expect(await hist(control)).not.toBeNull();
    expect(await hist(row!.id)).toBeNull();
  });
});
