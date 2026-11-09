/**
 * A till sale's QR Checkout can still be paid after the cashier voided the
 * sale. Void means the sale never happened, so that payment is owed back in
 * full: the webhook records the debt BEFORE calling Stripe, refunds it once
 * (a retry after a failure finishes the same refund), and charge.refunded
 * only completes that record. The sale stays voided and out of the books. A
 * sale that was really paid, or a till refund in flight, is never refunded
 * by this path. Till Checkout pages also lapse after 31 minutes, not 24 hours.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { seedProduct, seedService, seedShop, seedStaff, tokenFor } from "./helpers";

const SECRET = "whsec_test";
const encoder = new TextEncoder();

async function postEvent(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": `t=${t},v1=${hex}`, "Content-Type": "application/json" },
    body: event,
  });
}

const evtId = () => `evt_vsp_${crypto.randomUUID().slice(0, 12)}`;
const STRIPE_URLS = { success_url: "https://shop.test/done", cancel_url: "https://shop.test/cancel" };

interface Till {
  shop: string;
  staff: string;
  service: string;
  product: string;
  token: string;
}

/** Service 2500 + product×2 at 1000 = 4500 pence; stock 5. */
async function setup(): Promise<Till> {
  const shop = await seedShop("Voided Sale Shop");
  await env.DB.prepare(
    "UPDATE shops SET stripe_connect_account_id = 'acct_vsp1', commission_rate = 0.10, retail_commission_rate = 0.20 WHERE id = ?"
  )
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop);
  const product = await seedProduct(shop, { retailPence: 1000, costPence: 300, stock: 5 });
  return { shop, staff, service, product, token: await tokenFor("admin", shop) };
}

async function ringStripe(t: Till): Promise<string> {
  const res = await dispatch("POST", `/booking/shops/${t.shop}/sales`, {
    headers: { Authorization: `Bearer ${t.token}` },
    body: {
      tender: "stripe",
      ...STRIPE_URLS,
      items: [
        { type: "service", serviceId: t.service, quantity: 1, staffId: t.staff },
        { type: "product", productId: t.product, quantity: 2, staffId: t.staff },
      ],
    },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sale: { id: string } }).sale.id;
}

async function voidSale(t: Till, saleId: string) {
  const res = await dispatch("POST", `/booking/shops/${t.shop}/sales/${saleId}/void`, {
    headers: { Authorization: `Bearer ${t.token}` },
    body: {},
  });
  expect(res.status).toBe(200);
}

function paid(t: Till, saleId: string, piId: string, id = evtId()) {
  return postEvent({
    id,
    type: "payment_intent.succeeded",
    data: { object: { id: piId, metadata: { saleId, shopId: t.shop, type: "sale" } } },
  });
}

async function saleRow(id: string) {
  return env.DB.prepare("SELECT status, refunded_pence, stripe_payment_intent_id FROM sales WHERE id = ?")
    .bind(id)
    .first<{ status: string; refunded_pence: number; stripe_payment_intent_id: string | null }>();
}

async function refundTxs(saleId: string) {
  const rows = await env.DB.prepare(
    "SELECT amount_pence, status, stripe_id FROM bw_transactions WHERE sale_id = ? AND type = 'refund'"
  )
    .bind(saleId)
    .all<{ amount_pence: number; status: string; stripe_id: string | null }>();
  return rows.results ?? [];
}

async function stockQty(t: Till): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL"
  )
    .bind(t.shop, t.product)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

/** Records Stripe calls ("METHOD /path"); `answer` may reply in Stripe's place. */
function spyStripe(answer: (url: string, init?: RequestInit) => Response | null = () => null) {
  const calls: Array<{ call: string; body: string }> = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.stripe.com/")) {
      calls.push({ call: `${init?.method ?? "GET"} ${new URL(url).pathname}`, body: String(init?.body ?? "") });
      const forced = answer(url, init);
      if (forced) return forced;
    }
    return real(input, init);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a payment that lands on a voided till sale", () => {
  it("is refunded in full, and the sale stays voided and out of the books", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    await voidSale(t, saleId);
    expect(await stockQty(t)).toBe(5);

    const piId = `pi_vsp_${saleId.slice(0, 8)}`;
    expect((await paid(t, saleId, piId)).status).toBe(200);
    expect(await saleRow(saleId)).toEqual({ status: "voided", refunded_pence: 0, stripe_payment_intent_id: piId });
    expect(await refundTxs(saleId)).toEqual([
      { amount_pence: 4500, status: "pending", stripe_id: `re_idem_void-refund:${saleId}` },
    ]);
    expect(await stockQty(t)).toBe(5);

    // charge.refunded completes the record and books nothing else.
    const done = await postEvent({
      id: evtId(),
      type: "charge.refunded",
      data: { object: { payment_intent: piId, amount: 4500, amount_refunded: 4500 } },
    });
    expect(done.status).toBe(200);
    expect(await saleRow(saleId)).toEqual({ status: "voided", refunded_pence: 0, stripe_payment_intent_id: piId });
    expect(await refundTxs(saleId)).toEqual([
      { amount_pence: 4500, status: "completed", stripe_id: `re_idem_void-refund:${saleId}` },
    ]);
    const ledger = await env.DB.prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(saleId)
      .all<{ status: string }>();
    expect((ledger.results ?? []).map((r) => r.status)).toEqual(["voided"]);
  });

  it("records the owed refund in the webhook entry with booleans only", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    await voidSale(t, saleId);
    const piId = `pi_vsp_${saleId.slice(0, 8)}`;
    expect((await paid(t, saleId, piId)).status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT details_json, changes_json FROM audit_log
        WHERE action = 'payment.stripe.webhook' AND entity_id = ? AND phase = 'outcome'`
    )
      .bind(saleId)
      .first<{ details_json: string; changes_json: string | null }>();
    expect(JSON.parse(String(row?.details_json))).toMatchObject({ sale_refund_owed: true, sale_refunded: true });
    expect(String(row?.details_json)).not.toContain(piId);
    expect(row?.changes_json).toBeNull();
  });

  it("a Stripe outage answers 500, keeps the record, and Stripe's retry finishes the same refund", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    await voidSale(t, saleId);
    const piId = `pi_vsp_${saleId.slice(0, 8)}`;
    const event = evtId();
    let down = true;
    spyStripe((url) =>
      down && url.endsWith("/v1/refunds")
        ? Response.json({ error: { message: "stripe down" } }, { status: 500 })
        : null
    );
    expect((await paid(t, saleId, piId, event)).status).toBe(500);
    expect(await refundTxs(saleId)).toEqual([{ amount_pence: 4500, status: "pending", stripe_id: null }]);
    // The failed entry still names the sale and its shop.
    const failed = await env.DB.prepare(
      `SELECT shop_id, entity_id, outcome, details_json FROM audit_log
        WHERE action = 'payment.stripe.webhook' AND phase = 'outcome' AND outcome = 'failed'
          AND details_json LIKE '%sale_refund_owed%'`
    ).all<{ shop_id: string | null; entity_id: string | null; outcome: string; details_json: string }>();
    expect(failed.results?.length, "no failed webhook entry for the refund outage").toBe(1);
    expect(failed.results![0]).toMatchObject({ shop_id: t.shop, entity_id: saleId, outcome: "failed" });
    expect(JSON.parse(failed.results![0]!.details_json)).toMatchObject({ sale_refund_owed: true });
    down = false;
    expect((await paid(t, saleId, piId, event)).status).toBe(200);
    expect(await refundTxs(saleId)).toEqual([
      { amount_pence: 4500, status: "pending", stripe_id: `re_idem_void-refund:${saleId}` },
    ]);
  });

  it("treats a charge Stripe says is already refunded as done", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    await voidSale(t, saleId);
    spyStripe((url) =>
      url.endsWith("/v1/refunds")
        ? Response.json(
            { error: { code: "charge_already_refunded", message: "Charge ch_1 has already been refunded." } },
            { status: 400 }
          )
        : null
    );
    expect((await paid(t, saleId, `pi_vsp_${saleId.slice(0, 8)}`)).status).toBe(200);
    expect((await refundTxs(saleId)).length).toBe(1);
  });

  it("never refunds a sale that was really paid, even when the event is delivered again", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    const piId = `pi_ok_${saleId.slice(0, 8)}`;
    expect((await paid(t, saleId, piId)).status).toBe(200);
    expect((await saleRow(saleId))?.status).toBe("completed");
    const calls = spyStripe();
    expect((await paid(t, saleId, piId)).status).toBe(200);
    expect((await saleRow(saleId))?.status).toBe("completed");
    expect(await refundTxs(saleId)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("never mistakes a till refund in flight for an owed void refund", async () => {
    const t = await setup();
    const saleId = await ringStripe(t);
    const piId = `pi_ok_${saleId.slice(0, 8)}`;
    expect((await paid(t, saleId, piId)).status).toBe(200);
    // The shape a till refund has between its record and Stripe's answer.
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, sale_id, shop_id, type, amount_pence, status, stripe_id)
       VALUES (?, NULL, ?, ?, 'refund', 1000, 'pending', NULL)`
    )
      .bind(crypto.randomUUID(), saleId, t.shop)
      .run();
    const calls = spyStripe();
    expect((await paid(t, saleId, piId)).status).toBe(200);
    expect(calls).toEqual([]);
    expect(await refundTxs(saleId)).toEqual([{ amount_pence: 1000, status: "pending", stripe_id: null }]);
  });
});

describe("till Checkout pages", () => {
  it("lapse after 31 minutes instead of Stripe's 24-hour default", async () => {
    const t = await setup();
    const calls = spyStripe();
    const before = Math.floor(Date.now() / 1000);
    await ringStripe(t);
    const create = calls.find((c) => c.call === "POST /v1/checkout/sessions");
    expect(create, "no Checkout Session was created").toBeDefined();
    const expiresAt = Number(new URLSearchParams(create!.body).get("expires_at"));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 31 * 60);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 31 * 60);
  });
});
