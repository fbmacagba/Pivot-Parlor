import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedScheduleDay } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";

/**
 * Public booking (/api/bookings) contract + validation. The customer wizard
 * posts shop_slug (not shop_id) and a slot from getAvailableSlots; the handler
 * must resolve the slug, validate the time is a real future slot, and resolve
 * an "any available" request to a concrete staff member.
 */

let svcN = 0;
async function seedService(shopId: string, durationMin = 30): Promise<string> {
  const id = `svc-${++svcN}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price, is_active) VALUES (?, ?, 'Cut', ?, 25, 1)"
  )
    .bind(id, shopId, durationMin)
    .run();
  return id;
}

async function slugFor(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

async function setupBookable() {
  const shop = await seedShop("Bookable Shop");
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  // Seed working hours for every weekday so any test date has a schedule.
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
  return { shop, staff, service };
}

const FUTURE_DATE = "2099-06-15";
const PAST_DATE = "2000-06-15";

const customer = { customer_name: "Casey", customer_email: "casey@test.local" };

describe("public booking (/api/bookings)", () => {
  it("accepts shop_slug (resolves to id) + a real available slot", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const slot = slots.find((s) => s.is_available);
    expect(slot).toBeTruthy();

    const res = await dispatch("POST", "/api/bookings", {
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
  });

  it("still accepts shop_id", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/api/bookings", {
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
  });

  it("rejects a past start_time (400)", async () => {
    const { shop, staff, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, staff, PAST_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/api/bookings", {
      body: {
        shop_id: shop,
        staff_id: staff,
        service_id: service,
        date: PAST_DATE,
        start_time: slots.find((s) => s.is_available)!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a time that is not an available slot (409)", async () => {
    const { shop, staff, service } = await setupBookable();
    // 03:00 UTC is outside the 09:00-17:00 (Europe/London) schedule.
    const res = await dispatch("POST", "/api/bookings", {
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

  it("resolves staff_id='any' to a real available staff", async () => {
    const { shop, service } = await setupBookable();
    const slots = await getAvailableSlots(shop, null, FUTURE_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/api/bookings", {
      body: {
        shop_slug: await slugFor(shop),
        staff_id: "any",
        service_id: service,
        date: FUTURE_DATE,
        start_time: slots.find((s) => s.is_available)!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(201);
  });

  it("400s when neither shop_id nor shop_slug is provided", async () => {
    const res = await dispatch("POST", "/api/bookings", {
      body: {
        staff_id: "x",
        service_id: "x",
        date: FUTURE_DATE,
        start_time: `${FUTURE_DATE}T10:00:00.000Z`,
        ...customer,
      },
    });
    expect(res.status).toBe(400);
  });
});
