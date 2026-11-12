import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedScheduleDay, seedService, seedShop, seedStaff } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";
import { addMinutesToHm } from "../src/lib/time";

/**
 * Walk-in and deposit bookings (POST /booking/shops/:shopId/walk-ins and
 * /bookings) store the shop's own clock reading in bookings.start_time and
 * end_time ("09:30", the bw_availability slot_time) with booking_date = the
 * slot date. Online bookings store instants ("2099-07-15T08:30:00.000Z").
 * Online availability and the write-time conflict check must read both, or
 * a walk-in's chair shows free online and can be booked again.
 *
 * The date is in British Summer Time, so "09:30" is 08:30 UTC: a fix that
 * read the clock reading as UTC would block the wrong slot.
 */
const SUMMER_DAY = "2099-07-15";
const NINE_THIRTY_LONDON = `${SUMMER_DAY}T08:30:00.000Z`;
const TEN_THIRTY_LONDON = `${SUMMER_DAY}T09:30:00.000Z`;

async function bookableShop(name: string) {
  const shop = await seedShop(name);
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d); // 09:00-17:00 London
  return { shop, staff, service };
}

/** A booking row exactly as the walk-in and deposit routes write it. */
async function seedWallClockBooking(
  shop: string,
  staff: string,
  service: string,
  date: string,
  start: string,
  durationMin = 30,
  status = "confirmed",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone,
       booking_date, start_time, end_time, status, notes, amount_pence, commission_pence)
     VALUES (?, ?, ?, ?, 'Walk In', 'walkin+test@pivotparlor.invalid', '', ?, ?, ?, ?, NULL, 2500, 250)`,
  )
    .bind(crypto.randomUUID(), shop, staff, service, date, start, addMinutesToHm(start, durationMin), status)
    .run();
}

function bookOnline(shop: string, staff: string, service: string, date: string, startTime: string) {
  return dispatch("POST", "/public/bookings", {
    body: {
      shop_id: shop,
      staff_id: staff,
      service_id: service,
      date,
      start_time: startTime,
      customer_name: "Casey",
      customer_email: "casey@test.local",
    },
  });
}

describe("walk-in and deposit bookings in online availability", () => {
  it("shows the walk-in's time as taken, in the shop's own time", async () => {
    const { shop, staff, service } = await bookableShop("Wall Clock Slots");
    await seedWallClockBooking(shop, staff, service, SUMMER_DAY, "09:30");

    const slots = await getAvailableSlots(shop, staff, SUMMER_DAY, 30, env.DB, env.KV);
    const at = (instant: string) => slots.find((s) => s.start_time === instant)!;
    expect(at(NINE_THIRTY_LONDON).is_available).toBe(false);
    expect(at(TEN_THIRTY_LONDON).is_available).toBe(true);
    expect(at(`${SUMMER_DAY}T08:00:00.000Z`).is_available).toBe(true); // 09:00 London
  });

  it("refuses an online booking on top of a walk-in made after the slot list was cached", async () => {
    const { shop, staff, service } = await bookableShop("Wall Clock Conflict");
    // The customer loaded the times before the walk-in arrived (5 minute cache).
    await getAvailableSlots(shop, staff, SUMMER_DAY, 30, env.DB, env.KV);
    await seedWallClockBooking(shop, staff, service, SUMMER_DAY, "09:30");

    const res = await bookOnline(shop, staff, service, SUMMER_DAY, NINE_THIRTY_LONDON);
    expect(res.status).toBe(409);
  });

  it("still accepts an online booking for a different time that day", async () => {
    const { shop, staff, service } = await bookableShop("Wall Clock Free");
    await seedWallClockBooking(shop, staff, service, SUMMER_DAY, "09:30");

    const res = await bookOnline(shop, staff, service, SUMMER_DAY, TEN_THIRTY_LONDON);
    expect(res.status).toBe(201);
  });

  it("does not let an evening walk-in on another day block that staff member's online bookings", async () => {
    const { shop, staff, service } = await bookableShop("Wall Clock Other Day");
    // 19:30 to 20:00 on an earlier day. Compared as text with an instant,
    // "20:00" sorts after "2099-...", which used to read as an overlap.
    await seedWallClockBooking(shop, staff, service, "2099-07-01", "19:30");

    const res = await bookOnline(shop, staff, service, SUMMER_DAY, TEN_THIRTY_LONDON);
    expect(res.status).toBe(201);
  });

  it("ignores a cancelled walk-in and another staff member's walk-in", async () => {
    const { shop, staff, service } = await bookableShop("Wall Clock Ignored");
    const colleague = await seedStaff(shop);
    await seedWallClockBooking(shop, staff, service, SUMMER_DAY, "09:30", 30, "cancelled");
    await seedWallClockBooking(shop, colleague, service, SUMMER_DAY, "09:30");

    const slots = await getAvailableSlots(shop, staff, SUMMER_DAY, 30, env.DB, env.KV);
    expect(slots.find((s) => s.start_time === NINE_THIRTY_LONDON)!.is_available).toBe(true);
    const res = await bookOnline(shop, staff, service, SUMMER_DAY, NINE_THIRTY_LONDON);
    expect(res.status).toBe(201);
  });
});
