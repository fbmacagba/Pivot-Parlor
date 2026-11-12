/**
 * The admin overview's "Staff on shift" (stats.active_staff): active staff
 * scheduled for the shop's today, plus anyone with a live booking today.
 * Counting bookings alone showed 0 on a quiet morning with the whole team in.
 *
 * schedules.day_of_week is Monday-first (0=Mon..6=Sun). 2 July 2026 is a
 * Thursday (3); 1 July a Wednesday (2).
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedScheduleDay, seedShop, seedStaff } from "./helpers";
import { adminToken } from "./audit-helpers";

const WEDNESDAY = 2;
const THURSDAY = 3;

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock the worker reads. Call before minting tokens. */
function at(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function seedBookingToday(shopId: string, staffId: string, date: string, status = "confirmed"): Promise<void> {
  const serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)",
  )
    .bind(serviceId, shopId)
    .run();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, '10:00', '10:30', ?, 2500)`,
  )
    .bind(crypto.randomUUID(), shopId, staffId, serviceId, date, status)
    .run();
}

async function staffOnShift(shopId: string): Promise<number> {
  const { token } = await adminToken(shopId);
  const res = await dispatch("GET", `/api/shops/${shopId}/stats`, { headers: authHeaders(token) });
  expect(res.status).toBe(200);
  return (await res.json<{ data: { active_staff: number } }>()).data.active_staff;
}

describe("Staff on shift", () => {
  it("counts staff scheduled today who have no bookings", async () => {
    at("2026-07-02T10:00:00Z"); // Thursday, 11:00 in London
    const shopId = await seedShop("On Shift Scheduled");
    const thursday = await seedStaff(shopId);
    const wednesdayOnly = await seedStaff(shopId);
    await seedScheduleDay(shopId, thursday, THURSDAY);
    await seedScheduleDay(shopId, wednesdayOnly, WEDNESDAY);
    expect(await staffOnShift(shopId)).toBe(1);
  });

  it("counts each person once, and someone booked off-schedule too", async () => {
    at("2026-07-02T10:00:00Z");
    const shopId = await seedShop("On Shift Union");
    const scheduledAndBooked = await seedStaff(shopId);
    const bookedOnly = await seedStaff(shopId);
    await seedScheduleDay(shopId, scheduledAndBooked, THURSDAY);
    await seedBookingToday(shopId, scheduledAndBooked, "2026-07-02");
    await seedBookingToday(shopId, bookedOnly, "2026-07-02");
    expect(await staffOnShift(shopId)).toBe(2);
  });

  it("leaves out a day switched off, a deactivated staff member and a cancelled booking", async () => {
    at("2026-07-02T10:00:00Z");
    const shopId = await seedShop("On Shift Exclusions");
    const dayOff = await seedStaff(shopId);
    const gone = await seedStaff(shopId);
    const cancelled = await seedStaff(shopId);
    await seedScheduleDay(shopId, dayOff, THURSDAY);
    await env.DB.prepare("UPDATE schedules SET is_active = 0 WHERE staff_id = ?").bind(dayOff).run();
    await seedScheduleDay(shopId, gone, THURSDAY);
    await env.DB.prepare("UPDATE staff SET is_active = 0 WHERE id = ?").bind(gone).run();
    await seedBookingToday(shopId, cancelled, "2026-07-02", "cancelled");
    expect(await staffOnShift(shopId)).toBe(0);
  });

  it("uses the shop's weekday just after midnight London time", async () => {
    at("2026-07-01T23:30:00Z"); // Wednesday in UTC, 00:30 Thursday in London
    const thursdayShop = await seedShop("On Shift Midnight Thu");
    await seedScheduleDay(thursdayShop, await seedStaff(thursdayShop), THURSDAY);
    const wednesdayShop = await seedShop("On Shift Midnight Wed");
    await seedScheduleDay(wednesdayShop, await seedStaff(wednesdayShop), WEDNESDAY);
    expect(await staffOnShift(thursdayShop)).toBe(1);
    expect(await staffOnShift(wednesdayShop)).toBe(0);
  });

  it("counts another shop's staff never", async () => {
    at("2026-07-02T10:00:00Z");
    const shopId = await seedShop("On Shift Mine");
    const otherShop = await seedShop("On Shift Theirs");
    const theirs = await seedStaff(otherShop);
    await seedScheduleDay(otherShop, theirs, THURSDAY);
    expect(await staffOnShift(shopId)).toBe(0);
  });
});
