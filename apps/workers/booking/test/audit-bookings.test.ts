import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedService, seedShop, seedStaff, tokenFor } from "./helpers";
import { dispatch } from "./request";
import { entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };
const FUTURE_DATE = "2099-11-20";
const SHOP_NAME = "Staff Audit Shop";
const WHO = { name: "Quincy Quartz", email: "quincy.quartz@test.local", phone: "07700900456" };

const WHSEC = "whsec_test";

async function postSignedEvent(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const enc = new TextEncoder();
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", enc.encode(WHSEC), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": `t=${t},v1=${hex}`, "Content-Type": "application/json" },
    body: event,
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function authed(role: string, shopId: string): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await tokenFor(role, shopId)}` };
}

async function setup(): Promise<{ shop: string; staff: string; service: string }> {
  const shop = await seedShop(SHOP_NAME);
  await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_sb1', stripe_connect_onboarded = 1 WHERE id = ?")
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  return { shop, staff, service };
}

async function seedSlot(shop: string, staff: string, date: string, time: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bw_availability (id, shop_id, staff_id, slot_date, slot_time, is_booked, booking_id)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`
  )
    .bind(crypto.randomUUID(), shop, staff, date, time)
    .run();
}

async function slotBooked(shop: string, staff: string, date: string, time: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT is_booked FROM bw_availability WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ?"
  )
    .bind(shop, staff, date, time)
    .first<{ is_booked: number }>();
  return Number(row?.is_booked);
}

async function bookingCount(shop: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ?").bind(shop).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

async function bookingStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function seedBooking(
  s: { shop: string; staff: string; service: string },
  opts: {
    status?: string;
    checkedIn?: boolean;
    piId?: string | null;
    depositPence?: number;
    depositTx?: "pending" | null;
    date?: string;
    time?: string;
  } = {}
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '10:30', ?, 2500)`
  )
    .bind(id, s.shop, s.staff, s.service, WHO.name, WHO.email, opts.date ?? FUTURE_DATE, opts.time ?? "10:00", opts.status ?? "confirmed")
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, stripe_payment_intent_id, checked_in_at, updated_at)
     VALUES (?, ?, 'staff', ?, ?, ?, datetime('now'))`
  )
    .bind(id, s.shop, opts.depositPence ?? 0, opts.piId ?? null, opts.checkedIn ? "2099-11-20 10:00:00" : null)
    .run();
  if (opts.depositTx) {
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
       VALUES (?, ?, ?, 'deposit', ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), id, s.shop, opts.depositPence ?? 1250, opts.depositTx, opts.piId ?? "cs_unpaid")
      .run();
  }
  return id;
}

async function outcomeOf(action: string, shop: string, entityId: string): Promise<Record<string, unknown>> {
  const rows = await entriesFor({ action, shopId: shop, entityId });
  expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
  return rows[1]!;
}

describe("staff booking audit", () => {
  const book = async (s: { shop: string; staff: string; service: string }, time: string) =>
    dispatch("POST", `/booking/shops/${s.shop}/bookings`, {
      headers: await authed("admin", s.shop),
      body: {
        serviceId: s.service,
        staffId: s.staff,
        slotDate: FUTURE_DATE,
        slotTime: time,
        customerName: WHO.name,
        customerEmail: WHO.email,
        customerPhone: WHO.phone,
      },
    });

  it("records booking.create with channel staff and no personal data", async () => {
    const s = await setup();
    await seedSlot(s.shop, s.staff, FUTURE_DATE, "10:00");
    const res = await book(s, "10:00");
    expect(res.status).toBe(200);
    const { bookingId } = (await res.json()) as { bookingId: string };
    const outcome = await outcomeOf("booking.create", s.shop, bookingId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "confirmed"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ channel: "staff", deposit_required: true });
    for (const row of await entriesFor({ action: "booking.create", shopId: s.shop })) {
      expectNoPersonalData(row, [WHO.name, WHO.email, WHO.phone, SHOP_NAME]);
    }
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("answers 503, creates no booking and leaves the slot free when the entry cannot be written", async () => {
    const s = await setup();
    await seedSlot(s.shop, s.staff, FUTURE_DATE, "11:00");
    const res = await withAuditOff(() => book(s, "11:00"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await bookingCount(s.shop)).toBe(0);
    expect(await slotBooked(s.shop, s.staff, FUTURE_DATE, "11:00")).toBe(0);
  });
});

describe("walk-in audit", () => {
  async function openToday(s: { shop: string; staff: string }): Promise<void> {
    await env.DB.prepare(
      "INSERT INTO bw_business_days (id, shop_id, date, status, opened_at) VALUES (?, ?, ?, 'open', datetime('now'))"
    )
      .bind(crypto.randomUUID(), s.shop, today())
      .run();
    await seedSlot(s.shop, s.staff, today(), "09:00");
  }
  const walkIn = async (s: { shop: string; staff: string; service: string }) =>
    dispatch("POST", `/booking/shops/${s.shop}/walk-ins`, {
      headers: await authed("staff", s.shop),
      body: { serviceId: s.service, staffId: s.staff, customerName: WHO.name, customerPhone: WHO.phone },
    });

  it("records booking.create with channel walk_in and no personal data", async () => {
    const s = await setup();
    await openToday(s);
    const res = await walkIn(s);
    expect(res.status).toBe(200);
    const { bookingId } = (await res.json()) as { bookingId: string };
    const outcome = await outcomeOf("booking.create", s.shop, bookingId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "staff",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: [null, "confirmed"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ channel: "walk_in" });
    for (const row of await entriesFor({ action: "booking.create", shopId: s.shop })) {
      expectNoPersonalData(row, [WHO.name, WHO.phone, SHOP_NAME]);
    }
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("answers 503 and creates no walk-in when the entry cannot be written", async () => {
    const s = await setup();
    await openToday(s);
    const res = await withAuditOff(() => walkIn(s));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await bookingCount(s.shop)).toBe(0);
    expect(await slotBooked(s.shop, s.staff, today(), "09:00")).toBe(0);
  });
});

describe("check-in audit", () => {
  const checkIn = async (shop: string, staff: string, bookingId: string) =>
    dispatch("POST", `/booking/shops/${shop}/check-in`, {
      headers: await authed("staff", shop),
      body: {
        qrCodeData: JSON.stringify({ bookingId, shopId: shop, staffId: staff, slotDate: FUTURE_DATE, slotTime: "10:00" }),
      },
    });

  it("records booking.check_in with already_checked_in false", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s);
    const res = await checkIn(s.shop, s.staff, bookingId);
    expect(res.status).toBe(200);
    // Pattern B: one committed entry, written in the same batch as the upsert.
    const rows = await entriesFor({ action: "booking.check_in", shopId: s.shop, entityId: bookingId });
    expect(rows.map((r) => r.phase)).toEqual(["done"]);
    const outcome = rows[0]!;
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "staff",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ already_checked_in: false });
    expectNoPersonalData(outcome, [WHO.name, WHO.email, SHOP_NAME]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("does not check the booking in when the entry cannot be written", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s);
    const res = await withAuditOff(() => checkIn(s.shop, s.staff, bookingId));
    // Plan 1 Ruling 9: a failed batch propagates the original error (5xx), so this is not toBe(503).
    expect(res.status).toBeGreaterThanOrEqual(500);
    const st = await env.DB.prepare("SELECT checked_in_at FROM bw_booking_state WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ checked_in_at: string | null }>();
    expect(st?.checked_in_at).toBeNull();
  });
});

describe("checkout audit", () => {
  const checkout = async (shop: string, bookingId: string) =>
    dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: await authed("staff", shop),
      body: {},
    });

  it("records booking.checkout with the status change, our sale id and deposit_captured", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { checkedIn: true });
    const res = await checkout(s.shop, bookingId);
    expect(res.status).toBe(200);
    const { saleId } = (await res.json()) as { saleId: string };
    const outcome = await outcomeOf("booking.checkout", s.shop, bookingId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "staff",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["confirmed", "completed"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ sale_id: saleId, deposit_captured: false });
    expectNoPersonalData(outcome, [WHO.name, WHO.email, SHOP_NAME]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("records deposit_captured true when a held deposit is captured", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { checkedIn: true, piId: "pi_hold_ok", depositPence: 1250 });
    const res = await checkout(s.shop, bookingId);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("booking.checkout", s.shop, bookingId);
    expect((JSON.parse(outcome.details_json as string) as { deposit_captured: boolean }).deposit_captured).toBe(true);
    expectNoPersonalData(outcome, ["pi_hold_ok"]);
  });

  it("a checkout whose balance capture fails records failed and reverts the booking", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { checkedIn: true, piId: "pi_fail_cap", depositPence: 1250 });
    const res = await checkout(s.shop, bookingId);
    expect(res.status).toBe(500);
    expect(await bookingStatus(bookingId)).toBe("confirmed");
    const outcome = await outcomeOf("booking.checkout", s.shop, bookingId);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "HTTP 500" });
    expect(outcome.changes_json).toBeNull();
    expectNoPersonalData(outcome, ["pi_fail_cap"]);
  });

  it("answers 503 and does not complete the booking when the entry cannot be written", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { checkedIn: true });
    const res = await withAuditOff(() => checkout(s.shop, bookingId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await bookingStatus(bookingId)).toBe("confirmed");
  });
});

describe("staff cancel audit", () => {
  const cancel = async (shop: string, bookingId: string, body: Record<string, unknown> = {}) =>
    dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/cancel`, {
      headers: await authed("admin", shop),
      body,
    });

  it("records booking.cancel with the status change and deposit none", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s);
    const res = await cancel(s.shop, bookingId);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("booking.cancel", s.shop, bookingId);
    expect(outcome).toMatchObject({
      outcome: "succeeded",
      actor_type: "admin",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(JSON.parse(outcome.changes_json as string)).toEqual({ status: ["confirmed", "cancelled"] });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ deposit: "none" });
    expectNoPersonalData(outcome, [WHO.name, WHO.email, SHOP_NAME]);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("maps a voided hold to details.deposit voided", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { piId: "pi_hold_void", depositPence: 1250, depositTx: "pending" });
    const res = await cancel(s.shop, bookingId);
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("booking.cancel", s.shop, bookingId);
    expect(JSON.parse(outcome.details_json as string)).toEqual({ deposit: "voided" });
    expectNoPersonalData(outcome, ["pi_hold_void"]);
  });

  it("cancelling an already-cancelled booking records no second status change", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s);
    expect((await cancel(s.shop, bookingId)).status).toBe(200);
    const again = await cancel(s.shop, bookingId);
    expect(again.status).toBe(400);
    const rows = await entriesFor({ action: "booking.cancel", shopId: s.shop, entityId: bookingId });
    const outcomes = rows.filter((r) => r.phase === "outcome");
    expect(outcomes.map((r) => r.outcome)).toEqual(["succeeded", "refused"]);
    expect(outcomes[1]!.changes_json).toBeNull();
    expect(outcomes.filter((r) => r.changes_json !== null).length).toBe(1);
  });

  it("the recovery path voids a stranded hold with details only and no status change", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, {
      status: "cancelled",
      piId: "pi_hold_rec",
      depositPence: 1250,
      depositTx: "pending",
    });
    const res = await cancel(s.shop, bookingId, { refundDeposit: true });
    expect(res.status).toBe(200);
    const outcome = await outcomeOf("booking.cancel", s.shop, bookingId);
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.changes_json).toBeNull();
    expect(JSON.parse(outcome.details_json as string)).toEqual({ deposit: "voided" });
  });

  // Pins a dependency (Ruling P9): staff cancel must leave an unpaid Checkout
  // booking's deposit tx 'pending'. payment_intent.succeeded captures the tx
  // and sets its stripe_id only WHERE status = 'pending', and the recovery
  // refund needs a 'captured' tx. Cancelling the tx would strand a late payment.
  it("a deposit that settles after staff cancel of an unpaid booking stays refundable", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, { status: "pending", piId: null, depositPence: 1250, depositTx: "pending" });
    const res = await cancel(s.shop, bookingId);
    expect(res.status).toBe(200);
    const txOf = () =>
      env.DB.prepare("SELECT status, stripe_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit'")
        .bind(bookingId)
        .first<{ status: string; stripe_id: string }>();
    expect((await txOf())?.status).toBe("pending");

    const piId = `pi_late_${bookingId.slice(0, 8)}`;
    const wh = await postSignedEvent({
      id: `evt_late_${bookingId.slice(0, 8)}`,
      type: "payment_intent.succeeded",
      data: { object: { id: piId, metadata: { bookingId, shopId: s.shop, type: "booking_deposit" } } },
    });
    expect(wh.status).toBe(200);
    expect(await txOf()).toMatchObject({ status: "captured", stripe_id: piId });
    expect(await bookingStatus(bookingId)).toBe("cancelled");

    const refund = await cancel(s.shop, bookingId, { refundDeposit: true });
    expect(refund.status).toBe(200);
    const body = (await refund.json()) as { data: { deposit_action: string } };
    expect(body.data.deposit_action).toBe("refunded");
  });

  it("answers 503 and leaves the booking open when the entry cannot be written", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s);
    const res = await withAuditOff(() => cancel(s.shop, bookingId));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await bookingStatus(bookingId)).toBe("confirmed");
  });
});
