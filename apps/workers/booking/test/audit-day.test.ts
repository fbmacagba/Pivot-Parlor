import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedScheduleDay, seedService, seedShop, seedStaff, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };

async function authed(role: string, shopId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenFor(role, shopId)}` };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A set-up shop with a schedule for today (day_of_week is Monday-first). */
async function seedOpenableShop(): Promise<{ shopId: string; staffId: string; serviceId: string }> {
  const shopId = await seedShop("Day Shop");
  await env.DB.prepare("UPDATE shops SET setup_completed = 1 WHERE id = ?").bind(shopId).run();
  const staffId = await seedStaff(shopId);
  const serviceId = await seedService(shopId);
  const dow = (new Date(`${today()}T12:00:00Z`).getUTCDay() + 6) % 7;
  await seedScheduleDay(shopId, staffId, dow);
  return { shopId, staffId, serviceId };
}

async function businessDayRows(shopId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM bw_business_days WHERE shop_id = ?")
    .bind(shopId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function seedNoShowWithHold(
  shopId: string,
  staffId: string,
  serviceId: string,
  piId: string
): Promise<string> {
  const bookingId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Nora Noshow', 'nora@test.local', ?, '10:00', '10:30', 'confirmed', 2500)`
  )
    .bind(bookingId, shopId, staffId, serviceId, today())
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, stripe_payment_intent_id, updated_at)
     VALUES (?, ?, 'staff', 1250, ?, datetime('now'))`
  )
    .bind(bookingId, shopId, piId)
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
     VALUES (?, ?, ?, 'deposit', 1250, 'pending', ?)`
  )
    .bind(crypto.randomUUID(), bookingId, shopId, piId)
    .run();
  return bookingId;
}

describe("day open audit", () => {
  it("records day.open with the status change and slot count", async () => {
    const { shopId } = await seedOpenableShop();
    const res = await dispatch("POST", `/booking/shops/${shopId}/open`, { headers: await authed("admin", shopId) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { businessDayId: string; slotsGenerated: number; date: string };
    const rows = await entriesFor({ action: "day.open", shopId });
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: shopId,
      entity_type: "business_day",
      entity_id: body.businessDayId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "open"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({
      date: body.date,
      slots_generated: body.slotsGenerated,
    });
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("opening twice records nothing for the refused second open", async () => {
    const { shopId } = await seedOpenableShop();
    const headers = await authed("admin", shopId);
    expect((await dispatch("POST", `/booking/shops/${shopId}/open`, { headers })).status).toBe(200);
    const before = (await entriesFor({ action: "day.open", shopId })).length;
    const res = await dispatch("POST", `/booking/shops/${shopId}/open`, { headers });
    expect(res.status).toBe(400);
    expect((await entriesFor({ action: "day.open", shopId })).length).toBe(before);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("answers 503 and creates no business day when the entry cannot be written", async () => {
    const { shopId } = await seedOpenableShop();
    const headers = await authed("admin", shopId);
    const res = await withAuditOff(() => dispatch("POST", `/booking/shops/${shopId}/open`, { headers }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await businessDayRows(shopId)).toBe(0);
  });
});

describe("day close audit", () => {
  it("records day.close with the status change and integer counts only", async () => {
    const { shopId, staffId, serviceId } = await seedOpenableShop();
    const headers = await authed("admin", shopId);
    const open = (await (await dispatch("POST", `/booking/shops/${shopId}/open`, { headers })).json()) as {
      businessDayId: string;
    };
    await seedNoShowWithHold(shopId, staffId, serviceId, "pi_ok_1");
    const res = await dispatch("POST", `/booking/shops/${shopId}/close`, { headers });
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "day.close", shopId });
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: shopId,
      entity_type: "business_day",
      entity_id: open.businessDayId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["open", "closed"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({
      no_shows: 1,
      completed: 0,
      walk_ins: 0,
      holds_captured: 1,
      holds_failed: 0,
    });
    expectNoPersonalData(outcome, ["Nora Noshow", "nora@test.local", "pi_ok_1", "Day Shop"]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("close counts a failed no-show capture without failing", async () => {
    const { shopId, staffId, serviceId } = await seedOpenableShop();
    const headers = await authed("admin", shopId);
    await dispatch("POST", `/booking/shops/${shopId}/open`, { headers });
    await seedNoShowWithHold(shopId, staffId, serviceId, "pi_fail_1");
    const res = await dispatch("POST", `/booking/shops/${shopId}/close`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    const outcome = (await entriesFor({ action: "day.close", shopId })).find((r) => r.phase === "outcome")!;
    expect(outcome.outcome).toBe("succeeded");
    const details = JSON.parse(outcome.details_json as string) as Record<string, number>;
    expect(details.holds_failed).toBe(1);
    expect(details.holds_captured).toBe(0);
    expectNoPersonalData(outcome, ["pi_fail_1", "Nora Noshow"]);
  });

  it("a close with no open day records nothing", async () => {
    const { shopId } = await seedOpenableShop();
    const res = await dispatch("POST", `/booking/shops/${shopId}/close`, { headers: await authed("admin", shopId) });
    expect(res.status).toBe(400);
    expect((await entriesFor({ action: "day.close", shopId })).length).toBe(0);
  });

  it("answers 503 and leaves the day open when the entry cannot be written", async () => {
    const { shopId } = await seedOpenableShop();
    const headers = await authed("admin", shopId);
    await dispatch("POST", `/booking/shops/${shopId}/open`, { headers });
    const res = await withAuditOff(() => dispatch("POST", `/booking/shops/${shopId}/close`, { headers }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    const day = await env.DB.prepare("SELECT status FROM bw_business_days WHERE shop_id = ?")
      .bind(shopId)
      .first<{ status: string }>();
    expect(day?.status).toBe("open");
  });
});
