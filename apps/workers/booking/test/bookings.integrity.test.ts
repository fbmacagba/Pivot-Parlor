import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedShop, seedStaff, seedScheduleDay } from "./helpers";
import { dispatch } from "./request";
import { createBooking, checkSlotConflict } from "../src/db/queries";

let shopA: string, shopB: string;
let staffA: string, staffB: string;
let serviceA: string;

async function seedService(shopId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, ?, 30, 2500)"
  )
    .bind(id, shopId, name)
    .run();
  return id;
}

function bookingPayload(overrides: Record<string, unknown> = {}) {
  return {
    shop_id: shopA,
    staff_id: staffA,
    service_id: serviceA,
    customer_name: "Cust",
    customer_email: "cust@test.local",
    start_time: "2027-01-04T10:00:00.000Z",
    ...overrides,
  };
}

function directBooking(staffId: string, startTime: string, status = "pending") {
  return {
    id: crypto.randomUUID(),
    shop_id: shopA,
    staff_id: staffId,
    service_id: serviceA,
    customer_name: "Direct",
    customer_email: "direct@test.local",
    booking_date: startTime.slice(0, 10),
    start_time: startTime,
    end_time: startTime,
    amount_pence: 2500,
    commission_pence: 250,
    ...(status ? {} : {}),
  };
}

beforeAll(async () => {
  shopA = await seedShop("Shop A");
  shopB = await seedShop("Shop B");
  staffA = await seedStaff(shopA);
  staffB = await seedStaff(shopB);
  serviceA = await seedService(shopA, "Cut A");
  // Working hours for staffA every weekday so the route's slot validation
  // accepts the on-grid 09:00-17:00 (winter UTC) slots used below.
  for (let d = 0; d < 7; d++) await seedScheduleDay(shopA, staffA, d);
});

describe("booking input validation", () => {
  it("rejects an unparseable start_time with 400 (was 500)", async () => {
    const res = await dispatch("POST", "/public/bookings", {
      body: bookingPayload({ start_time: "not-a-date" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("rejects a staff_id belonging to a different shop with 404", async () => {
    const res = await dispatch("POST", "/public/bookings", {
      body: bookingPayload({ staff_id: staffB }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a booking for valid input", async () => {
    const res = await dispatch("POST", "/public/bookings", {
      body: bookingPayload({ start_time: "2027-01-04T09:00:00.000Z" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { id: string } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBeTruthy();
  });
});

describe("double-booking prevention", () => {
  it("DB rejects a second active booking for the same staff and start time", async () => {
    const start = "2027-02-01T10:00:00.000Z";
    await createBooking(env.DB, directBooking(staffA, start));
    await expect(createBooking(env.DB, directBooking(staffA, start))).rejects.toThrow(
      /UNIQUE constraint failed/
    );
  });

  it("route returns 409 when the slot is already taken", async () => {
    const start = "2027-02-02T10:00:00.000Z";
    const first = await dispatch("POST", "/public/bookings", {
      body: bookingPayload({ start_time: start }),
    });
    expect(first.status).toBe(201);

    const second = await dispatch("POST", "/public/bookings", {
      body: bookingPayload({ start_time: start }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { success: boolean; error: string };
    // Either the slot reads as unavailable, or the unique-index catch fires —
    // both are correct rejections of the same-slot rebooking.
    expect(body.error).toMatch(/available/);
  });

  it("a cancelled booking frees its slot", async () => {
    const start = "2027-02-03T10:00:00.000Z";
    const booking = directBooking(staffA, start);
    await createBooking(env.DB, booking);
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?")
      .bind(booking.id)
      .run();
    await expect(createBooking(env.DB, directBooking(staffA, start))).resolves.toBeTruthy();
  });

  it("accepts the in_progress status (staff 'mark in progress' must not violate the CHECK)", async () => {
    const start = "2027-04-01T10:00:00.000Z";
    const booking = directBooking(staffA, start);
    await createBooking(env.DB, booking);
    await expect(
      env.DB.prepare("UPDATE bookings SET status = 'in_progress' WHERE id = ?").bind(booking.id).run()
    ).resolves.toBeTruthy();
    const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?")
      .bind(booking.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("in_progress");
  });

  it("checkSlotConflict catches an overlap that straddles UTC midnight onto a different date", async () => {
    // Booking A spans 23:45-00:15 (booking_date 2027-03-15); a candidate B at
    // 00:00-00:30 has a different start_time (so the unique index won't catch
    // it) and a different UTC booking_date (so a single-UTC-date conflict query
    // would miss the overlap). checkSlotConflict must still detect it. Tested at
    // the DB layer: 23:45 is intentionally off the bookable 30-min slot grid.
    await createBooking(env.DB, {
      ...directBooking(staffA, "2027-03-15T23:45:00.000Z"),
      end_time: "2027-03-16T00:15:00.000Z",
      booking_date: "2027-03-15",
    });
    const conflict = await checkSlotConflict(
      env.DB,
      staffA,
      "2027-03-16T00:00:00.000Z",
      "2027-03-16T00:30:00.000Z"
    );
    expect(conflict).toBeTruthy();
  });
});
