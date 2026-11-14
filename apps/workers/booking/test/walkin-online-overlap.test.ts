import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedScheduleDay, seedShop, seedStaff, tokenFor } from "./helpers";
import { zonedTimeToUtc } from "../src/lib/timezone";
import { shopToday } from "../src/lib/time";

/**
 * The in-shop day: POST /open builds bw_availability from schedules, and a
 * walk-in or staff deposit booking claims one of those times. The claim must
 * skip any time a booking already holds, whether an online booking (an
 * instant, possibly made after the day opened) or another walk-in whose
 * service runs into the next slot. bw_availability alone knows neither.
 */
const LONDON = "Europe/London";

async function openShop(name: string, serviceMinutes = 30) {
  const shop = await seedShop(name);
  await env.DB.prepare("UPDATE shops SET setup_completed = 1 WHERE id = ?").bind(shop).run();
  const staff = await seedStaff(shop);
  const service = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', ?, 2500, 1)",
  )
    .bind(service, shop, serviceMinutes)
    .run();
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d); // 09:00-17:00
  const auth = { Authorization: `Bearer ${await tokenFor("admin", shop)}` };
  const open = await dispatch("POST", `/booking/shops/${shop}/open`, { headers: auth, body: {} });
  expect(open.status).toBe(200);
  return { shop, staff, service, auth, today: shopToday(LONDON) };
}

/** An online booking as POST /public/bookings writes it: instants. */
async function seedOnlineBooking(shop: string, staff: string, service: string, date: string, londonTime: string, minutes = 30) {
  const start = zonedTimeToUtc(date, londonTime, LONDON);
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence)
     VALUES (?, ?, ?, ?, 'Online', 'online@test.local', ?, ?, ?, 'confirmed', 2500, 250)`,
  )
    .bind(crypto.randomUUID(), shop, staff, service, date, start.toISOString(), new Date(start.getTime() + minutes * 60_000).toISOString())
    .run();
}

async function walkIn(s: { shop: string; staff: string; service: string; auth: Record<string, string> }) {
  const res = await dispatch("POST", `/booking/shops/${s.shop}/walk-ins`, {
    headers: s.auth,
    body: { serviceId: s.service, staffId: s.staff, customerName: "Walk In" },
  });
  const body = (await res.json()) as { success: boolean; bookingId?: string };
  if (!body.bookingId) return { status: res.status, start: null };
  const row = await env.DB.prepare("SELECT start_time FROM bookings WHERE id = ?")
    .bind(body.bookingId)
    .first<{ start_time: string }>();
  return { status: res.status, start: row?.start_time ?? null };
}

async function isClaimed(shop: string, staff: string, date: string, time: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT is_booked FROM bw_availability WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ?",
  )
    .bind(shop, staff, date, time)
    .first<{ is_booked: number }>();
  return Number(row?.is_booked);
}

describe("walk-in and deposit claims skip times already booked", () => {
  it("gives a walk-in the next free time, not one booked online after the day opened", async () => {
    const s = await openShop("Overlap Online");
    await seedOnlineBooking(s.shop, s.staff, s.service, s.today, "09:00");
    expect(await walkIn(s)).toEqual({ status: 200, start: "09:30" });
  });

  it("skips a time the walk-in's own service would run into", async () => {
    const s = await openShop("Overlap Long Service", 60);
    // Online 09:30 to 10:00. A 60-minute walk-in at 09:00 or 09:30 would run into it.
    await seedOnlineBooking(s.shop, s.staff, s.service, s.today, "09:30");
    expect(await walkIn(s)).toEqual({ status: 200, start: "10:00" });
  });

  it("does not seat a second walk-in inside the first one's service", async () => {
    const s = await openShop("Overlap Walk-ins", 60);
    expect(await walkIn(s)).toEqual({ status: 200, start: "09:00" });
    expect(await walkIn(s)).toEqual({ status: 200, start: "10:00" });
  });

  it("refuses a staff deposit booking at a time booked online, before any payment", async () => {
    const s = await openShop("Overlap Deposit");
    await seedOnlineBooking(s.shop, s.staff, s.service, s.today, "11:00");
    const res = await dispatch("POST", `/booking/shops/${s.shop}/bookings`, {
      headers: s.auth,
      body: {
        serviceId: s.service,
        staffId: s.staff,
        slotDate: s.today,
        slotTime: "11:00",
        customerName: "Dee Posit",
        customerEmail: "dee@test.local",
        customerPhone: "",
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "This time slot is no longer available" });
    expect(await isClaimed(s.shop, s.staff, s.today, "11:00")).toBe(0);
  });
});
