/** Audit trail Plan 2, Task 7: shop create / update / settings, generation
 *  prefs, reviews and the site image edits record their entry. */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff } from "./helpers";
import { adminToken, devToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

/** The full audit_log rows one request wrote, oldest first. */
async function rowsForRequest(requestId: string, action: string): Promise<Record<string, unknown>[]> {
  expect(requestId).toMatch(/.+/);
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? AND action = ? ORDER BY occurred_at, rowid")
    .bind(requestId, action)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

async function devHeaders(): Promise<Record<string, string>> {
  return authHeaders((await devToken()).token);
}

/** Run `fn` with the Stripe key removed, which is the legacy invite flow. */
async function withoutStripe<T>(fn: () => Promise<T>): Promise<T> {
  const e = env as unknown as Record<string, unknown>;
  const saved = e.STRIPE_SECRET_KEY;
  delete e.STRIPE_SECRET_KEY;
  try {
    return await fn();
  } finally {
    e.STRIPE_SECRET_KEY = saved;
  }
}

describe("shop create", () => {
  const name = "Quillfeather Barbers";
  const ownerEmail = "owner-quill@sole-trader.test";

  it("shop create records the subject ref, never the name or slug", async () => {
    const headers = await devHeaders();
    const res = await withoutStripe(() =>
      dispatch("POST", "/api/shops", { headers, body: { name, owner_email: ownerEmail, type: "barber_shop", plan: "pro" } }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const { shop, invite_token } = ((await res.json()) as { data: { shop: { id: string; slug: string }; invite_token: string } }).data;

    const rows = await rowsForRequest(rid(res), "shop.create");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.entity_type).toBe("shop");
    expect(outcome.entity_id).toBe(shop.id);
    expect(outcome.shop_id).toBe(shop.id);
    expect(JSON.parse(outcome.details_json as string)).toEqual({
      shop_subject: `subj_shop_${shop.id}`,
      flow: "invite",
      type: "barber_shop",
      plan: null,
      plan_custom: true,
    });
    expect(rows[0]!.details_json).toBeNull();
    for (const row of rows) expectNoPersonalData(row, [name, shop.slug, ownerEmail, invite_token]);

    const subject = await env.DB.prepare("SELECT display_name, kind, shop_id FROM audit_subjects WHERE id = ?")
      .bind(`subj_shop_${shop.id}`)
      .first<{ display_name: string; kind: string; shop_id: string }>();
    expect(subject).toEqual({ display_name: `${name} (${shop.slug})`, kind: "shop", shop_id: shop.id });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop create through Stripe checkout records flow stripe", async () => {
    const headers = await devHeaders();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.stripe.com")) {
        return Response.json({ id: "cs_test_audit", object: "checkout.session", url: "https://checkout.stripe.test/cs_test_audit" });
      }
      throw new Error(`unexpected outbound fetch ${url}`);
    });
    const res = await dispatch("POST", "/api/shops", { headers, body: { name: "Stripe Flow Salon", owner_email: "stripe-flow@sole-trader.test" } });
    expect(res.status, await res.clone().text()).toBe(201);
    const { shop, checkout_url } = ((await res.json()) as { data: { shop: { id: string; slug: string }; checkout_url: string } }).data;
    expect(fetchSpy).toHaveBeenCalled();
    const rows = await rowsForRequest(rid(res), "shop.create");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(rows[1]!.outcome).toBe("succeeded");
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({
      shop_subject: `subj_shop_${shop.id}`,
      flow: "stripe",
      type: "beauty_parlor",
      plan: "standard",
    });
    const subject = await env.DB.prepare("SELECT display_name, kind, shop_id FROM audit_subjects WHERE id = ?")
      .bind(`subj_shop_${shop.id}`)
      .first<{ display_name: string; kind: string; shop_id: string }>();
    expect(subject).toEqual({ display_name: `Stripe Flow Salon (${shop.slug})`, kind: "shop", shop_id: shop.id });
    for (const row of rows) expectNoPersonalData(row, ["Stripe Flow Salon", shop.slug, "stripe-flow@sole-trader.test", checkout_url, "cs_test_audit"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop create creates nothing when the started entry cannot be written", async () => {
    const headers = await devHeaders();
    const email = "nothing-left@sole-trader.test";
    const res = await withAuditOff(() =>
      withoutStripe(() => dispatch("POST", "/api/shops", { headers, body: { name: "Nothing Left Cuts", owner_email: email } })),
    );
    expect(res.status).toBe(503);
    const shop = await env.DB.prepare("SELECT COUNT(*) AS n FROM shops WHERE owner_email = ?").bind(email).first<{ n: number }>();
    expect(shop!.n).toBe(0);
    const invite = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE email = ?").bind(email).first<{ n: number }>();
    expect(invite!.n).toBe(0);
    const subj = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_subjects WHERE kind = ? AND display_name LIKE ?")
      .bind("shop", "Nothing Left Cuts%")
      .first<{ n: number }>();
    expect(subj!.n).toBe(0);
  });

  async function allRowsFor(requestId: string): Promise<Record<string, unknown>[]> {
    expect(requestId).toMatch(/.+/);
    const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY rowid").bind(requestId).all<Record<string, unknown>>();
    return r.results ?? [];
  }

  it("shop create with a bogus type string or object records the value in no row", async () => {
    const headers = await devHeaders();
    for (const [i, bogus] of (["bogus-type-ZQX <b>", { evil: "bogus-object-ZQX" }] as unknown[]).entries()) {
      const res = await withoutStripe(() =>
        dispatch("POST", "/api/shops", { headers, body: { name: `Bogus Type ${i} Cuts`, owner_email: `bogus${i}@sole-trader.test`, type: bogus } }),
      );
      expect(res.status, await res.clone().text()).toBe(500);
      const rows = await allRowsFor(rid(res));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expectNoPersonalData(row, ["bogus-type-ZQX", "bogus-object-ZQX", "evil"]);
    }
  });

  it("shop create with a custom plan records plan_custom, never the value", async () => {
    const headers = await devHeaders();
    const res = await withoutStripe(() =>
      dispatch("POST", "/api/shops", { headers, body: { name: "Custom Plan Cuts", owner_email: "plan@sole-trader.test", type: "both", plan: "Platinum-Secret-Tier" } }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = await allRowsFor(rid(res));
    for (const row of rows) expectNoPersonalData(row, ["Platinum-Secret-Tier"]);
    expect(JSON.parse(rows[rows.length - 1]!.details_json as string)).toMatchObject({ type: "both", plan: null, plan_custom: true });
  });
});

describe("shop update", () => {
  it("shop update by a developer records commission before and after", async () => {
    const shopId = await seedShop("Audit Commission Shop");
    const before = await env.DB.prepare("SELECT commission_rate FROM shops WHERE id = ?").bind(shopId).first<{ commission_rate: number }>();
    const headers = await devHeaders();
    const res = await dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { commission_rate: 0.15 } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "shop.update", shopId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("shop");
    expect(entry!.entity_id).toBe(shopId);
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ commission_rate: [before!.commission_rate, 0.15] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["commission_rate"] });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop rename records the field name only", async () => {
    const oldName = "Hollowbrook Hair Studio";
    const newName = "Marigold Pennyworth Cuts";
    const phone = "07700 900123";
    const shopId = await seedShop(oldName);
    const { token } = await adminToken(shopId);
    const res = await dispatch("PATCH", `/api/shops/${shopId}`, { headers: authHeaders(token), body: { name: newName, phone } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "shop.update", shopId });
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["name", "phone"] });
    const full = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(entry!.id as string).first<Record<string, unknown>>();
    expectNoPersonalData(full!, [oldName, newName, phone]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop update with no applicable field still records an empty entry", async () => {
    const shopId = await seedShop("Audit Empty Patch Shop");
    const headers = await devHeaders();
    const res = await dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { unknown_field: 1 } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "shop.update", shopId });
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: [] });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop update with an odd is_active names the field only; a boolean true on an active shop records no change", async () => {
    const shopId = await seedShop("Audit IsActive Shop");
    const headers = await devHeaders();
    const cur = await env.DB.prepare("SELECT is_active FROM shops WHERE id = ?").bind(shopId).first<{ is_active: number }>();
    expect(cur!.is_active).toBe(1);
    const res = await dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { is_active: true } });
    expect(res.status).toBe(200);
    const res2 = await dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { is_active: "some-odd-text-ZQX" } });
    const rows = await env.DB.prepare("SELECT * FROM audit_log WHERE action = ? AND shop_id = ? ORDER BY rowid").bind("shop.update", shopId).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]!.changes_json).toBeNull();
    expect(JSON.parse(rows.results[0]!.details_json as string)).toEqual({ fields: [] });
    expect(rows.results[1]!.changes_json).toBeNull();
    expect(JSON.parse(rows.results[1]!.details_json as string)).toEqual({ fields: ["is_active"] });
    for (const row of rows.results) expectNoPersonalData(row, ["some-odd-text-ZQX"]);
    expect(res2.status).toBeLessThan(600);
  });

  it("shop update with an unchanged value records no false change", async () => {
    const shopId = await seedShop("Audit Same Value Shop");
    const cur = await env.DB.prepare("SELECT commission_rate FROM shops WHERE id = ?").bind(shopId).first<{ commission_rate: number }>();
    const headers = await devHeaders();
    const res = await dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { commission_rate: cur!.commission_rate } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "shop.update", shopId });
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: [] });
  });

  it("shop update for a shop that does not exist answers as before and records a refusal", async () => {
    const headers = await devHeaders();
    const missing = `missing-${crypto.randomUUID()}`;
    const res = await dispatch("PATCH", `/api/shops/${missing}`, { headers, body: { is_active: 1 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toBeNull();
    const rows = await rowsForRequest(rid(res), "shop.update");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("refused");
    expect(rows[0]!.reason).toBe("shop_not_found");
    expect(rows[0]!.shop_id).toBeNull();
    expectNoPersonalData(rows[0]!, [missing]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("shop update changes nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Update Off Shop");
    const headers = await devHeaders();
    const res = await withAuditOff(() => dispatch("PATCH", `/api/shops/${shopId}`, { headers, body: { commission_rate: 0.5 } }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT commission_rate FROM shops WHERE id = ?").bind(shopId).first<{ commission_rate: number }>();
    expect(row!.commission_rate).not.toBe(0.5);
  });
});

describe("shop settings patch", () => {
  it("settings patch records deposit policy before and after and drops the address", async () => {
    const shopId = await seedShop("Audit Settings Shop");
    const { token } = await adminToken(shopId);
    const headers = authHeaders(token);
    const first = await dispatch("PATCH", `/api/shops/${shopId}/settings`, {
      headers,
      body: { deposits_enabled: 1, deposit_percent: 50 },
    });
    expect(first.status).toBe(200);
    const [created] = await entriesFor({ action: "shop.settings.update", shopId });
    expect(created!.entity_type).toBe("shop_setting");
    expect(created!.entity_id).toBe(shopId);
    expect(created!.phase).toBe("done");
    expect(JSON.parse(created!.changes_json as string)).toEqual({ deposits_enabled: [null, 1], deposit_percent: [null, 50] });

    const address = "12 Hidden Lane, Testville";
    const phone = "07700 900456";
    const second = await dispatch("PATCH", `/api/shops/${shopId}/settings`, {
      headers,
      body: { deposit_percent: 30, address, phone },
    });
    expect(second.status).toBe(200);
    const entries = await entriesFor({ action: "shop.settings.update", shopId });
    expect(entries).toHaveLength(2);
    const entry = entries[1]!;
    expect(entry.outcome).toBe("succeeded");
    expect(entry.phase).toBe("done");
    expect(JSON.parse(entry.changes_json as string)).toEqual({ deposit_percent: [50, 30] });
    expect(JSON.parse(entry.details_json as string)).toEqual({ fields: ["address", "deposit_percent", "phone"] });
    const full = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(entry.id as string).first<Record<string, unknown>>();
    expectNoPersonalData(full!, [address, phone]);
    expect(await gapRowsFor(rid(second))).toBe(0);
    const stored = await env.DB.prepare("SELECT deposit_percent, address FROM shop_settings WHERE shop_id = ?").bind(shopId).first<{ deposit_percent: number; address: string }>();
    expect(stored).toEqual({ deposit_percent: 30, address });
  });

  it("settings patch on a shop with no settings row is one batch", async () => {
    const shopId = await seedShop("Audit Settings Off Shop");
    const { token } = await adminToken(shopId);
    const res = await withAuditOff(() =>
      dispatch("PATCH", `/api/shops/${shopId}/settings`, { headers: authHeaders(token), body: { deposit_percent: 20 } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_settings WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe("generation prefs", () => {
  it("generation prefs record the choices and whether notes were set, never the notes", async () => {
    const shopId = await seedShop("Audit Prefs Shop");
    const headers = await devHeaders();
    const notes = "Warm candlelight, brass fixtures, hush-hush Penrose theme";
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers,
      body: { design_notes: notes, text_effort: "high" },
    });
    expect(res.status).toBe(200);
    const entries = await entriesFor({ action: "shop.settings.update", shopId });
    expect(entries.map((e) => e.phase)).toEqual(["started", "outcome"]);
    const entry = entries[1]!;
    expect(entry.outcome).toBe("succeeded");
    expect(entry.entity_type).toBe("generation_prefs");
    expect(entry.entity_id).toBe(shopId);
    expect(JSON.parse(entry.details_json as string)).toEqual({
      text_model: null,
      image_model: null,
      composer: null,
      text_effort: "high",
      design_notes_set: true,
    });
    for (const row of entries) expectNoPersonalData(row, [notes]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("generation prefs refuse before the KV write when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Prefs Off Shop");
    const headers = await devHeaders();
    const res = await withAuditOff(() => dispatch("POST", `/api/shops/${shopId}/settings`, { headers, body: { design_notes: "x" } }));
    expect(res.status).toBe(503);
    expect(await env.KV.get(`gen:settings:${shopId}`)).toBeNull();
  });
});

describe("review create", () => {
  async function seedVisit(shopId: string): Promise<string> {
    const staffId = await seedStaff(shopId);
    const serviceId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Trim', 30, 2000, 1)",
    )
      .bind(serviceId, shopId)
      .run();
    const id = crypto.randomUUID();
    const start = new Date(Date.now() - 48 * 3_600_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
         booking_date, start_time, end_time, status, amount_pence)
       VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, 'completed', 2000)`,
    )
      .bind(id, shopId, staffId, serviceId, start.toISOString().slice(0, 10), start.toISOString(), end.toISOString())
      .run();
    return id;
  }

  it("review create records rating and booking only", async () => {
    const shopId = await seedShop("Audit Review Shop");
    const bookingId = await seedVisit(shopId);
    const reviewer = "Bartholomew Wigglesworth";
    const text = "Splendid trim, the barber remembered my dog's name Pickles.";
    const res = await dispatch("POST", `/api/shops/${shopId}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.77" },
      body: { customer_name: reviewer, rating: 5, body: text, booking_id: bookingId },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;
    const rows = await rowsForRequest(rid(res), "review.create");
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.phase).toBe("done");
    expect(entry.outcome).toBe("succeeded");
    expect(entry.entity_type).toBe("review");
    expect(entry.entity_id).toBe(id);
    expect(entry.shop_id).toBe(shopId);
    expect(entry.actor_type).toBe("anonymous");
    expect(entry.actor_ref).toBeNull();
    expect(entry.ip_ref).toMatch(/^subj_ip_/);
    expect(JSON.parse(entry.changes_json as string)).toEqual({ rating: [null, 5] });
    expect(JSON.parse(entry.details_json as string)).toEqual({ booking_id: bookingId });
    expectNoPersonalData(entry, [reviewer, text, "Pickles", "203.0.113.77"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("review create stores nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Review Off Shop");
    const bookingId = await seedVisit(shopId);
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/reviews`, {
        body: { customer_name: "Nobody", rating: 4, body: "Fine.", booking_id: bookingId },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("site images", () => {
  const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

  function mockOpenRouter() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("openrouter.ai")) {
        return Response.json({ choices: [{ message: { images: [{ image_url: { url: PNG_DATA_URL } }] } }] });
      }
      throw new Error(`unexpected outbound fetch ${url}`);
    });
  }

  it("generate-image records the site edit around an inner ai.call, never the prompt", async () => {
    const shopId = await seedShop("Audit Gen Image Shop");
    const headers = await devHeaders();
    const notes = "secret moodboard: velvet curtains and neon";
    const fetchSpy = mockOpenRouter();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, { headers, body: { type: "hero", design_notes: notes } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const edits = await rowsForRequest(rid(res), "site.edit");
    expect(edits.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(edits[1]!.outcome).toBe("succeeded");
    expect(edits[1]!.entity_type).toBe("shop_site");
    expect(edits[1]!.entity_id).toBe(shopId);
    expect(edits[1]!.shop_id).toBe(shopId);
    expect(JSON.parse(edits[1]!.details_json as string)).toEqual({
      op: "generate",
      visual: "hero",
      image_model: "google/gemini-3.1-flash-image",
    });

    const calls = await rowsForRequest(rid(res), "ai.call");
    expect(calls.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(calls[1]!.outcome).toBe("succeeded");
    expect(JSON.parse(calls[1]!.details_json as string)).toEqual({
      purpose: "image",
      model: "google/gemini-3.1-flash-image",
      visual: "hero",
    });
    // the outer started entry precedes the inner started entry
    const order = (await env.DB.prepare("SELECT action, phase FROM audit_log WHERE request_id = ? ORDER BY rowid").bind(rid(res)).all<{ action: string; phase: string }>()).results;
    expect(order.map((r) => `${r.action}:${r.phase}`)).toEqual([
      "site.edit:started",
      "ai.call:started",
      "ai.call:outcome",
      "site.edit:outcome",
    ]);
    const shopRow = await env.DB.prepare("SELECT name, slug FROM shops WHERE id = ?").bind(shopId).first<{ name: string; slug: string }>();
    for (const row of [...edits, ...calls]) expectNoPersonalData(row, [notes, "velvet curtains", shopRow!.name, shopRow!.slug]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("generate-image records a failed ai.call and a failed site edit when the model errors", async () => {
    const shopId = await seedShop("Audit Gen Image Fail Shop");
    const headers = await devHeaders();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("model said: leaked secret", { status: 500 }));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, { headers, body: { type: "logo" } });
    expect(res.status).toBe(500);
    const calls = await rowsForRequest(rid(res), "ai.call");
    expect(calls.map((r) => [r.phase, r.outcome])).toEqual([["started", null], ["outcome", "failed"]]);
    const edits = await rowsForRequest(rid(res), "site.edit");
    expect(edits.map((r) => [r.phase, r.outcome])).toEqual([["started", null], ["outcome", "failed"]]);
    for (const row of [...calls, ...edits]) expectNoPersonalData(row, ["leaked secret"]);
  });

  it("generate-image refuses before calling the image model when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Gen Image Off Shop");
    const headers = await devHeaders();
    const fetchSpy = mockOpenRouter();
    const res = await withAuditOff(() => dispatch("POST", `/api/shops/${shopId}/generate-image`, { headers, body: { type: "hero" } }));
    expect(res.status).toBe(503);
    const openRouterCalls = fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes("openrouter"));
    expect(openRouterCalls).toHaveLength(0);
    const site = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(site!.n).toBe(0);
  });

  async function upload(shopId: string, token: string, type: string): Promise<Response> {
    const form = new FormData();
    form.set("type", type);
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "my-secret-photo.png", { type: "image/png" }));
    const ctx = createExecutionContext();
    const res = (await worker.fetch(
      new Request(`https://worker.test/api/shops/${shopId}/upload-image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }) as never,
      env as never,
      ctx as never,
    )) as unknown as Response;
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("upload-image records the visual and never the file name or key", async () => {
    const shopId = await seedShop("Audit Upload Shop");
    const { token } = await adminToken(shopId);
    const res = await upload(shopId, token, "logo");
    expect(res.status).toBe(200);
    const { imageUrl } = (await res.json()) as { imageUrl: string };
    const rows = await rowsForRequest(rid(res), "site.edit");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(rows[1]!.outcome).toBe("succeeded");
    expect(rows[1]!.entity_type).toBe("shop_site");
    expect(rows[1]!.entity_id).toBe(shopId);
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ op: "upload", visual: "logo" });
    const upSlug = (await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>())!.slug;
    for (const row of rows) expectNoPersonalData(row, [imageUrl, "my-secret-photo", "custom-logo", upSlug]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("upload-image refuses before the R2 write when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Upload Off Shop");
    const { token } = await adminToken(shopId);
    const before = await env.ASSETS.list({ prefix: "shops/" });
    const res = await withAuditOff(() => upload(shopId, token, "hero"));
    expect(res.status).toBe(503);
    const after = await env.ASSETS.list({ prefix: "shops/" });
    expect(after.objects.length).toBe(before.objects.length);
  });

  it("save-image and remove-image record the visual", async () => {
    const shopId = await seedShop("Audit Save Shop");
    const { token } = await devToken();
    const headers = authHeaders(token);
    const svcId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Colour', 60, 5000, 1)",
    )
      .bind(svcId, shopId)
      .run();
    const imageUrl = "https://assets.example.test/shops/some-secret-slug/custom-hero-abc12345.png";

    const saved = await dispatch("POST", `/api/shops/${shopId}/save-image`, { headers, body: { type: "hero", imageUrl } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const saveRows = await rowsForRequest(rid(saved), "site.edit");
    expect(saveRows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(saveRows[1]!.outcome).toBe("succeeded");
    expect(saveRows[1]!.entity_type).toBe("shop_site");
    expect(saveRows[1]!.entity_id).toBe(shopId);
    expect(JSON.parse(saveRows[1]!.details_json as string)).toEqual({ op: "save", visual: "hero" });
    const saveSlug = (await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>())!.slug;
    for (const row of saveRows) expectNoPersonalData(row, [imageUrl, "some-secret-slug", saveSlug]);
    expect(await gapRowsFor(rid(saved))).toBe(0);

    const removed = await dispatch("POST", `/api/shops/${shopId}/remove-image`, { headers, body: { type: `service:${svcId}` } });
    expect(removed.status).toBe(200);
    const removeRows = await rowsForRequest(rid(removed), "site.edit");
    expect(removeRows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(removeRows[1]!.outcome).toBe("succeeded");
    expect(JSON.parse(removeRows[1]!.details_json as string)).toEqual({ op: "remove", visual: `service:${svcId}` });
    expect(await gapRowsFor(rid(removed))).toBe(0);
  });

  it("save-image refuses before persisting when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Save Off Shop");
    const headers = await devHeaders();
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/save-image`, { headers, body: { type: "hero", imageUrl: "https://assets.example.test/x.png" } }),
    );
    expect(res.status).toBe(503);
    const site = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(site!.n).toBe(0);
  });
});
