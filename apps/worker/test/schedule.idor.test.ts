import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, seedScheduleDay, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

let shopA: string, shopB: string;
let staffA: string, staffB: string;
let adminAToken: string;

beforeAll(async () => {
  shopA = await seedShop("Shop A");
  shopB = await seedShop("Shop B");
  staffA = await seedStaff(shopA);
  staffB = await seedStaff(shopB);
  // day_of_week=1 to match this file's day-1 assertions below.
  await seedScheduleDay(shopA, staffA, 1);
  await seedScheduleDay(shopB, staffB, 1);
  const adminA = await seedUser("admin", shopA);
  adminAToken = await tokenFor(adminA, "admin", shopA);
});

describe("schedule shop scoping (IDOR)", () => {
  it("admin of shop A cannot read a shop B staff member's schedule", async () => {
    const res = await dispatch("GET", `/api/shops/${shopA}/schedule/${staffB}`, {
      headers: authHeaders(adminAToken),
    });
    expect(res.status).toBe(404);
  });

  it("admin of shop A can read their own staff member's schedule", async () => {
    const res = await dispatch("GET", `/api/shops/${shopA}/schedule/${staffA}`, {
      headers: authHeaders(adminAToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(1);
  });

  it("admin of shop A cannot upsert schedule entries for shop B staff", async () => {
    const res = await dispatch("PUT", `/api/shops/${shopA}/schedule`, {
      headers: authHeaders(adminAToken),
      body: {
        entries: [
          { staff_id: staffB, day_of_week: 2, start_time: "10:00", end_time: "18:00" },
        ],
      },
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedules WHERE staff_id = ? AND day_of_week = 2"
    )
      .bind(staffB)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("admin of shop A cannot deactivate shop B staff schedule via off=true", async () => {
    const res = await dispatch("PUT", `/api/shops/${shopA}/schedule`, {
      headers: authHeaders(adminAToken),
      body: { entries: [{ staff_id: staffB, day_of_week: 1, off: true }] },
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare(
      "SELECT is_active FROM schedules WHERE staff_id = ? AND day_of_week = 1"
    )
      .bind(staffB)
      .first<{ is_active: number }>();
    expect(row?.is_active).toBe(1);
  });

  it("admin of shop A can upsert entries for their own staff", async () => {
    const res = await dispatch("PUT", `/api/shops/${shopA}/schedule`, {
      headers: authHeaders(adminAToken),
      body: {
        entries: [
          { staff_id: staffA, day_of_week: 3, start_time: "09:00", end_time: "17:00" },
        ],
      },
    });
    expect(res.status).toBe(200);
  });
});
