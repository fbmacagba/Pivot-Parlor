/**
 * Deposit-aware cancellation fork in PUT /api/shops/:shopId/bookings/:id/status:
 * cancels of bookings with live Stripe deposit money proxy to the booking
 * worker's cancel endpoint (the BOOKING binding here is the echo stub, so
 * these tests assert the forwarding contract; real cancel semantics live in
 * the booking worker's own suite); everything else keeps the local bare path.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)"
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedBooking(shopId: string, status = "confirmed"): Promise<string> {
  const staffId = await seedStaff(shopId);
  const serviceId = await seedService(shopId);
  const id = crypto.randomUUID();
  const start = new Date(Date.now() + 72 * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, ?, 2500)`
  )
    .bind(id, shopId, staffId, serviceId, start.toISOString().slice(0, 10), start.toISOString(), end.toISOString(), status)
    .run();
  return id;
}

/** Captured-deposit state: paid, PI on file, deposit tx captured, no sale. */
async function seedCapturedDeposit(shopId: string, bookingId: string) {
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence,
       deposit_application_fee_pence, deposit_paid_at, stripe_payment_intent_id, updated_at)
     VALUES (?, ?, 'online', 1250, 125, datetime('now'), 'pi_fork_1', datetime('now'))`
  )
    .bind(bookingId, shopId)
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
     VALUES (?, ?, ?, 'deposit', 1250, 'captured', 'pi_fork_1')`
  )
    .bind(crypto.randomUUID(), bookingId, shopId)
    .run();
}

async function statusOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

describe("deposit-aware cancellation fork", () => {
  it("proxies a captured-deposit cancel to the booking worker with refundDeposit", async () => {
    const shop = await seedShop("Fork Shop");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const bookingId = await seedBooking(shop);
    await seedCapturedDeposit(shop, bookingId);

    const res = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled", refund_deposit: true },
    });
    expect(res.status).toBe(201); // echo stub answers 201 for POST
    const body = (await res.json()) as {
      data: { stub: string; url: string; method: string; body: string };
    };
    expect(body.data.stub).toBe("BOOKING");
    expect(body.data.method).toBe("POST");
    expect(body.data.url).toContain(`/booking/shops/${shop}/bookings/${bookingId}/cancel`);
    expect(JSON.parse(body.data.body)).toEqual({ refundDeposit: true });

    // The stub, not this worker, owns the flip: local status untouched.
    expect(await statusOf(bookingId)).toBe("confirmed");
  });

  it("forwards refund_deposit only when the client sent it", async () => {
    const shop = await seedShop("Fork Default");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    // Absent: the booking worker applies its own defaults (fresh cancels
    // refund; recovery acts only on explicit true).
    const b1 = await seedBooking(shop);
    await seedCapturedDeposit(shop, b1);
    const r1 = await dispatch("PUT", `/api/shops/${shop}/bookings/${b1}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    const p1 = (await r1.json()) as { data: { body: string } };
    expect(JSON.parse(p1.data.body)).toEqual({});

    const b2 = await seedBooking(shop);
    await seedCapturedDeposit(shop, b2);
    const r2 = await dispatch("PUT", `/api/shops/${shop}/bookings/${b2}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled", refund_deposit: false },
    });
    const p2 = (await r2.json()) as { data: { body: string } };
    expect(JSON.parse(p2.data.body)).toEqual({ refundDeposit: false });
  });

  it("keeps the local bare path for plain bookings and non-cancel transitions", async () => {
    const shop = await seedShop("Fork Bare");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    // No deposit state: local update runs.
    const plain = await seedBooking(shop);
    const r1 = await dispatch("PUT", `/api/shops/${shop}/bookings/${plain}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { success: boolean }).success).toBe(true);
    expect(await statusOf(plain)).toBe("cancelled");

    // Deposit booking, but a non-cancel transition: local update runs.
    const dep = await seedBooking(shop);
    await seedCapturedDeposit(shop, dep);
    const r2 = await dispatch("PUT", `/api/shops/${shop}/bookings/${dep}/status`, {
      headers: authHeaders(admin),
      body: { status: "no_show" },
    });
    expect(r2.status).toBe(200);
    expect(await statusOf(dep)).toBe("no_show");
  });

  it("does not proxy when the deposit is already refunded or credited to a sale", async () => {
    const shop = await seedShop("Fork Settled");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    // Refunded deposit: bare path.
    const refunded = await seedBooking(shop);
    await seedCapturedDeposit(shop, refunded);
    await env.DB.prepare(
      "UPDATE bw_transactions SET status = 'refunded' WHERE booking_id = ? AND type = 'deposit'"
    )
      .bind(refunded)
      .run();
    const r1 = await dispatch("PUT", `/api/shops/${shop}/bookings/${refunded}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(r1.status).toBe(200);
    expect(await statusOf(refunded)).toBe("cancelled");

    // Deposit credited to a sale at checkout: bare path.
    const credited = await seedBooking(shop);
    await seedCapturedDeposit(shop, credited);
    const saleId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO sales (id, shop_id, subtotal_pence, discount_pence, tip_pence, total_pence, tender_type, status)
       VALUES (?, ?, 2500, 0, 0, 2500, 'stripe', 'completed')`
    )
      .bind(saleId, shop)
      .run();
    await env.DB.prepare(
      "UPDATE bw_transactions SET sale_id = ? WHERE booking_id = ? AND type = 'deposit'"
    )
      .bind(saleId, credited)
      .run();
    const r2 = await dispatch("PUT", `/api/shops/${shop}/bookings/${credited}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(r2.status).toBe(200);
    expect(await statusOf(credited)).toBe("cancelled");
  });

  it("rejects an explicit refund request when the deposit is not refundable", async () => {
    const shop = await seedShop("Fork Truthful");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    // Refunded deposit + explicit refund request: must 400, never a silent
    // success (this is what makes a stale drawer's refund button truthful).
    const refunded = await seedBooking(shop, "cancelled");
    await seedCapturedDeposit(shop, refunded);
    await env.DB.prepare(
      "UPDATE bw_transactions SET status = 'refunded' WHERE booking_id = ? AND type = 'deposit'"
    )
      .bind(refunded)
      .run();
    const res = await dispatch("PUT", `/api/shops/${shop}/bookings/${refunded}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled", refund_deposit: true },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("not refundable");
  });

  it("lists bookings with the deposit fields the admin UI needs", async () => {
    const shop = await seedShop("Fork List");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const bookingId = await seedBooking(shop);
    await seedCapturedDeposit(shop, bookingId);

    const res = await dispatch("GET", `/api/shops/${shop}/bookings`, {
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        deposit_amount_pence: number | null;
        deposit_paid_at: string | null;
        deposit_tx_status: string | null;
      }[];
    };
    const row = body.data.find((b) => b.id === bookingId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      deposit_amount_pence: 1250,
      deposit_tx_status: "captured",
    });
    expect(row!.deposit_paid_at).toBeTruthy();
  });
});
