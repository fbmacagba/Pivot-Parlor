/**
 * WS-3 Phase 2: purchasing, stock-take sessions, back-bar BOM, retail report.
 * The suite setup replays the full migration chain, so these also prove
 * migration 038 stays replayable.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { shopToday } from "../src/lib/shopTime";

type Body<T> = { success: boolean; data: T; error?: string };

async function adminFor(shopId: string): Promise<Record<string, string>> {
  return authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
}

async function staffHeadersFor(shopId: string): Promise<Record<string, string>> {
  const staffId = await seedStaff(shopId);
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?")
    .bind(staffId)
    .first<{ user_id: string }>();
  return authHeaders(await tokenFor(row!.user_id, "staff", shopId));
}

async function seedProduct(
  shopId: string,
  opts: { costPence?: number; stock?: number; name?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO products (id, shop_id, name, cost_price_pence, retail_price_pence, track_stock, is_active)
     VALUES (?, ?, ?, ?, 1000, 1, 1)`
  )
    .bind(id, shopId, opts.name ?? `Product ${id.slice(0, 6)}`, opts.costPence ?? 300)
    .run();
  if (opts.stock && opts.stock > 0) {
    await env.DB.prepare(
      "INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity) VALUES (?, ?, ?, NULL, ?)"
    )
      .bind(crypto.randomUUID(), shopId, id, opts.stock)
      .run();
  }
  return id;
}

async function stockQty(shopId: string, productId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shopId, productId)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

describe("purchase orders", () => {
  it("walks the full lifecycle: draft → ordered → partial → received, with movements and cost updates", async () => {
    const shop = await seedShop("PO Shop");
    const headers = await adminFor(shop);
    const productA = await seedProduct(shop, { costPence: 300 });
    const productB = await seedProduct(shop, { costPence: 250 });

    const created = await dispatch("POST", `/api/shops/${shop}/purchase-orders`, {
      headers,
      body: {
        notes: "monthly restock",
        items: [
          { product_id: productA, quantity: 10, unit_cost_pence: 400 },
          { product_id: productB, quantity: 5 }, // cost defaults to the catalogue cost (250)
        ],
      },
    });
    expect(created.status).toBe(201);
    const poId = ((await created.json()) as Body<{ id: string }>).data.id;

    const list = await dispatch("GET", `/api/shops/${shop}/purchase-orders`, { headers });
    const rows = ((await list.json()) as Body<Array<{ id: string; status: string; total_pence: number; total_qty: number }>>).data;
    const po = rows.find((r) => r.id === poId)!;
    expect(po).toMatchObject({ status: "draft", total_pence: 10 * 400 + 5 * 250, total_qty: 15 });

    // Cannot receive a draft.
    const detail0 = await dispatch("GET", `/api/shops/${shop}/purchase-orders/${poId}`, { headers });
    const items = ((await detail0.json()) as Body<{ items: Array<{ id: string; product_id: string }> }>).data.items;
    const itemA = items.find((i) => i.product_id === productA)!;
    const itemB = items.find((i) => i.product_id === productB)!;
    const early = await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/receive`, {
      headers,
      body: { lines: [{ item_id: itemA.id, quantity: 1 }] },
    });
    expect(early.status).toBe(400);

    expect((await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/order`, { headers })).status).toBe(200);

    // Partial receipt: 4 of A. Stock moves, cost updates to the paid cost.
    const partial = await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/receive`, {
      headers,
      body: { lines: [{ item_id: itemA.id, quantity: 4 }] },
    });
    expect(partial.status).toBe(200);
    expect(((await partial.json()) as Body<{ status: string }>).data.status).toBe("partial");
    expect(await stockQty(shop, productA)).toBe(4);

    const movement = await env.DB
      .prepare(
        "SELECT type, quantity_delta, unit_cost_pence FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id = ?"
      )
      .bind(poId)
      .first<{ type: string; quantity_delta: number; unit_cost_pence: number }>();
    expect(movement).toMatchObject({ type: "receive", quantity_delta: 4, unit_cost_pence: 400 });

    const costA = await env.DB
      .prepare("SELECT cost_price_pence FROM products WHERE id = ?")
      .bind(productA)
      .first<{ cost_price_pence: number }>();
    expect(costA?.cost_price_pence).toBe(400);

    // Over-receipt is rejected (6 outstanding on A).
    const over = await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/receive`, {
      headers,
      body: { lines: [{ item_id: itemA.id, quantity: 7 }] },
    });
    expect(over.status).toBe(400);

    // Receive the rest → header flips to received with a timestamp.
    const rest = await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/receive`, {
      headers,
      body: { lines: [{ item_id: itemA.id, quantity: 6 }, { item_id: itemB.id, quantity: 5 }] },
    });
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as Body<{ status: string }>).data.status).toBe("received");
    expect(await stockQty(shop, productA)).toBe(10);
    expect(await stockQty(shop, productB)).toBe(5);
    const header = await env.DB
      .prepare("SELECT status, received_at FROM purchase_orders WHERE id = ?")
      .bind(poId)
      .first<{ status: string; received_at: string | null }>();
    expect(header?.received_at).toBeTruthy();

    // A received PO is history — no cancel.
    const cancel = await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/cancel`, { headers });
    expect(cancel.status).toBe(400);
  });

  it("rejects a product from another shop and staff mutations", async () => {
    const shopA = await seedShop("PO Shop A");
    const shopB = await seedShop("PO Shop B");
    const foreign = await seedProduct(shopB);
    const headers = await adminFor(shopA);

    const res = await dispatch("POST", `/api/shops/${shopA}/purchase-orders`, {
      headers,
      body: { items: [{ product_id: foreign, quantity: 1 }] },
    });
    expect(res.status).toBe(400);

    const staffHeaders = await staffHeadersFor(shopA);
    const own = await seedProduct(shopA);
    const denied = await dispatch("POST", `/api/shops/${shopA}/purchase-orders`, {
      headers: staffHeaders,
      body: { items: [{ product_id: own, quantity: 1 }] },
    });
    expect(denied.status).toBe(403);
  });
});

// ─── Stock takes ──────────────────────────────────────────────────────────────

describe("stock-take sessions", () => {
  it("opens one session, staff record counts, completion emits adjustments against the current level", async () => {
    const shop = await seedShop("Count Shop");
    const admin = await adminFor(shop);
    const staff = await staffHeadersFor(shop);
    const product = await seedProduct(shop, { stock: 10 });

    const opened = await dispatch("POST", `/api/shops/${shop}/stock-takes`, { headers: admin, body: {} });
    expect(opened.status).toBe(201);
    const stId = ((await opened.json()) as Body<{ id: string }>).data.id;

    // Only one open session per shop.
    expect((await dispatch("POST", `/api/shops/${shop}/stock-takes`, { headers: admin, body: {} })).status).toBe(409);

    // Staff count the shelf: 7 (system says 10).
    const counted = await dispatch("PUT", `/api/shops/${shop}/stock-takes/${stId}/items`, {
      headers: staff,
      body: { items: [{ product_id: product, counted_qty: 7 }] },
    });
    expect(counted.status).toBe(200);

    const item = await env.DB
      .prepare("SELECT expected_qty, counted_qty FROM stock_take_items WHERE stock_take_id = ?")
      .bind(stId)
      .first<{ expected_qty: number; counted_qty: number }>();
    expect(item).toMatchObject({ expected_qty: 10, counted_qty: 7 });

    // Completing applies the -3 adjustment (staff cannot complete).
    expect((await dispatch("POST", `/api/shops/${shop}/stock-takes/${stId}/complete`, { headers: staff })).status).toBe(403);
    const completed = await dispatch("POST", `/api/shops/${shop}/stock-takes/${stId}/complete`, { headers: admin });
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as Body<{ items_adjusted: number }>).data.items_adjusted).toBe(1);
    expect(await stockQty(shop, product)).toBe(7);

    const movement = await env.DB
      .prepare("SELECT type, quantity_delta FROM stock_movements WHERE reference_type = 'stock_take' AND reference_id = ?")
      .bind(stId)
      .first<{ type: string; quantity_delta: number }>();
    expect(movement).toMatchObject({ type: "adjustment", quantity_delta: -3 });

    // Idempotent close: a second complete is rejected.
    expect((await dispatch("POST", `/api/shops/${shop}/stock-takes/${stId}/complete`, { headers: admin })).status).toBe(400);
  });

  it("a cancelled session never touches stock", async () => {
    const shop = await seedShop("Cancel Count Shop");
    const admin = await adminFor(shop);
    const product = await seedProduct(shop, { stock: 8 });

    const opened = await dispatch("POST", `/api/shops/${shop}/stock-takes`, { headers: admin, body: {} });
    const stId = ((await opened.json()) as Body<{ id: string }>).data.id;
    await dispatch("PUT", `/api/shops/${shop}/stock-takes/${stId}/items`, {
      headers: admin,
      body: { items: [{ product_id: product, counted_qty: 2 }] },
    });

    expect((await dispatch("POST", `/api/shops/${shop}/stock-takes/${stId}/cancel`, { headers: admin })).status).toBe(200);
    expect(await stockQty(shop, product)).toBe(8);
  });
});

// ─── Back-bar BOM ─────────────────────────────────────────────────────────────

describe("service_products BOM endpoints", () => {
  it("sets, reads and clears a service's recipe; rejects cross-shop products", async () => {
    const shop = await seedShop("BOM Shop");
    const other = await seedShop("BOM Other");
    const headers = await adminFor(shop);
    const productA = await seedProduct(shop, { name: "Colour tube" });
    const productB = await seedProduct(shop, { name: "Developer" });
    const foreign = await seedProduct(other);

    const serviceId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Colour', 60, 5000, 1)"
    )
      .bind(serviceId, shop)
      .run();

    const bad = await dispatch("PUT", `/api/shops/${shop}/services/${serviceId}/products`, {
      headers,
      body: { products: [{ product_id: foreign, quantity: 1 }] },
    });
    expect(bad.status).toBe(404);

    const set = await dispatch("PUT", `/api/shops/${shop}/services/${serviceId}/products`, {
      headers,
      body: { products: [{ product_id: productA, quantity: 2 }, { product_id: productB, quantity: 1 }] },
    });
    expect(set.status).toBe(200);

    const got = await dispatch("GET", `/api/shops/${shop}/services/${serviceId}/products`, { headers });
    const rows = ((await got.json()) as Body<Array<{ product_id: string; quantity: number }>>).data;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.product_id === productA)?.quantity).toBe(2);

    const cleared = await dispatch("PUT", `/api/shops/${shop}/services/${serviceId}/products`, {
      headers,
      body: { products: [] },
    });
    expect(cleared.status).toBe(200);
    const empty = await dispatch("GET", `/api/shops/${shop}/services/${serviceId}/products`, { headers });
    expect(((await empty.json()) as Body<unknown[]>).data).toHaveLength(0);
  });
});

// ─── Report ───────────────────────────────────────────────────────────────────

describe("inventory report", () => {
  it("sums retail revenue/COGS from sale_items (excluding voided) and consumption cost", async () => {
    const shop = await seedShop("Report Shop");
    const headers = await adminFor(shop);
    const staffId = await seedStaff(shop);
    const product = await seedProduct(shop, { costPence: 300 });

    const mkSale = async (status: string): Promise<string> => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO sales (id, shop_id, subtotal_pence, discount_pence, tip_pence, total_pence, tender_type, status)
         VALUES (?, ?, 2000, 0, 0, 2000, 'cash', ?)`
      )
        .bind(id, shop, status)
        .run();
      await env.DB.prepare(
        `INSERT INTO sale_items (id, sale_id, shop_id, item_type, product_id, name, quantity, unit_price_pence, cost_price_pence, line_total_pence, staff_id, is_commissionable)
         VALUES (?, ?, ?, 'product', ?, 'Pomade', 2, 1000, 300, 2000, ?, 1)`
      )
        .bind(crypto.randomUUID(), id, shop, product, staffId)
        .run();
      return id;
    };

    await mkSale("completed");
    await mkSale("voided"); // must not count

    await env.DB.prepare(
      `INSERT INTO stock_movements (id, shop_id, product_id, variant_id, type, quantity_delta, unit_cost_pence)
       VALUES (?, ?, ?, NULL, 'consumption', -2, 150)`
    )
      .bind(crypto.randomUUID(), shop, product)
      .run();

    // The shop's today: the sales above take D1's clock, and the report reads
    // the shop's day (UTC's would miss them from 23:00 UTC in summer).
    const today = shopToday();
    const res = await dispatch("GET", `/api/shops/${shop}/inventory/report?from=${today}&to=${today}`, { headers });
    expect(res.status).toBe(200);
    const report = ((await res.json()) as Body<{
      retail: { revenue_pence: number; cogs_pence: number; margin_pence: number; units_sold: number };
      by_staff: Array<{ staff_id: string; revenue_pence: number }>;
      consumption: { units_consumed: number; cost_pence: number };
    }>).data;

    expect(report.retail).toMatchObject({
      revenue_pence: 2000,
      cogs_pence: 600,
      margin_pence: 1400,
      units_sold: 2,
    });
    expect(report.by_staff.find((r) => r.staff_id === staffId)?.revenue_pence).toBe(2000);
    expect(report.consumption).toMatchObject({ units_consumed: 2, cost_pence: 300 });

    const badRange = await dispatch("GET", `/api/shops/${shop}/inventory/report?from=2026-13-01&to=${today}`, { headers });
    expect(badRange.status).toBe(400);
  });
});
