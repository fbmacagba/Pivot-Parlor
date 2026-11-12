/**
 * "Today" and the hour of day are the shop's (Europe/London unless the shop
 * says otherwise), not UTC's. In British Summer Time, 23:30 UTC on 1 July is
 * already 00:30 on 2 July in the shop, and a 09:00 UTC booking starts at 10:00.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { adminToken } from "./audit-helpers";

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock the worker reads. Call before minting tokens. */
function at(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

const LONDON_JUST_AFTER_MIDNIGHT = "2026-07-01T23:30:00Z"; // 00:30 on 2 July in London

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)",
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedBooking(
  shopId: string,
  staffId: string,
  serviceId: string,
  opts: { date: string; start: string; email?: string; status?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', ?, ?, ?, ?, ?, 2500)`,
  )
    .bind(id, shopId, staffId, serviceId, opts.email ?? "cust@test.local", opts.date, opts.start, opts.start, opts.status ?? "confirmed")
    .run();
  return id;
}

async function shopWithStaff(name: string) {
  const shopId = await seedShop(name);
  const staffId = await seedStaff(shopId);
  const serviceId = await seedService(shopId);
  return { shopId, staffId, serviceId };
}

async function staffToken(staffId: string, shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
  return tokenFor(row!.user_id, "staff", shopId);
}

describe("admin overview stats", () => {
  it("counts the shop's today, which starts at midnight London time", async () => {
    at(LONDON_JUST_AFTER_MIDNIGHT);
    const { shopId, staffId, serviceId } = await shopWithStaff("Stats London");
    await seedBooking(shopId, staffId, serviceId, { date: "2026-07-02", start: "2026-07-02T09:00:00.000Z" });
    const { token } = await adminToken(shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/stats`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const { data } = await res.json<{ data: { date: string; todays_bookings: number } }>();
    expect(data.date).toBe("2026-07-02");
    expect(data.todays_bookings).toBe(1);
  });

  it("uses the shop's own time zone when it has one", async () => {
    at("2026-07-02T02:00:00Z"); // 03:00 on 2 July in London, 22:00 on 1 July in New York
    const shopId = await seedShop("Stats New York");
    await env.DB.prepare("UPDATE shops SET timezone = 'America/New_York' WHERE id = ?").bind(shopId).run();
    const { token } = await adminToken(shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/stats`, { headers: authHeaders(token) });
    const { data } = await res.json<{ data: { date: string } }>();
    expect(data.date).toBe("2026-07-01");
  });
});

describe("staff's own day", () => {
  it("today's list is the shop's today", async () => {
    at(LONDON_JUST_AFTER_MIDNIGHT);
    const { shopId, staffId, serviceId } = await shopWithStaff("Staff Today");
    const id = await seedBooking(shopId, staffId, serviceId, { date: "2026-07-02", start: "2026-07-02T09:00:00.000Z" });
    const token = await staffToken(staffId, shopId);
    const res = await dispatch("GET", "/api/staff/me/today", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const { data } = await res.json<{ data: Array<{ id: string }> }>();
    expect(data.map((b) => b.id)).toEqual([id]);
  });

  it("yesterday's booking is past, not upcoming, from midnight London time", async () => {
    at(LONDON_JUST_AFTER_MIDNIGHT);
    const { shopId, staffId, serviceId } = await shopWithStaff("Staff Past");
    const id = await seedBooking(shopId, staffId, serviceId, { date: "2026-07-01", start: "2026-07-01T09:00:00.000Z" });
    const token = await staffToken(staffId, shopId);
    const past = await dispatch("GET", "/api/staff/me/bookings?filter=past", { headers: authHeaders(token) });
    const upcoming = await dispatch("GET", "/api/staff/me/bookings?filter=upcoming", { headers: authHeaders(token) });
    expect((await past.json<{ data: Array<{ id: string }> }>()).data.map((b) => b.id)).toEqual([id]);
    expect((await upcoming.json<{ data: Array<{ id: string }> }>()).data).toEqual([]);
  });
});

describe("customer's own bookings", () => {
  it("yesterday's booking is past from midnight London time", async () => {
    at(LONDON_JUST_AFTER_MIDNIGHT);
    const { shopId, staffId, serviceId } = await shopWithStaff("Customer Past");
    const userId = await seedUser("customer", null);
    await env.DB.prepare("UPDATE platform_users SET email_verified = 1 WHERE id = ?").bind(userId).run();
    const email = (await env.DB.prepare("SELECT email FROM platform_users WHERE id = ?").bind(userId).first<{ email: string }>())!.email;
    const id = await seedBooking(shopId, staffId, serviceId, { date: "2026-07-01", start: "2026-07-01T09:00:00.000Z", email });
    const token = await tokenFor(userId, "customer", null);
    const res = await dispatch("GET", "/api/me/bookings", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const { data } = await res.json<{ data: { upcoming: Array<{ id: string }>; past: Array<{ id: string }> } }>();
    expect(data.upcoming).toEqual([]);
    expect(data.past.map((b) => b.id)).toEqual([id]);
  });
});

describe("reviews", () => {
  it("the gate goes by the shop's day: from midnight London time, today's booking is reviewable", async () => {
    at(LONDON_JUST_AFTER_MIDNIGHT); // already 2 July in London, still 1 July in UTC
    const { shopId, staffId, serviceId } = await shopWithStaff("Review Today");
    const id = await seedBooking(shopId, staffId, serviceId, { date: "2026-07-02", start: "2026-07-02T00:15:00.000Z" });
    const res = await dispatch("POST", `/api/shops/${shopId}/reviews`, {
      headers: { "CF-Connecting-IP": "203.0.113.90" },
      body: { customer_name: "Happy", rating: 5, body: "Great cut", booking_id: id },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe("analytics", () => {
  it("the 12-month window ends on the shop's today", async () => {
    at("2026-09-30T23:30:00Z"); // 00:30 on 1 October in London
    const shopId = await seedShop("Analytics Window");
    const { token } = await adminToken(shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/analytics`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const { data } = await res.json<{ data: { period: { from: string; to: string } } }>();
    expect(data.period).toEqual({ from: "2025-11-01", to: "2026-10-01" });
  });

  it("peak hours are the shop's hours: summer instants move an hour, walk-in clock times stay", async () => {
    const { shopId, staffId, serviceId } = await shopWithStaff("Analytics Peak");
    await seedBooking(shopId, staffId, serviceId, { date: "2026-07-01", start: "2026-07-01T09:00:00.000Z" }); // 10:00 BST
    await seedBooking(shopId, staffId, serviceId, { date: "2026-11-12", start: "2026-11-12T09:00:00.000Z" }); // 09:00 GMT
    await seedBooking(shopId, staffId, serviceId, { date: "2026-11-13", start: "09:30" }); // a walk-in's own clock
    await seedBooking(shopId, staffId, serviceId, { date: "2026-11-14", start: "2026-11-14T15:00:00.000Z", status: "cancelled" });
    const { token } = await adminToken(shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/analytics`, { headers: authHeaders(token) });
    const { data } = await res.json<{ data: { peak_hours: Array<{ hour: number; booking_count: number }>; peak_days: Array<{ dow: number; booking_count: number }> } }>();
    expect(data.peak_hours).toEqual([
      { hour: 9, booking_count: 2 },
      { hour: 10, booking_count: 1 },
    ]);
    // Peak days come from booking_date and are unchanged: Wed 1 Jul, Thu 12 Nov, Fri 13 Nov.
    expect(data.peak_days).toEqual([
      { dow: 3, booking_count: 1 },
      { dow: 4, booking_count: 1 },
      { dow: 5, booking_count: 1 },
    ]);
  });
});
