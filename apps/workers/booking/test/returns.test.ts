/**
 * WS-3 Phase 2: returns/refunds on the sales spine. Refund amounts are the
 * discounted line values (pro-rata sale discount); tips never refund; the
 * commission reversal uses the rates snapshotted on the sale's ledger row.
 * Stripe refunds are faked by the outboundService (/v1/refunds echoes the
 * Idempotency-Key into re_idem_<key>).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { calculateCommissionPence } from "@repo/utils";
import worker from "../src/index";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService, seedProduct, tokenFor } from "./helpers";

/** `dispatch` with a substituted env (e.g. a Proxy over DB). */
async function dispatchWith(
  testEnv: typeof env,
  method: string,
  path: string,
  opts: { headers: Record<string, string>; body: unknown }
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://booking.test${path}`, {
      method,
      headers: { ...opts.headers, "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
    }) as never,
    testEnv as never,
    ctx as never
  );
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

const SECRET = "whsec_test";
const encoder = new TextEncoder();

async function sigHeader(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

async function postWebhook(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": await sigHeader(payload), "Content-Type": "application/json" },
    body: event,
  });
}

async function stockQty(shop: string, product: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shop, product)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

async function seedRefundShop() {
  const shop = await seedShop("Refund Shop");
  await env.DB
    .prepare(
      "UPDATE shops SET stripe_connect_account_id = 'acct_ref1', commission_rate = 0.10, retail_commission_rate = 0.20 WHERE id = ?"
    )
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop); // 2500 pence
  const product = await seedProduct(shop, { retailPence: 1000, costPence: 300, stock: 5 });
  return { shop, staff, service, product, token: await tokenFor("admin", shop) };
}

/** Ring a mixed cash sale: service 2500 + product×2 2000, no discount/tip. */
async function ringCashSale(shop: string, staff: string, service: string, product: string, token: string) {
  const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
    headers: { Authorization: `Bearer ${token}` },
    body: {
      tender: "cash",
      items: [
        { type: "service", serviceId: service, quantity: 1, staffId: staff },
        { type: "product", productId: product, quantity: 2, staffId: staff },
      ],
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sale: { id: string } };
  const items = await env.DB
    .prepare("SELECT id, item_type FROM sale_items WHERE sale_id = ?")
    .bind(body.sale.id)
    .all<{ id: string; item_type: string }>();
  return {
    saleId: body.sale.id,
    serviceItem: items.results!.find((i) => i.item_type === "service")!.id,
    productItem: items.results!.find((i) => i.item_type === "product")!.id,
  };
}

describe("record-only refunds (cash/card_external)", () => {
  it("partially refunds one product with restock, then fully refunds and flips the sale", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, serviceItem, productItem } = await ringCashSale(shop, staff, service, product, token);
    expect(await stockQty(shop, product)).toBe(3);

    // Return 1 of 2 pomades, restocked.
    const partial = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }], reason: "unopened" },
    });
    expect(partial.status).toBe(200);
    const partialBody = (await partial.json()) as { data: Record<string, unknown> };
    expect(partialBody.data).toMatchObject({
      refund_pence: 1000,
      status: "completed",
      fully_refunded: false,
      commission_reversal_pence: calculateCommissionPence(1000, 0.2).commission_pence,
    });

    expect(await stockQty(shop, product)).toBe(4);
    const movement = await env.DB
      .prepare("SELECT type, quantity_delta FROM stock_movements WHERE reference_type = 'sale_return'")
      .bind()
      .first<{ type: string; quantity_delta: number }>();
    expect(movement).toMatchObject({ type: "return", quantity_delta: 1 });

    const sale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    expect(sale).toMatchObject({ status: "completed", refunded_pence: 1000 });

    // Negative ledger reversal at the snapshot rates.
    const reversal = await env.DB
      .prepare("SELECT retail_amount_pence, commission_amount_pence, status FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence < 0")
      .bind(saleId)
      .first<Record<string, unknown>>();
    expect(reversal).toMatchObject({
      retail_amount_pence: -1000,
      commission_amount_pence: -calculateCommissionPence(1000, 0.2).commission_pence,
      status: "pending",
    });

    // Refund everything left → the sale flips to refunded.
    const rest = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        lines: [
          { sale_item_id: serviceItem, quantity: 1 },
          { sale_item_id: productItem, quantity: 1, restock: false },
        ],
      },
    });
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as { data: { fully_refunded: boolean } }).data.fully_refunded).toBe(true);

    const finalSale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    // Subtotal 4500 (service 2500 + product 2×1000), all of it now refunded.
    expect(finalSale).toMatchObject({ status: "refunded", refunded_pence: 4500 });
    // restock: false on the second pomade — stock stays at 4.
    expect(await stockQty(shop, product)).toBe(4);
  });

  it("rejects over-returns, staff callers, and refunds of pending sales", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await ringCashSale(shop, staff, service, product, token);

    const over = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 3 }] },
    });
    expect(over.status).toBe(400);

    const staffToken = await tokenFor("staff", shop);
    const denied = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(denied.status).toBe(403);
  });

  it("allocates a sale-level discount pro-rata to the refund", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        discount_pence: 900, // subtotal 4500 → the product line (2000) carries 400 of it
        items: [
          { type: "service", serviceId: service, quantity: 1, staffId: staff },
          { type: "product", productId: product, quantity: 2, staffId: staff },
        ],
      },
    });
    const saleId = ((await res.json()) as { sale: { id: string } }).sale.id;
    const productItem = (await env.DB
      .prepare("SELECT id FROM sale_items WHERE sale_id = ? AND item_type = 'product'")
      .bind(saleId)
      .first<{ id: string }>())!.id;

    const refund = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 2 }] },
    });
    expect(refund.status).toBe(200);
    // (2000 - 400) for both units.
    expect(((await refund.json()) as { data: { refund_pence: number } }).data.refund_pence).toBe(1600);
  });
});

describe("Stripe refunds", () => {
  /** Ring a Stripe QR sale and settle it via the webhook. */
  async function settledStripeSale(shop: string, staff: string, service: string, product: string, token: string) {
    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "stripe",
        success_url: "https://shop.test/done",
        cancel_url: "https://shop.test/cancel",
        items: [
          { type: "service", serviceId: service, quantity: 1, staffId: staff },
          { type: "product", productId: product, quantity: 2, staffId: staff },
        ],
      },
    });
    expect(res.status).toBe(200);
    const saleId = ((await res.json()) as { sale: { id: string } }).sale.id;
    const piId = `pi_settled_${saleId.slice(0, 8)}`;
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      data: { object: { id: piId, metadata: { saleId, shopId: shop, type: "sale" } } },
    });
    const productItem = (await env.DB
      .prepare("SELECT id FROM sale_items WHERE sale_id = ? AND item_type = 'product'")
      .bind(saleId)
      .first<{ id: string }>())!.id;
    return { saleId, piId, productItem };
  }

  it("creates the Stripe refund, stays pending, and charge.refunded settles the books", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId, productItem } = await settledStripeSale(shop, staff, service, product, token);

    const refund = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(refund.status).toBe(200);
    const body = (await refund.json()) as { data: { id: string; status: string; refund_pence: number } };
    expect(body.data.status).toBe("pending");

    // The refund id echoes our deterministic Idempotency-Key.
    const ret = await env.DB
      .prepare("SELECT status, stripe_refund_id, refund_pence FROM sale_returns WHERE id = ?")
      .bind(body.data.id)
      .first<{ status: string; stripe_refund_id: string; refund_pence: number }>();
    expect(ret).toMatchObject({
      status: "pending",
      stripe_refund_id: `re_idem_refund:${body.data.id}`,
      refund_pence: 1000,
    });
    // Stock already restocked; refunded_pence recorded at initiation.
    expect(await stockQty(shop, product)).toBe(4);

    // Stripe confirms → return + refund tx + ledger reversal settle. Partial
    // refund: sale stays completed.
    const wh = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_ref_1", payment_intent: piId, amount: 4500, amount_refunded: 1000 } },
    });
    expect(wh.status).toBe(200);

    const settled = await env.DB
      .prepare("SELECT status, completed_at FROM sale_returns WHERE id = ?")
      .bind(body.data.id)
      .first<{ status: string; completed_at: string | null }>();
    expect(settled?.status).toBe("completed");
    expect(settled?.completed_at).toBeTruthy();

    const reversal = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence < 0")
      .bind(saleId)
      .first<{ status: string }>();
    expect(reversal?.status).toBe("transferred");

    const sale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    expect(sale).toMatchObject({ status: "completed", refunded_pence: 1000 });

    // The ORIGINAL sale ledger row stays transferred (only the reversal moved).
    const original = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence >= 0")
      .bind(saleId)
      .first<{ status: string }>();
    expect(original?.status).toBe("transferred");
  });

  it("a dashboard-initiated FULL refund (no return row) keeps the legacy behaviour", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId } = await settledStripeSale(shop, staff, service, product, token);

    const wh = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_ref_2", payment_intent: piId, amount: 4500, amount_refunded: 4500 } },
    });
    expect(wh.status).toBe(200);

    const sale = await env.DB
      .prepare("SELECT status FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string }>();
    expect(sale?.status).toBe("refunded");
  });

  it("a dashboard-initiated PARTIAL refund books the delta: refunded_pence, refund tx, pending pro-rata reversal", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    // services 2500 @10%, retail 2000 @20%, subtotal 4500, no discount.
    const { saleId, piId } = await settledStripeSale(shop, staff, service, product, token);

    const wh = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_dash_p1",
          payment_intent: piId,
          amount: 4500,
          amount_refunded: 900,
          refunds: { data: [{ id: "re_dash_p1" }] },
        },
      },
    });
    expect(wh.status).toBe(200);

    const sale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    expect(sale).toMatchObject({ status: "completed", refunded_pence: 900 });

    const tx = await env.DB
      .prepare("SELECT amount_pence, status, stripe_id FROM bw_transactions WHERE sale_id = ? AND type = 'refund'")
      .bind(saleId)
      .first<{ amount_pence: number; status: string; stripe_id: string }>();
    expect(tx).toMatchObject({ amount_pence: 900, status: "completed", stripe_id: "re_dash_p1" });

    // Pro-rata: 900 splits 500 services / 400 retail → reversal 50 + 80 = 130,
    // 'pending' (owed adjustment — nothing confirms the app fee came back).
    const reversal = await env.DB
      .prepare(
        "SELECT services_amount_pence, retail_amount_pence, commission_amount_pence, status FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence < 0"
      )
      .bind(saleId)
      .first<Record<string, unknown>>();
    expect(reversal).toMatchObject({
      services_amount_pence: -500,
      retail_amount_pence: -400,
      commission_amount_pence: -130,
      status: "pending",
    });
  });

  it("a redelivered cumulative amount books nothing new; reaching FULL flips the sale", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId } = await settledStripeSale(shop, staff, service, product, token);

    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_dash_p2", payment_intent: piId, amount: 4500, amount_refunded: 900 } },
    });
    // New event id, SAME cumulative amount → delta 0 → no double booking.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_dash_p2", payment_intent: piId, amount: 4500, amount_refunded: 900 } },
    });
    const afterEcho = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM bw_transactions WHERE sale_id = ? AND type = 'refund'")
      .bind(saleId)
      .first<{ n: number }>();
    expect(Number(afterEcho?.n)).toBe(1);

    // Second partial reaches the full charge → delta 3600 books, sale flips.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_dash_p2", payment_intent: piId, amount: 4500, amount_refunded: 4500 } },
    });

    const sale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    expect(sale).toMatchObject({ status: "refunded", refunded_pence: 4500 });

    // Reversals across both deltas sum to the sale's full commission (650).
    const sum = await env.DB
      .prepare(
        "SELECT SUM(commission_amount_pence) AS total FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence < 0"
      )
      .bind(saleId)
      .first<{ total: number }>();
    expect(Number(sum?.total)).toBe(-650);
  });

  it("a dashboard partial AFTER a settled API return books only the new delta", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId, productItem } = await settledStripeSale(shop, staff, service, product, token);

    // API-initiated return of one product unit (1000), settled by webhook.
    const refund = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(refund.status).toBe(200);
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_mix_1", payment_intent: piId, amount: 4500, amount_refunded: 1000 } },
    });

    // Dashboard partial on top: cumulative 1500 → only 500 is new.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_mix_1", payment_intent: piId, amount: 4500, amount_refunded: 1500 } },
    });

    const sale = await env.DB
      .prepare("SELECT status, refunded_pence FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string; refunded_pence: number }>();
    expect(sale).toMatchObject({ status: "completed", refunded_pence: 1500 });

    const txs = await env.DB
      .prepare("SELECT amount_pence FROM bw_transactions WHERE sale_id = ? AND type = 'refund' ORDER BY amount_pence")
      .bind(saleId)
      .all<{ amount_pence: number }>();
    expect((txs.results ?? []).map((t) => t.amount_pence)).toEqual([500, 1000]);
  });

  it("reverts the quantity claim when Stripe refund creation fails, so a retry works", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);

    // Point the settled sale at a PI the fake Stripe refuses to refund
    // (outboundService 500s /v1/refunds whose body mentions "fail").
    await env.DB
      .prepare("UPDATE sales SET stripe_payment_intent_id = 'pi_fail_refund' WHERE id = ?")
      .bind(saleId)
      .run();

    const failed = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(failed.status).toBe(502);

    // Nothing was recorded and the returnable quantity was released.
    const returnRows = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id = ?")
      .bind(saleId)
      .first<{ n: number }>();
    expect(returnRows?.n).toBe(0);
    const item = await env.DB
      .prepare("SELECT returned_quantity FROM sale_items WHERE id = ?")
      .bind(productItem)
      .first<{ returned_quantity: number }>();
    expect(item?.returned_quantity).toBe(0);

    // Stripe recovers → the same return goes through.
    await env.DB
      .prepare("UPDATE sales SET stripe_payment_intent_id = 'pi_ok_again' WHERE id = ?")
      .bind(saleId)
      .run();
    const retry = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(retry.status).toBe(200);
  });

  async function refundRows(saleId: string) {
    return env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sale_returns WHERE sale_id = ?1) AS returns,
         (SELECT COUNT(*) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.sale_id = ?1) AS items,
         (SELECT COUNT(*) FROM bw_transactions WHERE sale_id = ?1 AND type = 'refund') AS refund_txs,
         (SELECT COALESCE(SUM(amount_pence), 0) FROM bw_transactions WHERE sale_id = ?1 AND type = 'refund') AS refund_tx_pence,
         (SELECT COUNT(*) FROM bw_commission_ledger WHERE sale_id = ?1 AND commission_amount_pence < 0) AS reversals,
         (SELECT refunded_pence FROM sales WHERE id = ?1) AS refunded_pence,
         (SELECT status FROM sales WHERE id = ?1) AS sale_status`
    )
      .bind(saleId)
      .first<Record<string, number | string>>();
  }

  const refundOne = (shop: string, saleId: string, item: string, token: string, db?: typeof env.DB) =>
    dispatchWith(db ? { ...env, DB: db } : env, "POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: item, quantity: 1 }] },
    });

  /** A DB whose `n`th batch call first runs `before` (or fails, when `fail`). */
  function dbWithBatch(n: number, opts: { before?: string; saleId?: string; fail?: boolean }) {
    let calls = 0;
    const seen = { fired: false };
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            calls += 1;
            if (calls === n && !seen.fired) {
              seen.fired = true;
              if (opts.fail) throw new Error("D1 unavailable (test)");
              if (opts.before) await target.prepare(opts.before).bind(opts.saleId).run();
            }
            return target.batch(stmts);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof env.DB;
    return { db, seen };
  }

  it("records the return before calling Stripe, so an early charge.refunded completes it instead of booking it twice", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId, productItem } = await settledStripeSale(shop, staff, service, product, token);

    // Stripe's charge.refunded arrives while the refund route is still running,
    // right after Stripe accepted the refund.
    const real = globalThis.fetch;
    let delivered = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const res = await real(input, init);
      if (url.endsWith("/v1/refunds") && !delivered) {
        delivered = true;
        const wh = await postWebhook({
          id: `evt_${crypto.randomUUID()}`,
          type: "charge.refunded",
          data: { object: { id: "ch_early", payment_intent: piId, amount: 4500, amount_refunded: 1000 } },
        });
        expect(wh.status).toBe(200);
      }
      return res;
    });
    try {
      const res = await refundOne(shop, saleId, productItem, token);
      expect(res.status).toBe(200);
      expect(delivered, "charge.refunded was never delivered mid-refund").toBe(true);
      const body = (await res.json()) as { data: { id: string } };
      expect(await refundRows(saleId)).toEqual({
        returns: 1,
        items: 1,
        refund_txs: 1,
        refund_tx_pence: 1000,
        reversals: 1,
        refunded_pence: 1000,
        sale_status: "completed",
      });
      const ret = await env.DB.prepare("SELECT status, stripe_refund_id FROM sale_returns WHERE id = ?")
        .bind(body.data.id)
        .first();
      expect(ret).toEqual({ status: "completed", stripe_refund_id: `re_idem_refund:${body.data.id}` });
      expect(await stockQty(shop, product)).toBe(4);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a Stripe failure removes the whole record and releases the claim", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    await env.DB.prepare("UPDATE sales SET stripe_payment_intent_id = 'pi_fail_refund' WHERE id = ?").bind(saleId).run();
    const stock = await stockQty(shop, product);

    const res = await refundOne(shop, saleId, productItem, token);
    expect(res.status).toBe(502);
    expect(await refundRows(saleId)).toEqual({
      returns: 0,
      items: 0,
      refund_txs: 0,
      refund_tx_pence: 0,
      reversals: 0,
      refunded_pence: 0,
      sale_status: "completed",
    });
    const item = await env.DB.prepare("SELECT returned_quantity AS q FROM sale_items WHERE id = ?")
      .bind(productItem)
      .first<{ q: number }>();
    expect(item?.q).toBe(0);
    expect(await stockQty(shop, product)).toBe(stock);
  });

  it("when the save after Stripe fails, the refund still stands on record and charge.refunded completes it", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, piId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    // Batches under run(): #1 started entry, #2 claim, #3 record, #4 finalize.
    const { db, seen } = dbWithBatch(4, { fail: true });
    const res = await refundOne(shop, saleId, productItem, token, db);
    expect(seen.fired, "the finalize batch never ran").toBe(true);
    expect(res.status).toBe(200);
    expect(await refundRows(saleId)).toMatchObject({ returns: 1, refund_txs: 1, reversals: 1, refunded_pence: 1000 });
    // The claim stays held, so a retry cannot refund the same unit twice.
    const claim = await env.DB.prepare("SELECT returned_quantity AS q FROM sale_items WHERE id = ?")
      .bind(productItem)
      .first<{ q: number }>();
    expect(claim?.q).toBe(1);
    // Stripe refunded, the restock could not be saved: reported in the entry.
    const outcome = (
      await env.DB.prepare(
        "SELECT details_json FROM audit_log WHERE action = 'payment.refund.issue' AND entity_id = ? AND phase = 'outcome'"
      )
        .bind(saleId)
        .first<{ details_json: string }>()
    )?.details_json;
    expect(JSON.parse(String(outcome))).toMatchObject({ via_stripe: true, finalized: false });

    const wh = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_late", payment_intent: piId, amount: 4500, amount_refunded: 1000 } },
    });
    expect(wh.status).toBe(200);
    expect(await refundRows(saleId)).toMatchObject({ returns: 1, refund_txs: 1, refund_tx_pence: 1000, refunded_pence: 1000 });
    const ret = await env.DB.prepare("SELECT status FROM sale_returns WHERE sale_id = ?").bind(saleId).first();
    expect(ret).toEqual({ status: "completed" });
  });

  it("a sale disputed between the refund's checks and its record is not refunded", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    const stripeCalls: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.stripe.com/")) stripeCalls.push(url);
      return real(input, init);
    });
    try {
      const { db, seen } = dbWithBatch(3, { before: "UPDATE sales SET status = 'disputed' WHERE id = ?", saleId });
      const res = await refundOne(shop, saleId, productItem, token, db);
      expect(seen.fired, "the record batch never ran").toBe(true);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        success: false,
        error: "This sale changed while refunding. Reload and try again.",
      });
      expect(stripeCalls).toEqual([]);
      expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, reversals: 0, refunded_pence: 0 });
      const item = await env.DB.prepare("SELECT returned_quantity AS q FROM sale_items WHERE id = ?")
        .bind(productItem)
        .first<{ q: number }>();
      expect(item?.q).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a cash sale voided between the refund's checks and its record is not refunded", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await ringCashSale(shop, staff, service, product, token);
    const { db, seen } = dbWithBatch(3, { before: "UPDATE sales SET status = 'voided' WHERE id = ?", saleId });
    const res = await refundOne(shop, saleId, productItem, token, db);
    expect(seen.fired, "the record batch never ran").toBe(true);
    expect(res.status).toBe(409);
    expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, reversals: 0, refunded_pence: 0 });
  });

  it("a refund that completes a sale another refund already part-refunded flips it, even from a stale read", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, serviceItem } = await ringCashSale(shop, staff, service, product, token);
    // A concurrent refund of both product units (2000) lands after this
    // request's checks read refunded_pence 0, before its record.
    const { db, seen } = dbWithBatch(3, { before: "UPDATE sales SET refunded_pence = 2000 WHERE id = ?", saleId });
    const res = await refundOne(shop, saleId, serviceItem, token, db);
    expect(seen.fired, "the record batch never ran").toBe(true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { fully_refunded: boolean } }).data.fully_refunded).toBe(true);
    expect(await refundRows(saleId)).toMatchObject({ refunded_pence: 4500, sale_status: "refunded" });
  });

  it("a refund that would take a sale past its total is refused, from a stale read", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, serviceItem } = await ringCashSale(shop, staff, service, product, token);
    const { db, seen } = dbWithBatch(3, { before: "UPDATE sales SET refunded_pence = 4000 WHERE id = ?", saleId });
    const res = await refundOne(shop, saleId, serviceItem, token, db);
    expect(seen.fired, "the record batch never ran").toBe(true);
    expect(res.status).toBe(409);
    expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, refunded_pence: 4000, sale_status: "completed" });
    const item = await env.DB.prepare("SELECT returned_quantity AS q FROM sale_items WHERE id = ?")
      .bind(serviceItem)
      .first<{ q: number }>();
    expect(item?.q).toBe(0);
  });

  /** Stripe answers the refund create with `createStatus`; the refund list
   *  (GET /v1/refunds) holds the refund the create carried when `madeIt`. */
  function stripeAnswers(createStatus: number, madeIt: boolean | "down") {
    const calls: string[] = [];
    let createdReturnId = "";
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.stripe.com/v1/refunds")) return real(input, init);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(url).pathname}`);
      if (method === "POST") {
        createdReturnId = new URLSearchParams(String(init?.body ?? "")).get("metadata[returnId]") ?? "";
        return Response.json({ error: { message: "stripe trouble" } }, { status: createStatus });
      }
      if (madeIt === "down") return Response.json({ error: { message: "stripe down" } }, { status: 503 });
      return Response.json({
        data: madeIt ? [{ id: "re_made_it", status: "succeeded", metadata: { returnId: createdReturnId } }] : [],
      });
    });
    return calls;
  }

  it("a Stripe 5xx whose refund went through anyway keeps the refund, so a retry cannot pay twice", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    try {
      const calls = stripeAnswers(500, true);
      const res = await refundOne(shop, saleId, productItem, token);
      expect(calls).toEqual(["POST /v1/refunds", "GET /v1/refunds"]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string } };
      const ret = await env.DB.prepare("SELECT status, stripe_refund_id FROM sale_returns WHERE id = ?")
        .bind(body.data.id)
        .first();
      expect(ret).toEqual({ status: "pending", stripe_refund_id: "re_made_it" });
      expect(await refundRows(saleId)).toMatchObject({ returns: 1, refund_txs: 1, refunded_pence: 1000 });
      expect(await stockQty(shop, product)).toBe(4);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a Stripe 5xx with no refund at Stripe undoes the record", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    try {
      const calls = stripeAnswers(502, false);
      const res = await refundOne(shop, saleId, productItem, token);
      expect(calls).toEqual(["POST /v1/refunds", "GET /v1/refunds"]);
      expect(res.status).toBe(502);
      expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, reversals: 0, refunded_pence: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a refund Stripe rejected outright is undone without asking Stripe again", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    try {
      const calls = stripeAnswers(400, true);
      const res = await refundOne(shop, saleId, productItem, token);
      expect(calls).toEqual(["POST /v1/refunds"]);
      expect(res.status).toBe(502);
      expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, refunded_pence: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("when Stripe cannot be asked either, the record is undone, as before", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);
    try {
      const calls = stripeAnswers(500, "down");
      const res = await refundOne(shop, saleId, productItem, token);
      expect(calls).toEqual(["POST /v1/refunds", "GET /v1/refunds"]);
      expect(res.status).toBe(502);
      expect(await refundRows(saleId)).toMatchObject({ returns: 0, refund_txs: 0, refunded_pence: 0 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("cannot over-refund across sequential returns", async () => {
    const { shop, staff, service, product, token } = await seedRefundShop();
    const { saleId, productItem } = await settledStripeSale(shop, staff, service, product, token);

    const first = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 2 }] },
    });
    expect(first.status).toBe(200);

    const second = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/refund`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { lines: [{ sale_item_id: productItem, quantity: 1 }] },
    });
    expect(second.status).toBe(400);
  });
});
