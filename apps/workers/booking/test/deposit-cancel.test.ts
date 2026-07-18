/**
 * Deposit-aware cancellation (POST /booking/shops/:shopId/bookings/:id/cancel):
 * staff choose refund-or-keep for a CHARGED deposit, holds are voided, plain
 * bookings just flip status, refund failures revert the cancellation, and the
 * recovery path refunds deposits stranded by the deposit-blind customer
 * self-cancel. charge.refunded completes the refund tx.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedScheduleDay, seedService, slugFor, tokenFor } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";

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
const evtId = () => `evt_dc_${++evtN}_${crypto.randomUUID().slice(0, 8)}`;

const FUTURE_DATE = "2099-09-20";
const customer = { customer_name: "Dana", customer_email: "dana@test.local" };

async function setupDepositShop() {
  const shop = await seedShop("Cancel Shop");
  await env.DB
    .prepare("UPDATE shops SET stripe_connect_account_id = 'acct_dc1', stripe_connect_onboarded = 1 WHERE id = ?")
    .bind(shop)
    .run();
  await env.DB
    .prepare(
      "INSERT INTO shop_settings (shop_id, deposits_enabled, deposit_percent, deposit_min_pence) VALUES (?, 1, 50, 500)"
    )
    .bind(shop)
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
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { id: string } };
  return data.id;
}

/** Settle the deposit through the webhook; the PI id is controllable so a
 *  "fail"-bearing id can trip the fake Stripe's refund outage. */
async function settleDeposit(bookingId: string, shopId: string, piId = `pi_dc_${bookingId.slice(0, 8)}`) {
  const res = await postEvent({
    id: evtId(),
    type: "payment_intent.succeeded",
    data: { object: { id: piId, metadata: { bookingId, shopId, type: "booking_deposit" } } },
  });
  expect(res.status).toBe(200);
  return piId;
}

async function bookingStatus(id: string) {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function depositTx(id: string) {
  return env.DB
    .prepare("SELECT status, stripe_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
    .bind(id)
    .first<{ status: string; stripe_id: string }>();
}

async function refundTx(id: string) {
  return env.DB
    .prepare("SELECT amount_pence, status, stripe_id FROM bw_transactions WHERE booking_id = ? AND type = 'refund'")
    .bind(id)
    .first<{ amount_pence: number; status: string; stripe_id: string }>();
}

async function stateRow(id: string) {
  return env.DB
    .prepare("SELECT deposit_amount_pence, deposit_application_fee_pence FROM bw_booking_state WHERE booking_id = ?")
    .bind(id)
    .first<{ deposit_amount_pence: number; deposit_application_fee_pence: number }>();
}

function cancel(shop: string, bookingId: string, token: string, body: Record<string, unknown> = {}) {
  return dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/cancel`, {
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
}

describe("deposit-aware cancellation", () => {
  it("refunds a charged deposit: full refund tx, state zeroed, webhook completes it", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    const piId = await settleDeposit(bookingId, shop);
    const token = await tokenFor("admin", shop);

    const res = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string; refund_pence: number } };
    expect(body.data.deposit_action).toBe("refunded");
    expect(body.data.refund_pence).toBe(1250);

    expect(await bookingStatus(bookingId)).toBe("cancelled");
    // The refund tx carries the REFUND id (idempotency echo), never the PI id.
    const rt = await refundTx(bookingId);
    expect(rt).toMatchObject({
      amount_pence: 1250,
      status: "pending",
      stripe_id: `re_idem_deposit-refund:${bookingId}`,
    });
    // Checkout credit killed for any future resurrection.
    const st = await stateRow(bookingId);
    expect(st).toMatchObject({ deposit_amount_pence: 0, deposit_application_fee_pence: 0 });

    // charge.refunded flips the original deposit tx and completes the refund tx.
    const wh = await postEvent({
      id: evtId(),
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_dc_1",
          payment_intent: piId,
          amount: 1250,
          amount_refunded: 1250,
          refunds: { data: [] },
        },
      },
    });
    expect(wh.status).toBe(200);
    expect((await depositTx(bookingId))?.status).toBe("refunded");
    expect((await refundTx(bookingId))?.status).toBe("completed");
  });

  it("keeps a charged deposit on request: no refund tx, deposit tx stays captured", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    await settleDeposit(bookingId, shop);
    const token = await tokenFor("admin", shop);

    const res = await cancel(shop, bookingId, token, { refundDeposit: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("kept");

    expect(await bookingStatus(bookingId)).toBe("cancelled");
    expect((await depositTx(bookingId))?.status).toBe("captured");
    expect(await refundTx(bookingId)).toBeNull();
  });

  it("voids an uncaptured hold regardless of refundDeposit", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const token = await tokenFor("admin", shop);
    // Seed a hold-style booking directly: confirmed, PI present, unpaid.
    const bookingId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
           booking_date, start_time, end_time, status, amount_pence)
         VALUES (?, ?, ?, ?, 'Hold', 'hold@test.local', ?, '10:00', '10:30', 'confirmed', 2500)`
      )
      .bind(bookingId, shop, staff, service, FUTURE_DATE)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, stripe_payment_intent_id, updated_at)
         VALUES (?, ?, 'staff', 1250, 'pi_hold_1', datetime('now'))`
      )
      .bind(bookingId, shop)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
         VALUES (?, ?, ?, 'deposit', 1250, 'pending', 'pi_hold_1')`
      )
      .bind(crypto.randomUUID(), bookingId, shop)
      .run();

    const res = await cancel(shop, bookingId, token, { refundDeposit: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("hold_voided");
    expect(await bookingStatus(bookingId)).toBe("cancelled");
    expect((await depositTx(bookingId))?.status).toBe("cancelled");
  });

  it("plain bookings just flip status (deposit_action none)", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const token = await tokenFor("admin", shop);
    const bookingId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
           booking_date, start_time, end_time, status, amount_pence)
         VALUES (?, ?, ?, ?, 'Plain', 'plain@test.local', ?, '11:00', '11:30', 'confirmed', 2500)`
      )
      .bind(bookingId, shop, staff, service, FUTURE_DATE)
      .run();

    const res = await cancel(shop, bookingId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("none");
    expect(await bookingStatus(bookingId)).toBe("cancelled");
  });

  it("reverts the cancellation when the refund fails (Stripe outage)", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    // A PI id containing "fail" makes the fake Stripe 500 on /v1/refunds.
    await settleDeposit(bookingId, shop, `pi_fail_${bookingId.slice(0, 8)}`);
    const token = await tokenFor("admin", shop);

    const res = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(res.status).toBe(502);
    expect(await bookingStatus(bookingId)).toBe("confirmed"); // reverted
    expect(await refundTx(bookingId)).toBeNull();
    expect((await depositTx(bookingId))?.status).toBe("captured");
    // The pre-Stripe deposit claim was rolled back too: the credit stays live.
    const st = await stateRow(bookingId);
    expect(st?.deposit_amount_pence).toBe(1250);
    expect(st?.deposit_application_fee_pence).toBe(125);
  });

  it("recovers a deposit stranded by the deposit-blind self-cancel, once", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    await settleDeposit(bookingId, shop);
    // Simulate the customer self-cancel path's bare UPDATE.
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(bookingId).run();
    const token = await tokenFor("admin", shop);

    const res = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("refunded");
    expect((await refundTx(bookingId))?.status).toBe("pending");

    // Second attempt: nothing left to refund.
    const again = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(again.status).toBe(400);
    const againBody = (await again.json()) as { error: string };
    expect(againBody.error).toBe("Deposit already refunded");
  });

  it("recovery acts only on an explicit refund request", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    await settleDeposit(bookingId, shop);
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(bookingId).run();
    const token = await tokenFor("admin", shop);

    // A bare re-cancel (no refundDeposit sent) must never silently refund.
    const bare = await cancel(shop, bookingId, token, {});
    expect(bare.status).toBe(400);
    const body = (await bare.json()) as { error: string };
    expect(body.error).toBe("Booking is already cancelled");
    expect(await refundTx(bookingId)).toBeNull();
    expect((await depositTx(bookingId))?.status).toBe("captured");
  });

  it("recovery voids a stranded hold on explicit request", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const token = await tokenFor("admin", shop);
    const bookingId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
           booking_date, start_time, end_time, status, amount_pence)
         VALUES (?, ?, ?, ?, 'HoldRec', 'holdrec@test.local', ?, '12:00', '12:30', 'cancelled', 2500)`
      )
      .bind(bookingId, shop, staff, service, FUTURE_DATE)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, stripe_payment_intent_id, updated_at)
         VALUES (?, ?, 'staff', 1250, 'pi_hold_rec', datetime('now'))`
      )
      .bind(bookingId, shop)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
         VALUES (?, ?, ?, 'deposit', 1250, 'pending', 'pi_hold_rec')`
      )
      .bind(crypto.randomUUID(), bookingId, shop)
      .run();

    const res = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("hold_voided");
    expect((await depositTx(bookingId))?.status).toBe("cancelled");
  });

  it("an out-of-band charge.refunded zeroes the deposit credit (webhook is the reconciler)", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    const piId = await settleDeposit(bookingId, shop);
    // No cancel call at all: the shop refunds the PI from the Stripe
    // dashboard. The booking stays confirmed but the credit must die.
    const wh = await postEvent({
      id: evtId(),
      type: "charge.refunded",
      data: {
        object: { id: "ch_oob_1", payment_intent: piId, amount: 1250, amount_refunded: 1250, refunds: { data: [] } },
      },
    });
    expect(wh.status).toBe(200);
    expect((await depositTx(bookingId))?.status).toBe("refunded");
    const st = await stateRow(bookingId);
    expect(st).toMatchObject({ deposit_amount_pence: 0, deposit_application_fee_pence: 0 });
    expect(await bookingStatus(bookingId)).toBe("confirmed");
  });

  it("checkout credits nothing when the deposit tx is refunded even if state was not zeroed", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    await settleDeposit(bookingId, shop);
    // Simulate the crash window: tx marked refunded, state left live.
    await env.DB
      .prepare("UPDATE bw_transactions SET status = 'refunded' WHERE booking_id = ? AND type = 'deposit'")
      .bind(bookingId)
      .run();
    await env.DB
      .prepare("UPDATE bw_booking_state SET checked_in_at = datetime('now') WHERE booking_id = ?")
      .bind(bookingId)
      .run();
    const token = await tokenFor("admin", shop);

    const out = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(out.status).toBe(200);
    const body = (await out.json()) as {
      receipt: { total_pence: number; deposit_credit_pence: number; due_now_pence: number };
    };
    expect(body.receipt.deposit_credit_pence).toBe(0);
    expect(body.receipt.due_now_pence).toBe(body.receipt.total_pence);
  });

  it("rejects closed bookings and enforces shop scoping", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    await settleDeposit(bookingId, shop);
    await env.DB.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").bind(bookingId).run();
    const token = await tokenFor("admin", shop);

    const closed = await cancel(shop, bookingId, token);
    expect(closed.status).toBe(400);

    // Foreign shop admin cannot reach it (requireShopAccess 403s first).
    const other = await seedShop("Other Shop");
    const foreignToken = await tokenFor("admin", other);
    const foreign = await cancel(shop, bookingId, foreignToken);
    expect([403, 404]).toContain(foreign.status);
  });

  it("a refunded booking resurrected to confirmed credits nothing at checkout", async () => {
    const { shop, staff, service } = await setupDepositShop();
    const bookingId = await bookDeposit(shop, staff, service);
    const piId = await settleDeposit(bookingId, shop);
    const token = await tokenFor("admin", shop);

    const res = await cancel(shop, bookingId, token, { refundDeposit: true });
    expect(res.status).toBe(200);

    // Staff resurrect the booking and run it end to end.
    await env.DB.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind(bookingId).run();
    await env.DB
      .prepare("UPDATE bw_booking_state SET checked_in_at = datetime('now') WHERE booking_id = ?")
      .bind(bookingId)
      .run();

    const out = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(out.status).toBe(200);
    const body = (await out.json()) as {
      saleId: string;
      receipt: { total_pence: number; deposit_credit_pence: number; due_now_pence: number };
    };
    // The refunded deposit must not be credited: customer owes the full price.
    expect(body.receipt.deposit_credit_pence).toBe(0);
    expect(body.receipt.due_now_pence).toBe(body.receipt.total_pence);

    // A LATE-delivered charge.refunded for the old deposit PI must not poison
    // the new sale's commission ledger.
    const late = await postEvent({
      id: evtId(),
      type: "charge.refunded",
      data: {
        object: { id: "ch_late_1", payment_intent: piId, amount: 1250, amount_refunded: 1250, refunds: { data: [] } },
      },
    });
    expect(late.status).toBe(200);
    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE sale_id = ?")
      .bind(body.saleId)
      .first<{ status: string }>();
    expect(ledger?.status).not.toBe("refunded");
  });
});
