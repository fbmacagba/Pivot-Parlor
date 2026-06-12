import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedScheduleDay, seedShop, seedStaff } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";

// seedScheduleDay seeds day_of_week=1 (Monday) 09:00-17:00.
const MONDAY = "2027-01-04";

let shopId: string;
let staffId: string;
let serviceId: string;

async function insertBooking(start: string, end: string, status = "confirmed") {
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount, commission)
     VALUES (?, ?, ?, ?, 'C', 'c@test.local', ?, ?, ?, ?, 10, 1)`
  )
    .bind(crypto.randomUUID(), shopId, staffId, serviceId, MONDAY, start, end, status)
    .run();
}

beforeAll(async () => {
  shopId = await seedShop("Slot Shop");
  staffId = await seedStaff(shopId);
  await seedScheduleDay(shopId, staffId);
  serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price) VALUES (?, ?, 'Cut', 30, 25)"
  )
    .bind(serviceId, shopId)
    .run();
});

describe("getAvailableSlots", () => {
  it("generates 30-minute-step slots inside the schedule window", async () => {
    const slots = await getAvailableSlots(shopId, staffId, MONDAY, 30, env.DB, env.KV);
    // 09:00-17:00 with 30-min duration at 30-min steps = 16 slots
    expect(slots.length).toBe(16);
    expect(slots[0]!.start_time).toBe(`${MONDAY}T09:00:00.000Z`);
    expect(slots.at(-1)!.end_time).toBe(`${MONDAY}T17:00:00.000Z`);
    expect(slots.every((s) => s.is_available)).toBe(true);
  });

  it("never emits a slot that would run past the window end", async () => {
    const slots = await getAvailableSlots(shopId, staffId, MONDAY, 45, env.DB, env.KV);
    for (const s of slots) {
      expect(s.end_time <= `${MONDAY}T17:00:00.000Z`).toBe(true);
    }
    // last 45-min slot must start at 16:00 (16:30 would end 17:15)
    expect(slots.at(-1)!.start_time).toBe(`${MONDAY}T16:00:00.000Z`);
  });

  it("marks slots overlapping an active booking as unavailable", async () => {
    await insertBooking(`${MONDAY}T10:00:00.000Z`, `${MONDAY}T11:00:00.000Z`);
    // distinct duration to bypass the KV cache key from prior tests
    const slots = await getAvailableSlots(shopId, staffId, MONDAY, 60, env.DB, env.KV);
    const at = (t: string) => slots.find((s) => s.start_time === `${MONDAY}T${t}:00.000Z`)!;
    expect(at("10:00").is_available).toBe(false);
    expect(at("09:30").is_available).toBe(false); // 09:30+60min overlaps 10:00-11:00
    expect(at("09:00").is_available).toBe(true);
    expect(at("11:00").is_available).toBe(true);
  });

  it("ignores cancelled bookings", async () => {
    await insertBooking(`${MONDAY}T14:00:00.000Z`, `${MONDAY}T14:30:00.000Z`, "cancelled");
    const slots = await getAvailableSlots(shopId, staffId, MONDAY, 15, env.DB, env.KV);
    const slot = slots.find((s) => s.start_time === `${MONDAY}T14:00:00.000Z`)!;
    expect(slot.is_available).toBe(true);
  });

  it("returns [] for a day with no schedule", async () => {
    const tuesday = "2027-01-05";
    const slots = await getAvailableSlots(shopId, staffId, tuesday, 30, env.DB, env.KV);
    expect(slots).toEqual([]);
  });

  it("serves the cached result within the KV TTL", async () => {
    const first = await getAvailableSlots(shopId, staffId, MONDAY, 20, env.DB, env.KV);
    await insertBooking(`${MONDAY}T15:00:00.000Z`, `${MONDAY}T15:20:00.000Z`);
    const second = await getAvailableSlots(shopId, staffId, MONDAY, 20, env.DB, env.KV);
    // same payload despite the new booking — cache hit (5-min TTL)
    expect(second).toEqual(first);
  });
});
