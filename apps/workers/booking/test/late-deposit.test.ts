/**
 * A Checkout Session stays payable for 31 minutes. A deposit that settles
 * after the booking was cancelled (customer abandon, staff cancel, expiry)
 * must go back to the customer automatically: the booking stays cancelled,
 * the webhook writes the refund record BEFORE calling Stripe, and a retry
 * after a failure finishes the same refund. A confirmed booking, or a deposit
 * staff chose to keep, is never refunded by this path. Cancelling an unpaid
 * Checkout booking also closes its session, best effort, so the window shuts.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedScheduleDay, seedService, slugFor, tokenFor } from "./helpers";
import { getAvailableSlots } from "../src/services/slots";
import { entriesFor } from "./audit-helpers";

const SECRET = "whsec_test";
const encoder = new TextEncoder();

async function postEvent(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": `t=${t},v1=${hex}`, "Content-Type": "application/json" },
    body: event,
  });
}

let evtN = 0;
const evtId = () => `evt_late_${++evtN}_${crypto.randomUUID().slice(0, 8)}`;

const FUTURE_DATE = "2099-10-14";

async function setupDepositShop() {
  const shop = await seedShop("Late Deposit Shop");
  await env.DB.prepare(
    "UPDATE shops SET stripe_connect_account_id = 'acct_late1', stripe_connect_onboarded = 1 WHERE id = ?"
  )
    .bind(shop)
    .run();
  await env.DB.prepare(
    "INSERT INTO shop_settings (shop_id, deposits_enabled, deposit_percent, deposit_min_pence) VALUES (?, 1, 50, 500)"
  )
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30); // 2500 pence, so a 1250 deposit
  for (let d = 0; d < 7; d++) await seedScheduleDay(shop, staff, d);
  return { shop, staff, service };
}

let slotCursor = 0;
/** A real deposit booking through the public route: pending, with a session. */
async function bookDeposit(s: { shop: string; staff: string; service: string }): Promise<string> {
  const slots = await getAvailableSlots(s.shop, s.staff, FUTURE_DATE, 30, env.DB, env.KV);
  const free = slots.filter((x) => x.is_available);
  const res = await dispatch("POST", "/public/bookings", {
    body: {
      shop_slug: await slugFor(s.shop),
      staff_id: s.staff,
      service_id: s.service,
      date: FUTURE_DATE,
      start_time: free[slotCursor++ % free.length]!.start_time,
      customer_name: "Dana",
      customer_email: "dana@test.local",
    },
  });
  expect(res.status).toBe(201);
  return String(((await res.json()) as { data: { id: string } }).data.id);
}

function piSucceeded(bookingId: string, shopId: string, piId: string, id = evtId()) {
  return postEvent({
    id,
    type: "payment_intent.succeeded",
    data: { object: { id: piId, metadata: { bookingId, shopId, type: "booking_deposit" } } },
  });
}

async function staffCancel(shop: string, bookingId: string, body: Record<string, unknown> = {}) {
  return dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/cancel`, {
    headers: { Authorization: `Bearer ${await tokenFor("admin", shop)}` },
    body,
  });
}

async function bookingStatus(id: string) {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function depositTx(id: string) {
  return env.DB.prepare("SELECT status, stripe_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
    .bind(id)
    .first<{ status: string; stripe_id: string }>();
}

async function refundTxs(id: string) {
  const rows = await env.DB.prepare(
    "SELECT amount_pence, status, stripe_id, sale_id FROM bw_transactions WHERE booking_id = ? AND type = 'refund'"
  )
    .bind(id)
    .all<{ amount_pence: number; status: string; stripe_id: string | null; sale_id: string | null }>();
  return rows.results ?? [];
}

async function creditOf(id: string) {
  return env.DB.prepare(
    "SELECT deposit_amount_pence, deposit_application_fee_pence FROM bw_booking_state WHERE booking_id = ?"
  )
    .bind(id)
    .first<{ deposit_amount_pence: number; deposit_application_fee_pence: number }>();
}

async function sessionOf(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT stripe_checkout_session_id AS s FROM bw_booking_state WHERE booking_id = ?")
    .bind(id)
    .first<{ s: string }>();
  return String(row?.s);
}

/** Records every Stripe call the worker makes; `fail` answers chosen ones itself. */
function spyStripe(fail: (url: string) => Response | null = () => null) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.stripe.com/")) {
      calls.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${new URL(url).pathname}`);
      const forced = fail(url);
      if (forced) return forced;
    }
    return real(input, init);
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const STRIPE_DOWN = () => Response.json({ error: { message: "stripe down" } }, { status: 500 });

describe("a deposit that settles after the booking was cancelled", () => {
  it("is refunded automatically after the customer abandoned Checkout", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    expect((await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} })).status).toBe(200);
    expect(await bookingStatus(id)).toBe("cancelled");
    expect((await depositTx(id))?.status).toBe("cancelled");

    const piId = `pi_late_${id.slice(0, 8)}`;
    const wh = await piSucceeded(id, s.shop, piId);
    expect(wh.status).toBe(200);

    expect(await bookingStatus(id)).toBe("cancelled");
    expect(await depositTx(id)).toEqual({ status: "captured", stripe_id: piId });
    expect(await refundTxs(id)).toEqual([
      { amount_pence: 1250, status: "pending", stripe_id: `re_idem_deposit-refund:${id}`, sale_id: null },
    ]);
    // The checkout deposit credit dies with the refund, as on staff cancel,
    // so a reinstated booking can never be credited money that went back.
    expect(await creditOf(id)).toEqual({ deposit_amount_pence: 0, deposit_application_fee_pence: 0 });

    // The staff recovery path sees it as already refunded, so no second refund.
    const again = await staffCancel(s.shop, id, { refundDeposit: true });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ success: false, error: "Deposit already refunded" });

    // charge.refunded reconciles it like any deposit refund.
    const done = await postEvent({
      id: evtId(),
      type: "charge.refunded",
      data: { object: { payment_intent: piId, amount: 1250, amount_refunded: 1250 } },
    });
    expect(done.status).toBe(200);
    expect((await depositTx(id))?.status).toBe("refunded");
    expect((await refundTxs(id)).map((r) => r.status)).toEqual(["completed"]);
  });

  it("is refunded automatically after staff cancelled the unpaid booking", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    const cancelled = await staffCancel(s.shop, id);
    expect(cancelled.status).toBe(200);

    const piId = `pi_late_${id.slice(0, 8)}`;
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    expect(await bookingStatus(id)).toBe("cancelled");
    expect(await depositTx(id)).toEqual({ status: "captured", stripe_id: piId });
    expect(await refundTxs(id)).toEqual([
      { amount_pence: 1250, status: "pending", stripe_id: `re_idem_deposit-refund:${id}`, sale_id: null },
    ]);
  });

  it("records the owed refund in the webhook entry with booleans only", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} });
    const piId = `pi_late_${id.slice(0, 8)}`;
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    const rows = await entriesFor({ action: "payment.stripe.webhook", shopId: s.shop, entityId: id });
    const outcome = rows.find((r) => r.phase === "outcome" && String(r.details_json).includes("payment_intent"));
    expect(outcome, "no webhook outcome entry for the late deposit").toBeDefined();
    const details = JSON.parse(String(outcome!.details_json)) as Record<string, unknown>;
    expect(details).toMatchObject({ booking_flipped: false, deposit_refund_owed: true, deposit_refunded: true });
    expect(String(outcome!.details_json)).not.toContain(piId);
    expect(outcome!.changes_json).toBeNull();
  });

  it("a Stripe outage answers 500, keeps the record, and Stripe's retry finishes the same refund", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} });
    const piId = `pi_late_${id.slice(0, 8)}`;
    const event = evtId();

    let down = true;
    spyStripe((url) => (down && url.endsWith("/v1/refunds") ? STRIPE_DOWN() : null));
    expect((await piSucceeded(id, s.shop, piId, event)).status).toBe(500);
    // The debt is on record before Stripe was called, with no refund id yet,
    // and the deposit credit is already dead.
    expect(await refundTxs(id)).toEqual([{ amount_pence: 1250, status: "pending", stripe_id: null, sale_id: null }]);
    expect((await depositTx(id))?.status).toBe("captured");
    expect(await creditOf(id)).toEqual({ deposit_amount_pence: 0, deposit_application_fee_pence: 0 });

    down = false;
    expect((await piSucceeded(id, s.shop, piId, event)).status).toBe(200);
    expect(await refundTxs(id)).toEqual([
      { amount_pence: 1250, status: "pending", stripe_id: `re_idem_deposit-refund:${id}`, sale_id: null },
    ]);
  });

  it("treats a charge Stripe says is already refunded as done", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} });
    spyStripe((url) =>
      url.endsWith("/v1/refunds")
        ? Response.json(
            { error: { code: "charge_already_refunded", message: "Charge ch_1 has already been refunded." } },
            { status: 400 }
          )
        : null
    );
    expect((await piSucceeded(id, s.shop, `pi_late_${id.slice(0, 8)}`)).status).toBe(200);
    expect((await refundTxs(id)).length).toBe(1);
  });

  it("never refunds a confirmed booking, even when the event is delivered again", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    const piId = `pi_ok_${id.slice(0, 8)}`;
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    expect(await bookingStatus(id)).toBe("confirmed");
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    expect(await bookingStatus(id)).toBe("confirmed");
    expect(await refundTxs(id)).toEqual([]);
    expect(await creditOf(id)).toEqual({ deposit_amount_pence: 1250, deposit_application_fee_pence: 125 });
  });

  it("never refunds a deposit staff chose to keep, even when the event is delivered again", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    const piId = `pi_keep_${id.slice(0, 8)}`;
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    const kept = await staffCancel(s.shop, id, { refundDeposit: false });
    expect(((await kept.json()) as { data: { deposit_action: string } }).data.deposit_action).toBe("kept");

    // A retry of the original delivery arrives after the keep.
    expect((await piSucceeded(id, s.shop, piId)).status).toBe(200);
    expect(await bookingStatus(id)).toBe("cancelled");
    expect((await depositTx(id))?.status).toBe("captured");
    expect(await refundTxs(id)).toEqual([]);
  });
});

describe("cancelling an unpaid Checkout booking closes its session", () => {
  it("abandon expires the session once it has won the cancel", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    const session = await sessionOf(id);
    const calls = spyStripe();
    expect((await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} })).status).toBe(200);
    expect(calls).toEqual([`POST /v1/checkout/sessions/${encodeURIComponent(session)}/expire`]);

    // A second abandon loses (already cancelled) and calls Stripe again never.
    calls.length = 0;
    expect((await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} })).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("staff cancel of an unpaid deposit booking expires the session", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    const session = await sessionOf(id);
    const calls = spyStripe();
    expect((await staffCancel(s.shop, id)).status).toBe(200);
    expect(calls).toEqual([`POST /v1/checkout/sessions/${encodeURIComponent(session)}/expire`]);
  });

  it("staff cancel of a paid deposit booking does not touch the session", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    expect((await piSucceeded(id, s.shop, `pi_paid_${id.slice(0, 8)}`)).status).toBe(200);
    const calls = spyStripe();
    expect((await staffCancel(s.shop, id, { refundDeposit: false })).status).toBe(200);
    expect(calls.filter((c) => c.includes("/checkout/sessions/"))).toEqual([]);
  });

  it("a failed expiry never changes the answer", async () => {
    const s = await setupDepositShop();
    const id = await bookDeposit(s);
    spyStripe((url) => (url.endsWith("/expire") ? STRIPE_DOWN() : null));
    expect((await dispatch("POST", `/public/bookings/${id}/abandon`, { body: {} })).status).toBe(200);
    expect(await bookingStatus(id)).toBe("cancelled");

    const id2 = await bookDeposit(s);
    const res = await staffCancel(s.shop, id2);
    expect(res.status).toBe(200);
    expect(await bookingStatus(id2)).toBe("cancelled");
  });
});
