/**
 * Staff View for a developer: the /api/staff/me/* screens are one staff
 * member's own day, and a developer has no staff record. A developer names
 * the person with ?staffId= and reads exactly what they would see. It is
 * read-only: the writes refuse a developer. Everyone else always gets their
 * own record, whatever the query string says.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedScheduleDay, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
});

const TODAY = "2026-07-02"; // a Thursday
const NOW = "2026-07-02T08:00:00Z"; // 09:00 in London

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)",
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedBooking(shopId: string, staffId: string, serviceId: string, date: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, 'confirmed', 2500)`,
  )
    .bind(id, shopId, staffId, serviceId, date, `${date}T09:00:00.000Z`, `${date}T09:30:00.000Z`)
    .run();
  return id;
}

async function seedTimeOff(shopId: string, staffId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO staff_time_off (id, shop_id, staff_id, from_date, to_date, reason) VALUES (?, ?, ?, '2026-08-03', '2026-08-04', 'Holiday')",
  )
    .bind(id, shopId, staffId)
    .run();
  return id;
}

async function staffToken(staffId: string, shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
  return tokenFor(row!.user_id, "staff", shopId);
}

async function developerToken(): Promise<string> {
  return tokenFor(await seedUser("developer", null), "developer", null);
}

/** A shop with one staff member who has a booking today, a schedule and a time-off request. */
async function busyStaff(name: string) {
  const shopId = await seedShop(name);
  const staffId = await seedStaff(shopId);
  const serviceId = await seedService(shopId);
  const bookingId = await seedBooking(shopId, staffId, serviceId, TODAY);
  await seedScheduleDay(shopId, staffId, 3);
  const timeOffId = await seedTimeOff(shopId, staffId);
  return { shopId, staffId, serviceId, bookingId, timeOffId };
}

async function ids(path: string, token: string): Promise<string[]> {
  const res = await dispatch("GET", path, { headers: authHeaders(token) });
  expect(res.status).toBe(200);
  const { data } = await res.json<{ data: Array<{ id?: string; day_of_week?: number }> }>();
  return data.map((row) => row.id ?? `day-${row.day_of_week}`);
}

function at(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("Staff View for a developer", () => {
  it("shows the chosen staff member's day, bookings, schedule and time off", async () => {
    at(NOW);
    const s = await busyStaff("Dev Views Staff");
    const dev = await developerToken();
    const q = `staffId=${s.staffId}`;
    expect(await ids(`/api/staff/me/today?${q}`, dev)).toEqual([s.bookingId]);
    expect(await ids(`/api/staff/me/bookings?filter=upcoming&${q}`, dev)).toEqual([s.bookingId]);
    expect(await ids(`/api/staff/me/schedule?${q}`, dev)).toEqual(["day-3"]);
    expect(await ids(`/api/staff/me/time-off?${q}`, dev)).toEqual([s.timeOffId]);

    const detail = await dispatch("GET", `/api/staff/me/bookings/${s.bookingId}?${q}`, { headers: authHeaders(dev) });
    expect(detail.status).toBe(200);
  });

  it("shows nothing until a staff member is chosen, or for one who has left", async () => {
    at(NOW);
    const s = await busyStaff("Dev Views Nobody");
    const dev = await developerToken();
    expect(await ids("/api/staff/me/today", dev)).toEqual([]);
    await env.DB.prepare("UPDATE staff SET is_active = 0 WHERE id = ?").bind(s.staffId).run();
    expect(await ids(`/api/staff/me/today?staffId=${s.staffId}`, dev)).toEqual([]);
    expect(await ids("/api/staff/me/today?staffId=no-such-staff", dev)).toEqual([]);
  });

  it("is read-only: a developer cannot request time off or change a booking for them", async () => {
    at(NOW);
    const s = await busyStaff("Dev Read Only");
    const dev = await developerToken();
    const q = `staffId=${s.staffId}`;

    const timeOff = await dispatch("POST", `/api/staff/me/time-off?${q}`, {
      headers: authHeaders(dev),
      body: { from_date: "2026-09-01", to_date: "2026-09-02" },
    });
    expect(timeOff.status).toBe(403);
    const status = await dispatch("PUT", `/api/staff/me/bookings/${s.bookingId}/status?${q}`, {
      headers: authHeaders(dev),
      body: { status: "completed" },
    });
    expect(status.status).toBe(403);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_time_off WHERE staff_id = ?").bind(s.staffId).first<{ n: number }>();
    expect(rows!.n).toBe(1);
    const booking = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(s.bookingId).first<{ status: string }>();
    expect(booking!.status).toBe("confirmed");
  });
});

describe("staff members always see their own day", () => {
  it("ignores ?staffId= naming a colleague", async () => {
    at(NOW);
    const s = await busyStaff("Colleague Snoop");
    const colleague = await seedStaff(s.shopId);
    const token = await staffToken(colleague, s.shopId);
    expect(await ids(`/api/staff/me/today?staffId=${s.staffId}`, token)).toEqual([]);
    expect(await ids(`/api/staff/me/time-off?staffId=${s.staffId}`, token)).toEqual([]);
    const detail = await dispatch("GET", `/api/staff/me/bookings/${s.bookingId}?staffId=${s.staffId}`, { headers: authHeaders(token) });
    expect(detail.status).toBe(404);
  });

  it("still reads and writes their own record", async () => {
    at(NOW);
    const s = await busyStaff("Own Record");
    const token = await staffToken(s.staffId, s.shopId);
    expect(await ids("/api/staff/me/today", token)).toEqual([s.bookingId]);
    const res = await dispatch("POST", "/api/staff/me/time-off", {
      headers: authHeaders(token),
      body: { from_date: "2026-09-01", to_date: "2026-09-02" },
    });
    expect(res.status).toBe(201);
  });
});
