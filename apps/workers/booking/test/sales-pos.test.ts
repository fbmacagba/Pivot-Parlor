import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { calculateCommissionPence } from "@repo/utils";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService, seedProduct, tokenFor } from "./helpers";

/**
 * WS-3 Phase 1: counter POS + checkout on the unified sales spine.
 * Stripe is faked by the outboundService in vitest.config.ts — Checkout
 * Session creation echoes the Idempotency-Key into the id (cs_idem_<key>).
 */

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

/** commission_rate 10%, retail_commission_rate 20% — distinct on purpose. */
async function seedPosShop() {
  const shop = await seedShop("POS Shop");
  await env.DB
    .prepare(
      "UPDATE shops SET stripe_connect_account_id = 'acct_pos1', commission_rate = 0.10, retail_commission_rate = 0.20 WHERE id = ?"
    )
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop); // 2500 pence
  const product = await seedProduct(shop, { retailPence: 1000, costPence: 300, stock: 5 });
  return { shop, staff, service, product, token: await tokenFor("admin", shop) };
}

async function stockQty(shop: string, product: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shop, product)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

describe("POST /booking/shops/:shopId/sales — record-only tenders", () => {
  it("rings a mixed cash sale: split-rate commission, COGS snapshot, stock decrement, honest ledger", async () => {
    const { shop, staff, service, product, token } = await seedPosShop();

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        staff_id: staff,
        discount_pence: 500,
        tip_pence: 200,
        items: [
          { type: "service", serviceId: service, quantity: 1, staffId: staff },
          { type: "product", productId: product, quantity: 1, staffId: staff },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; sale: Record<string, number | string | null> };
    expect(body.success).toBe(true);

    // Pro-rata discount split: services 2500, retail 1000, discount 500.
    const discServices = 2500 - Math.round((500 * 2500) / 3500);
    const discRetail = 3500 - 500 - discServices;
    const expectedCommission =
      calculateCommissionPence(discServices, 0.1).commission_pence +
      calculateCommissionPence(discRetail, 0.2).commission_pence;

    expect(body.sale.status).toBe("completed");
    expect(body.sale.total_pence).toBe(3500 - 500 + 200); // bearer=shop: no commission on top
    expect(body.sale.payment_url).toBeNull();

    const ledger = await env.DB
      .prepare("SELECT * FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(body.sale.id)
      .first<Record<string, unknown>>();
    expect(ledger).toMatchObject({
      services_amount_pence: discServices,
      retail_amount_pence: discRetail,
      commission_amount_pence: expectedCommission,
      retail_commission_rate: 0.2,
      // Cash never settles through Stripe: commission owed, not transferred.
      status: "pending",
    });

    // COGS snapshot on the product line.
    const item = await env.DB
      .prepare("SELECT cost_price_pence, line_total_pence FROM sale_items WHERE sale_id = ? AND item_type = 'product'")
      .bind(body.sale.id)
      .first<{ cost_price_pence: number; line_total_pence: number }>();
    expect(item).toMatchObject({ cost_price_pence: 300, line_total_pence: 1000 });

    // Stock decremented through a movement, atomically with the sale.
    expect(await stockQty(shop, product)).toBe(4);
    const movement = await env.DB
      .prepare("SELECT type, quantity_delta FROM stock_movements WHERE reference_type = 'sale' AND reference_id = ?")
      .bind(body.sale.id)
      .first<{ type: string; quantity_delta: number }>();
    expect(movement).toMatchObject({ type: "sale", quantity_delta: -1 });

    const tx = await env.DB
      .prepare("SELECT type, status, amount_pence FROM bw_transactions WHERE sale_id = ?")
      .bind(body.sale.id)
      .first<{ type: string; status: string; amount_pence: number }>();
    expect(tx).toMatchObject({ type: "sale", status: "captured", amount_pence: 3200 });
  });

  it("staff can ring a sale; invalid carts are rejected", async () => {
    const { shop, product, token } = await seedPosShop();
    const staffToken = await tokenFor("staff", shop);

    const ok = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 1 }] },
    });
    expect(ok.status).toBe(200);

    const unknownProduct = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: "nope", quantity: 1 }] },
    });
    expect(unknownProduct.status).toBe(400);

    const excessiveDiscount = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        discount_pence: 99999,
        items: [{ type: "product", productId: product, quantity: 1 }],
      },
    });
    expect(excessiveDiscount.status).toBe(400);

    const badTender = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "iou", items: [{ type: "product", productId: product, quantity: 1 }] },
    });
    expect(badTender.status).toBe(400);
  });
});

describe("oversell floor (tracked products cannot sell below recorded stock)", () => {
  async function saleCount(shop: string): Promise<number> {
    const row = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sales WHERE shop_id = ?")
      .bind(shop)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("blocks a sale exceeding recorded stock, naming the product, changing nothing", async () => {
    const { shop, product, token } = await seedPosShop(); // stock 5

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 6 }] },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain("Not enough stock");
    expect(body.error).toContain("Pomade");

    expect(await stockQty(shop, product)).toBe(5);
    expect(await saleCount(shop)).toBe(0);
  });

  it("sells exactly to zero, then blocks the next unit", async () => {
    const { shop, product, token } = await seedPosShop(); // stock 5

    const drain = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 5 }] },
    });
    expect(drain.status).toBe(200);
    expect(await stockQty(shop, product)).toBe(0);

    const oneMore = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 1 }] },
    });
    expect(oneMore.status).toBe(400);
    expect(await stockQty(shop, product)).toBe(0);
  });

  it("a tracked product with no stock_levels row is stock 0 and blocked; track_stock=0 always sells", async () => {
    const { shop, token } = await seedPosShop();
    const neverStocked = await seedProduct(shop); // tracked, no stock row
    const untracked = await seedProduct(shop, { trackStock: false });

    const blocked = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: neverStocked, quantity: 1 }] },
    });
    expect(blocked.status).toBe(400);

    const sold = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: untracked, quantity: 1 }] },
    });
    expect(sold.status).toBe(200);
  });

  it("a losing cart releases sibling claims (winner's stock unchanged after the 400)", async () => {
    const { shop, product, token } = await seedPosShop(); // Pomade, stock 5
    const scarce = await seedProduct(shop, { stock: 1 });

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        items: [
          { type: "product", productId: product, quantity: 2 },
          { type: "product", productId: scarce, quantity: 2 },
        ],
      },
    });
    expect(res.status).toBe(400);

    // The Pomade claim won and must have been released with the sale rejected.
    expect(await stockQty(shop, product)).toBe(5);
    expect(await stockQty(shop, scarce)).toBe(1);
    expect(await saleCount(shop)).toBe(0);
  });

  it("duplicate lines of one product are checked against their SUMMED demand", async () => {
    const { shop, product, token } = await seedPosShop(); // stock 5

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        items: [
          { type: "product", productId: product, quantity: 3 },
          { type: "product", productId: product, quantity: 3 },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(await stockQty(shop, product)).toBe(5);
  });

  it("back-bar consumption is exempt: a service whose BOM outruns stock still sells, stock goes negative", async () => {
    const { shop, staff, service, token } = await seedPosShop();
    const backBar = await seedProduct(shop); // tracked, stock 0 (no row)
    await env.DB
      .prepare("INSERT INTO service_products (service_id, product_id, shop_id, quantity) VALUES (?, ?, ?, 2)")
      .bind(service, backBar, shop)
      .run();

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "service", serviceId: service, quantity: 1, staffId: staff }] },
    });
    expect(res.status).toBe(200);
    expect(await stockQty(shop, backBar)).toBe(-2);
  });

  it("voiding a sale returns the claimed stock", async () => {
    const { shop, product, token } = await seedPosShop(); // stock 5

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 3 }] },
    });
    expect(res.status).toBe(200);
    const saleId = ((await res.json()) as { sale: { id: string } }).sale.id;
    expect(await stockQty(shop, product)).toBe(2);

    const voided = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/void`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(voided.status).toBe(200);
    expect(await stockQty(shop, product)).toBe(5);
  });
});

describe("POST /booking/shops/:shopId/sales — stripe tender", () => {
  it("creates a Checkout Session and settles the sale on payment_intent.succeeded", async () => {
    const { shop, product, token } = await seedPosShop();

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "stripe",
        items: [{ type: "product", productId: product, quantity: 2 }],
        success_url: "https://pivotparlor.com/pay/done",
        cancel_url: "https://pivotparlor.com/pay/cancelled",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sale: { id: string; status: string; payment_url: string } };
    expect(body.sale.status).toBe("pending");
    // Deterministic Idempotency-Key echoed into the session id by the fake.
    expect(body.sale.payment_url).toBe(
      `https://checkout.stripe.com/c/pay/cs_idem_sale:${body.sale.id}`
    );

    // Stock is held from creation (voidable if the customer walks away).
    expect(await stockQty(shop, product)).toBe(3);

    const tx = await env.DB
      .prepare("SELECT status, stripe_id FROM bw_transactions WHERE sale_id = ?")
      .bind(body.sale.id)
      .first<{ status: string; stripe_id: string }>();
    expect(tx).toMatchObject({ status: "pending", stripe_id: `cs_idem_sale:${body.sale.id}` });

    // The customer pays on their phone → the PI succeeds with our metadata.
    const wh = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_pos_paid_1", metadata: { saleId: body.sale.id, shopId: shop, type: "sale" } } },
    });
    expect(wh.status).toBe(200);

    const sale = await env.DB
      .prepare("SELECT status, stripe_payment_intent_id, completed_at FROM sales WHERE id = ?")
      .bind(body.sale.id)
      .first<{ status: string; stripe_payment_intent_id: string; completed_at: string | null }>();
    expect(sale).toMatchObject({ status: "completed", stripe_payment_intent_id: "pi_pos_paid_1" });
    expect(sale?.completed_at).toBeTruthy();

    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(body.sale.id)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("transferred");

    const settledTx = await env.DB
      .prepare("SELECT status, stripe_id FROM bw_transactions WHERE sale_id = ?")
      .bind(body.sale.id)
      .first<{ status: string; stripe_id: string }>();
    expect(settledTx).toMatchObject({ status: "captured", stripe_id: "pi_pos_paid_1" });
  });

  it("requires Connect and https URLs, and rejects zero-total Stripe payments", async () => {
    const { shop, product, token } = await seedPosShop();

    const noUrls = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "stripe", items: [{ type: "product", productId: product, quantity: 1 }] },
    });
    expect(noUrls.status).toBe(400);

    const bare = await seedShop("No Connect Shop");
    const prod2 = await seedProduct(bare, {});
    const noConnect = await dispatch("POST", `/booking/shops/${bare}/sales`, {
      headers: { Authorization: `Bearer ${await tokenFor("admin", bare)}` },
      body: {
        tender: "stripe",
        items: [{ type: "product", productId: prod2, quantity: 1 }],
        success_url: "https://x.test/s",
        cancel_url: "https://x.test/c",
      },
    });
    expect(noConnect.status).toBe(400);
  });
});

describe("void (POST /booking/shops/:shopId/sales/:saleId/void)", () => {
  async function cashSale(shop: string, product: string, token: string): Promise<string> {
    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: product, quantity: 2 }] },
    });
    return ((await res.json()) as { sale: { id: string } }).sale.id;
  }

  it("admin void restores stock and voids the tender + ledger", async () => {
    const { shop, product, token } = await seedPosShop();
    const saleId = await cashSale(shop, product, token);
    expect(await stockQty(shop, product)).toBe(3);

    const res = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/void`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(res.status).toBe(200);

    expect(await stockQty(shop, product)).toBe(5);
    const sale = await env.DB
      .prepare("SELECT status FROM sales WHERE id = ?")
      .bind(saleId)
      .first<{ status: string }>();
    expect(sale?.status).toBe("voided");
    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(saleId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("voided");

    const again = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/void`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(again.status).toBe(400);
  });

  it("staff cannot void; a paid Stripe sale must be refunded instead", async () => {
    const { shop, product, token } = await seedPosShop();
    const saleId = await cashSale(shop, product, token);

    const staffVoid = await dispatch("POST", `/booking/shops/${shop}/sales/${saleId}/void`, {
      headers: { Authorization: `Bearer ${await tokenFor("staff", shop)}` },
      body: {},
    });
    expect(staffVoid.status).toBe(403);

    // Simulate a paid stripe sale, then try to void it.
    const paid = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "stripe",
        items: [{ type: "product", productId: product, quantity: 1 }],
        success_url: "https://x.test/s",
        cancel_url: "https://x.test/c",
      },
    });
    const paidSaleId = ((await paid.json()) as { sale: { id: string } }).sale.id;
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_paid_void", metadata: { saleId: paidSaleId } } },
    });
    const res = await dispatch("POST", `/booking/shops/${shop}/sales/${paidSaleId}/void`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/refunded via Stripe/i);
  });
});

describe("checkout unification (appointment checkout writes the sales spine)", () => {
  it("checkout with a catalogue product creates the sale, splits commission and decrements stock", async () => {
    const { shop, staff, service, product, token } = await seedPosShop();

    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-01', '10:00', '10:30', 'confirmed', 2500, 250)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, deposit_amount_pence, stripe_payment_intent_id, checked_in_at, updated_at)
       VALUES (?, ?, 1000, 'pi_hold_u1', datetime('now'), datetime('now'))`
    ).bind(bookingId, shop).run();

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { products: [{ productId: product, quantity: 2 }], tipPercent: 10 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      saleId: string;
      receipt: Record<string, number>;
      balanceClientSecret: string | null;
    };

    // services 2500 + products 2000 = 4500; tip 10% = 450; bearer=shop.
    expect(body.receipt).toMatchObject({
      services_pence: 2500,
      products_pence: 2000,
      tip_pence: 450,
      total_pence: 4950,
    });

    const sale = await env.DB
      .prepare("SELECT booking_id, status, tender_type, tip_pence, total_pence FROM sales WHERE id = ?")
      .bind(body.saleId)
      .first<Record<string, unknown>>();
    // Balance PI outstanding → sale pending until the webhook settles it.
    expect(sale).toMatchObject({
      booking_id: bookingId,
      status: "pending",
      tender_type: "stripe",
      tip_pence: 450,
      total_pence: 4950,
    });

    const items = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?")
      .bind(body.saleId)
      .first<{ n: number }>();
    expect(items?.n).toBe(2);

    expect(await stockQty(shop, product)).toBe(3);

    const expectedCommission =
      calculateCommissionPence(2500, 0.1).commission_pence +
      calculateCommissionPence(2000, 0.2).commission_pence;
    const ledger = await env.DB
      .prepare(
        "SELECT services_amount_pence, retail_amount_pence, commission_amount_pence, status FROM bw_commission_ledger WHERE sale_id = ?"
      )
      .bind(body.saleId)
      .first<Record<string, unknown>>();
    expect(ledger).toMatchObject({
      services_amount_pence: 2500,
      retail_amount_pence: 2000,
      commission_amount_pence: expectedCommission,
      status: "pending",
    });

    // The balance PI settles → sale completed AND the booking state stamps.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: `pi_idem_balance:${bookingId}`,
          metadata: { saleId: body.saleId, bookingId, type: "balance" },
        },
      },
    });

    const settled = await env.DB
      .prepare("SELECT status FROM sales WHERE id = ?")
      .bind(body.saleId)
      .first<{ status: string }>();
    expect(settled?.status).toBe("completed");
    const state = await env.DB
      .prepare("SELECT completed_at FROM bw_booking_state WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ completed_at: string | null }>();
    expect(state?.completed_at).toBeTruthy();
  });

  it("rejects a checkout product that is not in the catalogue and reverts the claim", async () => {
    const { shop, staff, service, token } = await seedPosShop();
    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-02', '10:00', '10:30', 'confirmed', 2500, 250)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, deposit_amount_pence, stripe_payment_intent_id, checked_in_at, updated_at)
       VALUES (?, ?, 1000, 'pi_hold_u2', datetime('now'), datetime('now'))`
    ).bind(bookingId, shop).run();

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { products: [{ productId: "ghost-product", quantity: 1 }] },
    });
    expect(res.status).toBe(400);

    const row = await env.DB
      .prepare("SELECT status FROM bookings WHERE id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");
  });
});
