import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedScheduleDay, seedService, slugFor } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";
import { createBooking } from "../src/db/queries";

/**
 * Public booking (/public/bookings) contract + validation — ported from the
 * main worker's suite in WS-1 (the main worker now proxies /api/bookings
 * here). The customer wizard posts shop_slug (not shop_id) and a slot from
 * getAvailableSlots; the handler must resolve the slug, validate the time is
 * a real future slot, and resolve an "any available" request to a concrete
 * staff member. The response contract must not drift: the Remix action and
 * confirm page consume it unchanged.
 */

async function setupBookable() {
  const shop = await seedShop("Bookable Shop");
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  // Seed working hours for every weekday so any test date has a schedule.
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
  return { shop, staff, service };
}

const FUTURE_DATE = "2099-06-15";

const customer = { customer_name: "Casey", customer_email: "casey@test.local" };

describe("public booking (/public/bookings)", () => {
  it("accepts shop_slug (resolves to id) + a real available slot", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const slot = slots.find((s) => s.is_available);
    expect(slot).toBeTruthy();

    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_slug: await slugFor(shop),
        staff_id: staff,
        service_id: service,
        date: FUTURE_DATE,
        start_time: slot!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      shop_id: shop,
      staff_id: staff,
      service_id: service,
      status: "pending",
      start_time: slot!.start_time,
    });
  });

  it("resolves staff_id 'any' to the concrete staff of the free slot", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: "any",
        service_id: service,
        date: FUTURE_DATE,
        start_time: slots.find((s) => s.is_available)!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { staff_id: string } };
    expect(body.data.staff_id).toBe(staff);
  });

  it("rejects a past start_time (400)", async () => {
    const { shop, staff, service } = await setupBookable();
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: staff,
        service_id: service,
        start_time: "2000-06-15T10:00:00.000Z",
        ...customer,
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an off-schedule time (409)", async () => {
    const { shop, staff, service } = await setupBookable();
    // 03:00 UTC is outside the seeded 09:00-17:00 window on every weekday.
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: staff,
        service_id: service,
        date: FUTURE_DATE,
        start_time: `${FUTURE_DATE}T03:00:00.000Z`,
        ...customer,
      },
    });
    expect(res.status).toBe(409);
  });

  it("rejects a cross-shop staff_id (404)", async () => {
    const { shop, service } = await setupBookable();
    const otherShop = await seedShop("Other Shop");
    const otherStaff = await seedStaff(otherShop);
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: otherStaff,
        service_id: service,
        date: FUTURE_DATE,
        start_time: `${FUTURE_DATE}T10:00:00.000Z`,
        ...customer,
      },
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the slot was taken between offer and submit", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const slot = slots.find((s) => s.is_available)!;

    // A rival books the exact slot directly (bypassing the KV-cached slot list).
    await createBooking(env.DB, {
      id: crypto.randomUUID(),
      shop_id: shop,
      staff_id: staff,
      service_id: service,
      customer_name: "Rival",
      customer_email: "rival@test.local",
      booking_date: FUTURE_DATE,
      start_time: slot.start_time,
      end_time: slot.end_time,
      amount_pence: 2500,
      commission_pence: 250,
    });

    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: staff,
        service_id: service,
        date: FUTURE_DATE,
        start_time: slot.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(409);
  });

  it("writes only canonical bookings columns (no legacy payment columns)", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop,
        staff_id: staff,
        service_id: service,
        date: FUTURE_DATE,
        start_time: slots.find((s) => s.is_available)!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    // The row must exist with the canonical shape (schema.sql:74-92) — this
    // SELECT * would fail loudly if the INSERT targeted a dropped column.
    const row = await env.DB
      .prepare("SELECT * FROM bookings WHERE id = ?")
      .bind(data.id)
      .first<Record<string, unknown>>();
    expect(row).toBeTruthy();
    expect(row!.status).toBe("pending");
    expect(row!.amount_pence).toBe(2500);
    expect(Object.keys(row!)).not.toContain("deposit_amount");
    expect(Object.keys(row!)).not.toContain("stripe_payment_intent_id");
  });
});

describe("public slots (/public/shops/:shopId/slots)", () => {
  it("returns generated slots for a scheduled day", async () => {
    const { shop, service } = await setupBookable();
    const res = await dispatch(
      "GET",
      `/public/shops/${shop}/slots?date=${FUTURE_DATE}&service_id=${service}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Array<{ is_available: boolean }> };
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("404s a service belonging to another shop", async () => {
    const { service } = await setupBookable();
    const otherShop = await seedShop("Other");
    const res = await dispatch(
      "GET",
      `/public/shops/${otherShop}/slots?date=${FUTURE_DATE}&service_id=${service}`
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed date", async () => {
    const { shop, service } = await setupBookable();
    const res = await dispatch("GET", `/public/shops/${shop}/slots?date=junk&service_id=${service}`);
    expect(res.status).toBe(400);
  });
});
