/**
 * WS-3 Phase 2: back-bar consumption. Selling a service consumes its
 * service_products BOM — on the counter POS AND the appointment checkout —
 * and voiding a sale puts the consumed stock back.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService, seedProduct, tokenFor } from "./helpers";

async function stockQty(shop: string, product: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shop, product)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

/** Shop with a service whose BOM uses 2 units of a back-bar product per service. */
async function seedBomShop() {
  const shop = await seedShop("BOM Shop");
  await env.DB
    .prepare("UPDATE shops SET stripe_connect_account_id = 'acct_bom1' WHERE id = ?")
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop); // 2500 pence
  const backbar = await seedProduct(shop, { costPence: 150, retailPence: 0, stock: 10 });
  await env.DB
    .prepare("INSERT INTO service_products (service_id, product_id, shop_id, quantity) VALUES (?, ?, ?, 2)")
    .bind(service, backbar, shop)
    .run();
  return { shop, staff, service, backbar, token: await tokenFor("admin", shop) };
}

describe("back-bar consumption (service_products BOM)", () => {
  it("a POS service sale consumes the BOM atomically, and voiding restores it", async () => {
    const { shop, staff, service, backbar, token } = await seedBomShop();

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        tender: "cash",
        items: [{ type: "service", serviceId: service, quantity: 2, staffId: staff }],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sale: { id: string } };

    // 2 services × 2 units each = 4 consumed.
    expect(await stockQty(shop, backbar)).toBe(6);
    const movement = await env.DB
      .prepare(
        "SELECT type, quantity_delta, unit_cost_pence FROM stock_movements WHERE reference_type = 'sale' AND reference_id = ? AND type = 'consumption'"
      )
      .bind(body.sale.id)
      .first<{ type: string; quantity_delta: number; unit_cost_pence: number }>();
    expect(movement).toMatchObject({ type: "consumption", quantity_delta: -4, unit_cost_pence: 150 });

    // Void puts the back-bar stock back (reversal references the same sale).
    const voided = await dispatch("POST", `/booking/shops/${shop}/sales/${body.sale.id}/void`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(voided.status).toBe(200);
    expect(await stockQty(shop, backbar)).toBe(10);
  });

  it("a product-only sale consumes nothing", async () => {
    const { shop, backbar, token } = await seedBomShop();
    const retail = await seedProduct(shop, { retailPence: 800, stock: 5 });

    const res = await dispatch("POST", `/booking/shops/${shop}/sales`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tender: "cash", items: [{ type: "product", productId: retail, quantity: 1 }] },
    });
    expect(res.status).toBe(200);
    expect(await stockQty(shop, backbar)).toBe(10);
  });

  it("the appointment checkout consumes the base service's BOM too", async () => {
    const { shop, staff, service, backbar, token } = await seedBomShop();

    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-01', '10:00', '10:30', 'confirmed', 2500, 250)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, deposit_amount_pence, stripe_payment_intent_id, checked_in_at, updated_at)
       VALUES (?, ?, 1000, 'pi_hold_bom1', datetime('now'), datetime('now'))`
    ).bind(bookingId, shop).run();

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saleId: string };

    expect(await stockQty(shop, backbar)).toBe(8);
    const movement = await env.DB
      .prepare(
        "SELECT quantity_delta FROM stock_movements WHERE reference_type = 'sale' AND reference_id = ? AND type = 'consumption'"
      )
      .bind(body.saleId)
      .first<{ quantity_delta: number }>();
    expect(movement?.quantity_delta).toBe(-2);
  });
});
