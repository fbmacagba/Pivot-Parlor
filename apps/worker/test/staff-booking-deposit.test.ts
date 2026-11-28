// The staff booking detail says whether the booking holds a deposit that could
// still be refunded, and whether a refund request for it already waits. The
// staff page offers "Ask for the deposit back" from these two fields.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, tokenFor } from "./helpers";

async function staffSession(shopId: string) {
  const staffId = await seedStaff(shopId);
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?").bind(staffId).first<{ user_id: string }>();
  return { staffId, userId: row!.user_id, headers: authHeaders(await tokenFor(row!.user_id, "staff", shopId)) };
}

async function seedBooking(shopId: string, staffId: string, status = "confirmed"): Promise<string> {
  const serviceId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, 'Skin fade', 30, 2500, NULL, 1)`,
  )
    .bind(serviceId, shopId)
    .run();
  const id = crypto.randomUUID();
  const start = new Date(Date.now() + 72 * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, ?, 2500)`,
  )
    .bind(id, shopId, staffId, serviceId, start.toISOString().slice(0, 10), start.toISOString(), end.toISOString(), status)
    .run();
  return id;
}

async function seedCapturedDeposit(shopId: string, bookingId: string) {
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence,
       deposit_application_fee_pence, deposit_paid_at, stripe_payment_intent_id, updated_at)
     VALUES (?, ?, 'online', 1250, 125, datetime('now'), 'pi_staff_dep', datetime('now'))`,
  )
    .bind(bookingId, shopId)
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
     VALUES (?, ?, ?, 'deposit', 1250, 'captured', 'pi_staff_dep')`,
  )
    .bind(crypto.randomUUID(), bookingId, shopId)
    .run();
}

type Detail = { deposit_refundable_pence: number | null; deposit_refund_requested: boolean };

async function detail(bookingId: string, headers: Record<string, string>): Promise<Detail> {
  const res = await dispatch("GET", `/api/staff/me/bookings/${bookingId}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Detail }).data;
}

describe("staff booking detail: the deposit", () => {
  it("a booking with no deposit offers nothing to refund", async () => {
    const shopId = await seedShop("Staff Deposit None");
    const { staffId, headers } = await staffSession(shopId);
    const bookingId = await seedBooking(shopId, staffId);
    expect(await detail(bookingId, headers)).toMatchObject({
      deposit_refundable_pence: null,
      deposit_refund_requested: false,
    });
  });

  it("a captured deposit is refundable, and a waiting request shows", async () => {
    const shopId = await seedShop("Staff Deposit Held");
    const { staffId, userId, headers } = await staffSession(shopId);
    const bookingId = await seedBooking(shopId, staffId);
    await seedCapturedDeposit(shopId, bookingId);
    expect(await detail(bookingId, headers)).toMatchObject({
      deposit_refundable_pence: 1250,
      deposit_refund_requested: false,
    });

    await env.DB.prepare(
      `INSERT INTO refund_requests (id, shop_id, kind, booking_id, amount_pence, reason, status, requested_by, requested_at)
       VALUES (?, ?, 'deposit', ?, 1250, 'Customer rang to cancel', 'pending', ?, datetime('now'))`,
    )
      .bind(crypto.randomUUID(), shopId, bookingId, userId)
      .run();
    expect(await detail(bookingId, headers)).toMatchObject({
      deposit_refundable_pence: 1250,
      deposit_refund_requested: true,
    });
  });

  it("a completed booking, or a deposit already refunded, offers nothing", async () => {
    const shopId = await seedShop("Staff Deposit Closed");
    const { staffId, headers } = await staffSession(shopId);
    const done = await seedBooking(shopId, staffId, "completed");
    await seedCapturedDeposit(shopId, done);
    expect((await detail(done, headers)).deposit_refundable_pence).toBeNull();

    const refunded = await seedBooking(shopId, staffId, "cancelled");
    await seedCapturedDeposit(shopId, refunded);
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
       VALUES (?, ?, ?, 'refund', 1250, 'captured', 're_staff_dep')`,
    )
      .bind(crypto.randomUUID(), refunded, shopId)
      .run();
    expect((await detail(refunded, headers)).deposit_refundable_pence).toBeNull();
  });
});
