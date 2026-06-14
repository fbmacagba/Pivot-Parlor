import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedScheduleDay, seedShop, seedStaff } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";

// seedScheduleDay seeds day_of_week=0 (Monday, Monday-first convention) 09:00-17:00.
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

  it("shifts slot instants by the BST offset in summer (T6.6)", async () => {
    // 2027-07-05 is a Monday in BST (Europe/London, the shop default).
    // The 09:00-17:00 local schedule must map to 08:00-16:00 UTC.
    const JULY_MONDAY = "2027-07-05";
    const slots = await getAvailableSlots(shopId, staffId, JULY_MONDAY, 30, env.DB, env.KV);
    expect(slots.length).toBe(16);
    expect(slots[0]!.start_time).toBe(`${JULY_MONDAY}T08:00:00.000Z`);
    expect(slots.at(-1)!.end_time).toBe(`${JULY_MONDAY}T16:00:00.000Z`);
  });

  it("looks up the schedule using the Monday-first day_of_week convention", async () => {
    // The shared staff only has a Monday (day 0) schedule. Add a Wednesday (day 2)
    // schedule and confirm a real Wednesday resolves to it — proving getUTCDay
    // (Sun=0) is converted to the stored Monday-first convention, not off by one.
    await seedScheduleDay(shopId, staffId, 2); // Wednesday
    const WEDNESDAY = "2027-01-06"; // getUTCDay()=3 -> Monday-first 2
    const wed = await getAvailableSlots(shopId, staffId, WEDNESDAY, 30, env.DB, env.KV);
    expect(wed.length).toBe(16);
    // Thursday has no schedule -> empty (guards against the other-direction off-by-one)
    const THURSDAY = "2027-01-07";
    const thu = await getAvailableSlots(shopId, staffId, THURSDAY, 30, env.DB, env.KV);
    expect(thu).toEqual([]);
  });
});

describe("getAvailableSlots for a non-UTC shop (booking_date straddles UTC midnight)", () => {
  let nyShop: string;
  let nyStaff: string;
  let nyService: string;
  const NY_MONDAY = "2027-07-05"; // EDT (UTC-4)

  beforeAll(async () => {
    nyShop = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO shops (id, shop_number, slug, name, owner_email, timezone)
       VALUES (?, ?, ?, ?, ?, 'America/New_York')`
    )
      .bind(nyShop, Math.floor(Math.random() * 1_000_000_000), `ny-${nyShop.slice(0, 8)}`, "NY Shop", `${nyShop}@t.local`)
      .run();
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id) VALUES (?, 'S', ?, 'x', 'staff', ?)"
    )
      .bind(userId, `${userId}@t.local`, nyShop)
      .run();
    nyStaff = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO staff (id, shop_id, user_id, display_name) VALUES (?, ?, ?, 'NY Barber')"
    )
      .bind(nyStaff, nyShop, userId)
      .run();
    nyService = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price) VALUES (?, ?, 'Cut', 30, 25)"
    )
      .bind(nyService, nyShop)
      .run();
    // Evening hours 20:00-23:00 local Monday -> UTC 2027-07-06T00:00Z..03:00Z
    await env.DB.prepare(
      `INSERT INTO schedules (id, shop_id, staff_id, day_of_week, start_time, end_time)
       VALUES (?, ?, ?, 0, '20:00', '23:00')`
    )
      .bind(crypto.randomUUID(), nyShop, nyStaff)
      .run();
  });

  it("marks an evening slot booked even though its UTC date is the next day", async () => {
    // Book NY-local 20:30 = 2027-07-06T00:30Z..01:00Z; booking_date is the UTC
    // date '2027-07-06', NOT the local schedule date '2027-07-05'.
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
         booking_date, start_time, end_time, status, amount, commission)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2027-07-06',
               '2027-07-06T00:30:00.000Z', '2027-07-06T01:00:00.000Z', 'confirmed', 25, 2.5)`
    )
      .bind(crypto.randomUUID(), nyShop, nyStaff, nyService)
      .run();

    const slots = await getAvailableSlots(nyShop, nyStaff, NY_MONDAY, 30, env.DB, env.KV);
    const at = (utc: string) => slots.find((s) => s.start_time === utc)!;
    // 20:30 local == 00:30Z next day — must be unavailable (was shown free before the fix)
    expect(at("2027-07-06T00:30:00.000Z").is_available).toBe(false);
    expect(at("2027-07-06T00:00:00.000Z").is_available).toBe(true); // 20:00 still free
  });
});
