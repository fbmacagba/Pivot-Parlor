/**
 * Customer-facing deposits (migration 041): a shop with deposits enabled
 * sends the public booking through a hosted Checkout Session; the
 * payment_intent.succeeded webhook confirms the booking, expiry/abandon
 * releases the slot, and the appointment checkout treats the charged deposit
 * as a paid credit (never a capturable hold).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedScheduleDay, seedService, slugFor, tokenFor } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";
import { sweepExpiredDepositBookings } from "../src/services/deposit-sweep";

const SECRET = "whsec_test";
const encoder = new TextEncoder();

async function sigHeader(payload: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

async function postEvent(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": await sigHeader(payload), "Content-Type": "application/json" },
    body: event,
  });
}

let evtN = 0;
const evtId = () => `evt_dep_${++evtN}_${crypto.randomUUID().slice(0, 8)}`;

const FUTURE_DATE = "2099-08-16";
const customer = { customer_name: "Dana", customer_email: "dana@test.local" };

/** Shop with Connect onboarded + deposits enabled (service price 2500). */
async function setupDepositShop(opts: { percent?: number; minPence?: number } = {}) {
  const shop = await seedShop("Deposit Shop");
  await env.DB
    .prepare(
      "UPDATE shops SET stripe_connect_account_id = 'acct_dep1', stripe_connect_onboarded = 1 WHERE id = ?"
    )
    .bind(shop)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO shop_settings (shop_id, deposits_enabled, deposit_percent, deposit_min_pence)
       VALUES (?, 1, ?, ?)`
    )
    .bind(shop, opts.percent ?? 50, opts.minPence ?? 500)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30); // 2500 pence
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
  return { shop, staff, service };
}

async function bookDeposit(shop: string, staff: string, service: string, slotIndex = 0) {
  const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
  const free = slots.filter((s) => s.is_available);
  const res = await dispatch("POST", "/public/bookings", {
    body: {
      shop_slug: await slugFor(shop),
      staff_id: staff,
      service_id: service,
      date: FUTURE_DATE,
      start_time: free[slotIndex]!.start_time,
      ...customer,
    },
  });
  return { res, startTime: free[slotIndex]!.start_time };
}

async function bookingRow(id: string) {
  return env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
}

async function stateRow(id: string) {
  return env.DB
    .prepare(
      `SELECT deposit_amount_pence, deposit_application_fee_pence, stripe_checkout_session_id,
              deposit_paid_at, stripe_payment_intent_id
       FROM bw_booking_state WHERE booking_id = ?`
    )
    .bind(id)
    .first<{
      deposit_amount_pence: number; deposit_application_fee_pence: number;
      stripe_checkout_session_id: string | null; deposit_paid_at: string | null;
      stripe_payment_intent_id: string | null;
    }>();
}

async function depositTx(id: string) {
  return env.DB
    .prepare("SELECT amount_pence, status, stripe_id, sale_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
    .bind(id)
    .first<{ amount_pence: number; status: string; stripe_id: string; sale_id: string | null }>();
}

/** Settle a deposit booking through the webhook the way Stripe would. */
async function settleDeposit(bookingId: string, shopId: string, piId = `pi_dep_${bookingId.slice(0, 8)}`) {
  const res = await postEvent({
    id: evtId(),
    type: "payment_intent.succeeded",
    data: { object: { id: piId, metadata: { bookingId, shopId, type: "booking_deposit" } } },
  });
  expect(res.status).toBe(200);
  return piId;
}

describe("deposit-gated public booking", () => {
  it("returns a hosted Checkout URL and holds the booking pending", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const id = String(body.data.id);
    expect(body.data.status).toBe("pending");
    expect(body.data.deposit_pence).toBe(1250); // 50% of 2500
    expect(String(body.data.checkout_url)).toContain("checkout.stripe.com");

    expect((await bookingRow(id))?.status).toBe("pending");
    const st = await stateRow(id);
    expect(st?.deposit_amount_pence).toBe(1250);
    expect(st?.deposit_application_fee_pence).toBe(125); // 10% platform share of the deposit
    expect(st?.stripe_checkout_session_id).toBe(`cs_idem_deposit:${id}`); // deterministic Idempotency-Key
    expect(st?.deposit_paid_at).toBeNull();
    const tx = await depositTx(id);
    expect(tx).toMatchObject({ amount_pence: 1250, status: "pending", stripe_id: `cs_idem_deposit:${id}` });
  });

  it("clamps to the minimum and never exceeds the price", async () => {
    const low = await setupDepositShop({ percent: 10, minPence: 500 });
    const r1 = await bookDeposit(low.shop, low.staff, low.service);
    const b1 = (await r1.res.json()) as { data: { deposit_pence: number } };
    expect(b1.data.deposit_pence).toBe(500); // 10% = 250 → floor 500

    const full = await setupDepositShop({ percent: 50, minPence: 99_00 });
    const r2 = await bookDeposit(full.shop, full.staff, full.service);
    const b2 = (await r2.res.json()) as { data: { deposit_pence: number } };
    expect(b2.data.deposit_pence).toBe(2500); // min £99 > price → full prepay
  });

  it("keeps the free flow for shops without deposits or without Connect", async () => {
    const shop = await seedShop("Free Shop");
    const staff = await seedStaff(shop);
    const service = await seedService(shop, 30);
    for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
    const slots = await getAvailableSlots(shop, staff, FUTURE_DATE, 30, env.DB, env.KV);
    const res = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop, staff_id: staff, service_id: service,
        date: FUTURE_DATE, start_time: slots.find((s) => s.is_available)!.start_time,
        ...customer,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.checkout_url).toBeUndefined();

    // Enabled but not onboarded → also free.
    const half = await setupDepositShop();
    await env.DB
      .prepare("UPDATE shops SET stripe_connect_onboarded = 0 WHERE id = ?")
      .bind(half.shop)
      .run();
    const { res: res2 } = await bookDeposit(half.shop, half.staff, half.service);
    const body2 = (await res2.json()) as { data: Record<string, unknown> };
    expect(body2.data.checkout_url).toBeUndefined();
  });

  it("payment_intent.succeeded confirms the booking and settles the deposit tx", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };

    const piId = await settleDeposit(data.id, shop);

    expect((await bookingRow(data.id))?.status).toBe("confirmed");
    const st = await stateRow(data.id);
    expect(st?.deposit_paid_at).toBeTruthy();
    expect(st?.stripe_payment_intent_id).toBe(piId);
    const tx = await depositTx(data.id);
    expect(tx).toMatchObject({ status: "captured", stripe_id: piId });
  });

  it("checkout.session.expired cancels an unpaid booking and frees the slot", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res, startTime } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };

    const expRes = await postEvent({
      id: evtId(),
      type: "checkout.session.expired",
      data: {
        object: {
          id: `cs_idem_deposit:${data.id}`,
          metadata: { bookingId: data.id, shopId: shop, type: "booking_deposit" },
        },
      },
    });
    expect(expRes.status).toBe(200);
    expect((await bookingRow(data.id))?.status).toBe("cancelled");
    expect((await depositTx(data.id))?.status).toBe("cancelled");

    // The slot is bookable again (idx_bookings_active_slot ignores cancelled).
    const again = await dispatch("POST", "/public/bookings", {
      body: {
        shop_id: shop, staff_id: staff, service_id: service,
        date: FUTURE_DATE, start_time: startTime, ...customer,
      },
    });
    expect(again.status).toBe(201);
  });

  it("a stale expiry event can never cancel a PAID booking", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };
    await settleDeposit(data.id, shop);

    const expRes = await postEvent({
      id: evtId(),
      type: "checkout.session.expired",
      data: {
        object: {
          id: `cs_idem_deposit:${data.id}`,
          metadata: { bookingId: data.id, shopId: shop, type: "booking_deposit" },
        },
      },
    });
    expect(expRes.status).toBe(200);
    expect((await bookingRow(data.id))?.status).toBe("confirmed");
  });

  it("abandon cancels only unpaid deposit bookings", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };

    const ab = await dispatch("POST", `/public/bookings/${data.id}/abandon`, { body: {} });
    expect(ab.status).toBe(200);
    expect((await bookingRow(data.id))?.status).toBe("cancelled");

    // A paid booking is out of reach.
    const paid = await bookDeposit(shop, staff, service, 1);
    const paidBody = (await paid.res.json()) as { data: { id: string } };
    await settleDeposit(paidBody.data.id, shop);
    const ab2 = await dispatch("POST", `/public/bookings/${paidBody.data.id}/abandon`, { body: {} });
    expect(ab2.status).toBe(404);
    expect((await bookingRow(paidBody.data.id))?.status).toBe("confirmed");
  });

  it("public status endpoint reports the deposit state", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };

    let s = await dispatch("GET", `/public/bookings/${data.id}`);
    expect(s.status).toBe(200);
    let sb = (await s.json()) as { data: Record<string, unknown> };
    expect(sb.data).toMatchObject({ status: "pending", deposit_pence: 1250, deposit_paid: false });

    await settleDeposit(data.id, shop);
    s = await dispatch("GET", `/public/bookings/${data.id}`);
    sb = (await s.json()) as { data: Record<string, unknown> };
    expect(sb.data).toMatchObject({ status: "confirmed", deposit_paid: true });

    expect((await dispatch("GET", "/public/bookings/nope")).status).toBe(404);
  });

  it("sweep cancels stale unpaid bookings and leaves fresh/paid ones", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const stale = await bookDeposit(shop, staff, service, 0);
    const staleId = ((await stale.res.json()) as { data: { id: string } }).data.id;
    const fresh = await bookDeposit(shop, staff, service, 1);
    const freshId = ((await fresh.res.json()) as { data: { id: string } }).data.id;

    // Age the stale one past the cutoff.
    await env.DB
      .prepare("UPDATE bw_booking_state SET updated_at = '2000-01-01T00:00:00.000Z' WHERE booking_id = ?")
      .bind(staleId)
      .run();

    const n = await sweepExpiredDepositBookings(env.DB);
    expect(n).toBe(1);
    expect((await bookingRow(staleId))?.status).toBe("cancelled");
    expect((await bookingRow(freshId))?.status).toBe("pending");
  });
});

describe("appointment checkout with a charged deposit", () => {
  async function paidDepositBooking() {
    const { shop, staff, service } = await setupDepositShop();
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };
    await settleDeposit(data.id, shop);
    // Check in so the checkout gate passes.
    await env.DB
      .prepare("UPDATE bw_booking_state SET checked_in_at = datetime('now') WHERE booking_id = ?")
      .bind(data.id)
      .run();
    return { shop, staff, service, bookingId: data.id, token: await tokenFor("admin", shop) };
  }

  it("credits the deposit instead of capturing, balance covers the rest", async () => {
    const { shop, bookingId, token } = await paidDepositBooking();

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      saleId: string;
      receipt: { total_pence: number; deposit_credit_pence: number; due_now_pence: number };
    };
    // Service 2500, deposit 1250 already charged.
    expect(body.receipt.total_pence).toBe(2500);
    expect(body.receipt.deposit_credit_pence).toBe(1250);
    expect(body.receipt.due_now_pence).toBe(1250);

    // No deposit_capture tx; a pending balance tx for the remainder with the
    // remaining commission as its application fee (250 total - 125 on deposit).
    const txs = await env.DB
      .prepare("SELECT type, amount_pence, status, stripe_id FROM bw_transactions WHERE booking_id = ? ORDER BY type")
      .bind(bookingId)
      .all<{ type: string; amount_pence: number; status: string; stripe_id: string }>();
    const types = (txs.results ?? []).map((t) => t.type);
    expect(types).toContain("deposit");
    expect(types).toContain("balance");
    expect(types).not.toContain("deposit_capture");
    const balance = (txs.results ?? []).find((t) => t.type === "balance");
    expect(balance).toMatchObject({ amount_pence: 1250, status: "pending" });
    expect(balance!.stripe_id).toBe(`pi_idem_balance:${bookingId}`);

    // The deposit tx is attached to the sale for a whole money trail.
    expect((await depositTx(bookingId))?.sale_id).toBe(body.saleId);

    // Ledger stays pending until the balance PI settles (WS-2 honesty).
    const ledger = await env.DB
      .prepare("SELECT status, commission_amount_pence FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(body.saleId)
      .first<{ status: string; commission_amount_pence: number }>();
    expect(ledger).toMatchObject({ status: "pending", commission_amount_pence: 250 });
  });

  it("a full-prepay deposit settles the sale immediately with no balance PI", async () => {
    const { shop, staff, service } = await setupDepositShop({ percent: 100, minPence: 0 });
    const { res } = await bookDeposit(shop, staff, service);
    const { data } = (await res.json()) as { data: { id: string } };
    await settleDeposit(data.id, shop);
    await env.DB
      .prepare("UPDATE bw_booking_state SET checked_in_at = datetime('now') WHERE booking_id = ?")
      .bind(data.id)
      .run();
    const token = await tokenFor("admin", shop);

    const out = await dispatch("POST", `/booking/shops/${shop}/bookings/${data.id}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(out.status).toBe(200);
    const body = (await out.json()) as {
      saleId: string;
      receipt: { deposit_credit_pence: number; due_now_pence: number };
      balanceClientSecret: string | null;
    };
    expect(body.receipt.deposit_credit_pence).toBe(2500);
    expect(body.receipt.due_now_pence).toBe(0);
    expect(body.balanceClientSecret).toBeNull();

    const sale = await env.DB
      .prepare("SELECT status FROM sales WHERE id = ?")
      .bind(body.saleId)
      .first<{ status: string }>();
    expect(sale?.status).toBe("completed");
    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(body.saleId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("transferred");
  });
});
