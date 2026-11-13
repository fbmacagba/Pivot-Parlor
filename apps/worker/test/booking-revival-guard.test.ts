/**
 * A cancelled or no-show booking holds no time, so the time can be booked
 * again. Setting it back to an active status (an admin's Confirmed or
 * Completed, a staff member's in progress or completed) must first check the
 * time is still free, or two bookings hold one barber. The refusal is a 409
 * with a clear message, and nothing is written: no status change and no audit
 * entry (the guard rolls back the whole batch).
 *
 * The clash rule is the one every booking path uses (@repo/utils
 * bookingTimes): instant rows compare as instants, the shop's "HH:MM" rows on
 * its wall clock.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, gapRowsFor } from "./audit-helpers";

const DAY = "2099-01-15"; // London = UTC
const REFUSED = "Another booking now holds this time, so this booking cannot be reinstated.";

type Times = { start_time: string; end_time: string; booking_date?: string };

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)",
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedBooking(shop: string, staff: string, service: string, status: string, t: Times): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, ?, 2500)`,
  )
    .bind(id, shop, staff, service, t.booking_date ?? DAY, t.start_time, t.end_time, status)
    .run();
  return id;
}

const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

async function statusOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function shopWithStaff(name: string) {
  const shop = await seedShop(name);
  const staff = await seedStaff(shop);
  const service = await seedService(shop);
  const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
  return { shop, staff, service, admin };
}

let lastRequestId = "";

async function adminSets(s: { shop: string; admin: string }, bookingId: string, status: string) {
  const res = await dispatch("PUT", `/api/shops/${s.shop}/bookings/${bookingId}/status`, {
    headers: authHeaders(s.admin),
    body: { status },
  });
  lastRequestId = res.headers.get("X-Request-Id") ?? "";
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string } };
}

describe("an admin reinstating a booking", () => {
  it("cannot re-confirm a cancelled booking whose time another booking now holds", async () => {
    const s = await shopWithStaff("Revive Overlap");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:15"), end_time: at("10:45") });

    const res = await adminSets(s, cancelled, "confirmed");
    expect(res).toEqual({ status: 409, body: { success: false, error: REFUSED } });
    expect(await statusOf(cancelled)).toBe("cancelled");
    expect(await entriesFor({ action: "booking.status", entityId: cancelled })).toEqual([]);
    expect(await gapRowsFor(lastRequestId), "no audit.gap row for a refusal").toBe(0);
  });

  it("cannot, across the two time shapes: a cancelled walk-in at 10:00 vs an online booking at 10:00", async () => {
    const s = await shopWithStaff("Revive Cross Shape");
    const walkIn = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: "10:00", end_time: "10:30" });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await adminSets(s, walkIn, "confirmed")).status).toBe(409);
    expect(await statusOf(walkIn)).toBe("cancelled");
  });

  it("cannot mark a no-show completed over another booking", async () => {
    const s = await shopWithStaff("Revive No Show");
    const noShow = await seedBooking(s.shop, s.staff, s.service, "no_show", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await adminSets(s, noShow, "completed")).status).toBe(409);
    expect(await statusOf(noShow)).toBe("no_show");
  });

  it("re-confirms a cancelled booking whose time is still free", async () => {
    const s = await shopWithStaff("Revive Free");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:30"), end_time: at("11:00") }); // back to back
    const otherStaff = await seedStaff(s.shop);
    await seedBooking(s.shop, otherStaff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await adminSets(s, cancelled, "confirmed")).status).toBe(200);
    expect(await statusOf(cancelled)).toBe("confirmed");
    expect(await entriesFor({ action: "booking.status", entityId: cancelled })).toHaveLength(1);
  });

  it("changes an active booking's status as before, even over an old overlap", async () => {
    const s = await shopWithStaff("Revive Active");
    const first = await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:15"), end_time: at("10:45") });

    expect((await adminSets(s, first, "completed")).status).toBe(200);
    expect(await statusOf(first)).toBe("completed");
  });

  it("marks a cancelled booking a no-show without a check (it stays inactive)", async () => {
    const s = await shopWithStaff("Revive To No Show");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await adminSets(s, cancelled, "no_show")).status).toBe(200);
    expect(await statusOf(cancelled)).toBe("no_show");
  });
});

describe("a booking made between the check and the write", () => {
  /** env whose DB inserts `competitor` just before the first batch runs (after the route's own check). */
  function racing(competitor: () => Promise<unknown>) {
    const real = env.DB;
    let fired = 0;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (fired++ === 0) await competitor();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { env: { ...env, DB: db }, fired: () => fired };
  }

  it("rolls the reinstatement back: no double booking, no audit entry", async () => {
    const s = await shopWithStaff("Revive Race");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });
    const race = racing(() =>
      seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:15"), end_time: at("10:45") }),
    );

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://worker.test/api/shops/${s.shop}/bookings/${cancelled}/status`, {
        method: "PUT",
        headers: { ...authHeaders(s.admin), "Content-Type": "application/json" },
        body: JSON.stringify({ status: "confirmed" }),
      }) as never,
      race.env as never,
      ctx as never,
    );
    await waitOnExecutionContext(ctx);

    expect(race.fired()).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: REFUSED });
    expect(await statusOf(cancelled)).toBe("cancelled");
    expect(await entriesFor({ action: "booking.status", entityId: cancelled })).toEqual([]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id") ?? ""), "no audit.gap row for a refusal").toBe(0);
  });
});

describe("a staff member reinstating their own booking", () => {
  async function staffSets(s: { staff: string; shop: string }, bookingId: string, status: string) {
    const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(s.staff).first<{ user_id: string }>();
    const token = await tokenFor(row!.user_id, "staff", s.shop);
    const res = await dispatch("PUT", `/api/staff/me/bookings/${bookingId}/status`, {
      headers: authHeaders(token),
      body: { status },
    });
    return { status: res.status, body: (await res.json()) as { success: boolean; error?: string } };
  }

  it("cannot mark a cancelled booking in progress when its time is taken", async () => {
    const s = await shopWithStaff("Staff Revive Overlap");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });
    await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:15"), end_time: at("10:45") });

    expect(await staffSets(s, cancelled, "in_progress")).toEqual({ status: 409, body: { success: false, error: REFUSED } });
    expect(await statusOf(cancelled)).toBe("cancelled");
  });

  it("marks a cancelled booking completed when its time is free", async () => {
    const s = await shopWithStaff("Staff Revive Free");
    const cancelled = await seedBooking(s.shop, s.staff, s.service, "cancelled", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await staffSets(s, cancelled, "completed")).status).toBe(200);
    expect(await statusOf(cancelled)).toBe("completed");
  });

  it("moves an active booking along as before", async () => {
    const s = await shopWithStaff("Staff Active");
    const booking = await seedBooking(s.shop, s.staff, s.service, "confirmed", { start_time: at("10:00"), end_time: at("10:30") });

    expect((await staffSets(s, booking, "in_progress")).status).toBe(200);
    expect(await statusOf(booking)).toBe("in_progress");
  });
});
