/**
 * The inventory report's days are the shop's days, not UTC's.
 *
 * A UK shop's day starts at midnight London time, an hour before UTC's in
 * British Summer Time. The report matched each sale and stock movement on
 * the UTC date of its created_at, and took its default range from the UTC
 * date. So a sale at 00:30 London on 2 July counted on 1 July, and one at
 * 23:30 London on 2 July counted on 3 July.
 *
 * created_at is written by D1 as "YYYY-MM-DD HH:MM:SS" (UTC). Faked JS time
 * does not reach D1's clock, so rows are seeded with explicit timestamps.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

type Report = {
  from: string;
  to: string;
  retail: { revenue_pence: number; units_sold: number };
  consumption: { units_consumed: number };
};

async function adminFor(shopId: string): Promise<Record<string, string>> {
  return authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
}

/** A shop with one product, product sales of `pence` at each UTC `at`, and consumption of `units` at each UTC `at`. */
async function shopWith(sales: Array<{ at: string; pence: number }>, consumption: Array<{ at: string; units: number }> = []) {
  const shop = await seedShop("Linden Report");
  const staffId = await seedStaff(shop);
  const product = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO products (id, shop_id, name, cost_price_pence, retail_price_pence, track_stock, is_active)
     VALUES (?, ?, 'Pomade', 100, 1000, 1, 1)`,
  )
    .bind(product, shop)
    .run();
  for (const s of sales) {
    const saleId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO sales (id, shop_id, subtotal_pence, discount_pence, tip_pence, total_pence, tender_type, status, created_at)
       VALUES (?, ?, ?, 0, 0, ?, 'cash', 'completed', ?)`,
    )
      .bind(saleId, shop, s.pence, s.pence, s.at)
      .run();
    await env.DB.prepare(
      `INSERT INTO sale_items (id, sale_id, shop_id, item_type, product_id, name, quantity, unit_price_pence, cost_price_pence, line_total_pence, staff_id, is_commissionable)
       VALUES (?, ?, ?, 'product', ?, 'Pomade', 1, ?, 100, ?, ?, 1)`,
    )
      .bind(crypto.randomUUID(), saleId, shop, product, s.pence, s.pence, staffId)
      .run();
  }
  for (const m of consumption) {
    await env.DB.prepare(
      `INSERT INTO stock_movements (id, shop_id, product_id, variant_id, type, quantity_delta, unit_cost_pence, created_at)
       VALUES (?, ?, ?, NULL, 'consumption', ?, 100, ?)`,
    )
      .bind(crypto.randomUUID(), shop, product, -m.units, m.at)
      .run();
  }
  return { shop, headers: await adminFor(shop) };
}

async function report(shop: string, headers: Record<string, string>, query: string) {
  const res = await dispatch("GET", `/api/shops/${shop}/inventory/report${query}`, { headers });
  const body = (await res.json()) as { success: boolean; data: Report; error?: string };
  return { status: res.status, body };
}

// Either side of 2 July in London (summer time, UTC+1). Each amount marks one sale.
const AROUND_2_JULY = [
  { at: "2026-07-01 22:30:00", pence: 100 }, // 23:30 on 1 July in London
  { at: "2026-07-01 23:30:00", pence: 200 }, // 00:30 on 2 July
  { at: "2026-07-02 22:30:00", pence: 400 }, // 23:30 on 2 July
  { at: "2026-07-02 23:30:00", pence: 800 }, // 00:30 on 3 July
];

afterEach(() => {
  vi.useRealTimers();
});

describe("inventory report, the shop's day", () => {
  it("2 July is London's 2 July: the sales at 00:30 and 23:30 London, not the UTC date's", async () => {
    const { shop, headers } = await shopWith(AROUND_2_JULY);
    const r = await report(shop, headers, "?from=2026-07-02&to=2026-07-02");
    expect(r.status).toBe(200);
    expect(r.body.data.retail).toMatchObject({ revenue_pence: 200 + 400, units_sold: 2 });
  });

  it("a range takes whole shop days at both ends", async () => {
    const { shop, headers } = await shopWith(AROUND_2_JULY);
    const r = await report(shop, headers, "?from=2026-07-01&to=2026-07-02");
    expect(r.body.data.retail.revenue_pence).toBe(100 + 200 + 400);
  });

  it("consumption is counted on the shop's day too", async () => {
    const { shop, headers } = await shopWith(
      [],
      [
        { at: "2026-07-01 23:30:00", units: 2 }, // 00:30 on 2 July in London
        { at: "2026-07-02 23:30:00", units: 5 }, // 00:30 on 3 July
      ],
    );
    const r = await report(shop, headers, "?from=2026-07-02&to=2026-07-02");
    expect(r.body.data.consumption.units_consumed).toBe(2);
  });

  it("a shop zone this machine does not know reads London's day, never a 500", async () => {
    const { shop, headers } = await shopWith(AROUND_2_JULY);
    await env.DB.prepare("UPDATE shops SET timezone = 'Not/AZone' WHERE id = ?").bind(shop).run();
    const r = await report(shop, headers, "?from=2026-07-02&to=2026-07-02");
    expect(r.status).toBe(200);
    expect(r.body.data.retail.revenue_pence).toBe(200 + 400);
  });

  it("control: in winter London's day is UTC's", async () => {
    const { shop, headers } = await shopWith([
      { at: "2026-01-14 23:30:00", pence: 100 },
      { at: "2026-01-15 00:30:00", pence: 200 },
      { at: "2026-01-15 23:30:00", pence: 400 },
      { at: "2026-01-16 00:30:00", pence: 800 },
    ]);
    const r = await report(shop, headers, "?from=2026-01-15&to=2026-01-15");
    expect(r.body.data.retail.revenue_pence).toBe(200 + 400);
  });
});

describe("inventory report, the default range", () => {
  it("at 00:30 London on 2 July, runs to the shop's today (2 July) from 30 days before", async () => {
    const { shop, headers } = await shopWith([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T23:30:00Z"));
    const r = await report(shop, headers, "");
    expect(r.status).toBe(200);
    expect({ from: r.body.data.from, to: r.body.data.to }).toEqual({ from: "2026-06-02", to: "2026-07-02" });
  });
});

describe("inventory report, a date that is not on the calendar", () => {
  it.each([
    ["month 00", "?from=2026-00-10&to=2026-01-05"],
    ["30 February", "?from=2026-02-30&to=2026-03-05"],
    ["31 April as the end", "?from=2026-04-01&to=2026-04-31"],
  ])("%s is the caller's mistake: 400", async (_kind, query) => {
    const { shop, headers } = await shopWith([]);
    const r = await report(shop, headers, query);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("from/to must be YYYY-MM-DD with from <= to");
  });

  it("control: a real leap day is a date", async () => {
    const { shop, headers } = await shopWith([]);
    expect((await report(shop, headers, "?from=2028-02-29&to=2028-02-29")).status).toBe(200);
  });

  it("control: the last day of year 9999 is a date too, though the window ends past it", async () => {
    const { shop, headers } = await shopWith([]);
    expect((await report(shop, headers, "?from=2026-01-01&to=9999-12-31")).status).toBe(200);
  });
});
