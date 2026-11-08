import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { seedService, seedShop, seedStaff } from "./helpers";
import { dispatch } from "./request";
import { expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const REFUSAL = { success: false, error: "Could not record this action; nothing was changed." };
const WHSEC = "whsec_test";
const WHO = { name: "Wendy Webhook", email: "wendy.webhook@test.local" };
const SHOP_NAME = "Webhook Audit Shop";

async function signedRequest(event: Record<string, unknown>): Promise<Request> {
  const payload = JSON.stringify(event);
  const enc = new TextEncoder();
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", enc.encode(WHSEC), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://booking.test/webhooks/stripe", {
    method: "POST",
    headers: { "Stripe-Signature": `t=${t},v1=${hex}`, "Content-Type": "application/json" },
    body: payload,
  });
}

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

/** Post an event through a substituted env (e.g. a Proxy over DB). */
async function postWith(testEnv: typeof env, event: Record<string, unknown>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch((await signedRequest(event)) as never, testEnv as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

const evtId = () => `evt_${crypto.randomUUID()}`;

async function rowsOf(eventId: string): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM audit_log WHERE action = 'payment.stripe.webhook' AND details_json LIKE ? ORDER BY occurred_at, rowid"
  )
    .bind(`%${eventId}%`)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

/** The started + outcome pair of one event. */
async function outcomeOf(eventId: string): Promise<Record<string, unknown>> {
  const rows = await rowsOf(eventId);
  expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
  return rows[1]!;
}

const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

async function setup(): Promise<{ shop: string; staff: string; service: string }> {
  const shop = await seedShop(SHOP_NAME);
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  return { shop, staff, service };
}

async function seedBooking(
  s: { shop: string; staff: string; service: string },
  status = "pending"
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, ?, ?, '2099-11-20', '10:00', '10:30', ?, 2500)`
  )
    .bind(id, s.shop, s.staff, s.service, WHO.name, WHO.email, status)
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, updated_at)
     VALUES (?, ?, 'online', 1250, datetime('now'))`
  )
    .bind(id, s.shop)
    .run();
  return id;
}

async function seedDepositTx(shop: string, bookingId: string, stripeId: string, status = "pending"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
     VALUES (?, ?, ?, 'deposit', 1250, ?, ?)`
  )
    .bind(crypto.randomUUID(), bookingId, shop, status, stripeId)
    .run();
}

async function seedSale(shop: string, status = "pending"): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sales (id, shop_id, subtotal_pence, total_pence, tender_type, status)
     VALUES (?, ?, 2500, 2500, 'stripe', ?)`
  )
    .bind(id, shop, status)
    .run();
  return id;
}

async function bookingStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function dedupeRow(id: string): Promise<unknown> {
  return env.DB.prepare("SELECT id FROM processed_stripe_events WHERE id = ?").bind(id).first();
}

describe("Stripe webhook audit", () => {
  it("account.updated records the shop and the onboarding flip", async () => {
    const s = await setup();
    const acct = `acct_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = ?, stripe_connect_onboarded = 0 WHERE id = ?")
      .bind(acct, s.shop)
      .run();
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "account.updated",
      data: { object: { id: acct, charges_enabled: true, details_submitted: true } },
    });
    expect(res.status).toBe(200);
    const row = await outcomeOf(id);
    expect(row).toMatchObject({
      via: "webhook",
      actor_type: "system",
      outcome: "succeeded",
      shop_id: s.shop,
      entity_type: "shop",
      entity_id: s.shop,
    });
    expect(json(row.changes_json)).toEqual({ stripe_connect_onboarded: [0, 1] });
    expect(json(row.details_json)).toMatchObject({ event_id: id, event_type: "account.updated", handled: true });
    expectNoPersonalData(row, [acct]);
  });

  it("account.updated with no change records no changes", async () => {
    const s = await setup();
    const acct = `acct_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = ?, stripe_connect_onboarded = 1 WHERE id = ?")
      .bind(acct, s.shop)
      .run();
    const id = evtId();
    await postSignedEvent({
      id,
      type: "account.updated",
      data: { object: { id: acct, charges_enabled: true, details_submitted: true } },
    });
    const row = await outcomeOf(id);
    expect(row.shop_id).toBe(s.shop);
    expect(row.changes_json).toBeNull();
  });

  it("account.updated for an unknown account records no shop and handled false", async () => {
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "account.updated",
      data: { object: { id: "acct_nobody_here", charges_enabled: true, details_submitted: true } },
    });
    expect(res.status).toBe(200);
    const row = await outcomeOf(id);
    expect(row.shop_id).toBeNull();
    expect(row.entity_id).toBeNull();
    expect(json(row.details_json)).toMatchObject({ handled: false });
    expectNoPersonalData(row, ["acct_nobody_here"]);
  });

  it("a deposit payment_intent.succeeded records the booking flip", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "pending");
    const piId = `pi_dep_${bookingId.slice(0, 8)}`;
    await seedDepositTx(s.shop, bookingId, "cs_unpaid_1");
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "payment_intent.succeeded",
      data: { object: { id: piId, metadata: { bookingId, shopId: s.shop, type: "booking_deposit" } } },
    });
    expect(res.status).toBe(200);
    expect(await bookingStatus(bookingId)).toBe("confirmed");
    const row = await outcomeOf(id);
    expect(row).toMatchObject({
      via: "webhook",
      actor_type: "system",
      outcome: "succeeded",
      shop_id: s.shop,
      entity_type: "booking",
      entity_id: bookingId,
    });
    expect(json(row.changes_json)).toEqual({ status: ["pending", "confirmed"] });
    expect(json(row.details_json)).toMatchObject({ event_type: "payment_intent.succeeded", handled: true });
    expectNoPersonalData(row, [piId, WHO.name, WHO.email, SHOP_NAME]);
  });

  it("a late deposit on an already cancelled booking records no status change", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "cancelled");
    await seedDepositTx(s.shop, bookingId, "cs_unpaid_2");
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "payment_intent.succeeded",
      data: { object: { id: `pi_late_${bookingId.slice(0, 8)}`, metadata: { bookingId, shopId: s.shop, type: "booking_deposit" } } },
    });
    expect(res.status).toBe(200);
    expect(await bookingStatus(bookingId)).toBe("cancelled");
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ outcome: "succeeded", shop_id: s.shop, entity_type: "booking", entity_id: bookingId });
    expect(row.changes_json).toBeNull();
    expect(json(row.details_json)).toMatchObject({ handled: true, booking_flipped: false });
  });

  it("a sale payment_intent.succeeded records the sale settling", async () => {
    const s = await setup();
    const saleId = await seedSale(s.shop, "pending");
    const piId = `pi_sale_${saleId.slice(0, 8)}`;
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "payment_intent.succeeded",
      data: { object: { id: piId, metadata: { saleId } } },
    });
    expect(res.status).toBe(200);
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ outcome: "succeeded", shop_id: s.shop, entity_type: "sale", entity_id: saleId });
    expect(json(row.changes_json)).toEqual({ status: ["pending", "completed"] });
    expectNoPersonalData(row, [piId]);
  });

  it("a sale that is already completed records no change", async () => {
    const s = await setup();
    const saleId = await seedSale(s.shop, "completed");
    const id = evtId();
    await postSignedEvent({
      id,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_again", metadata: { saleId } } },
    });
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ shop_id: s.shop, entity_type: "sale", entity_id: saleId });
    expect(row.changes_json).toBeNull();
  });

  it("charge.refunded for a sale records details only", async () => {
    const s = await setup();
    const saleId = await seedSale(s.shop, "completed");
    const piId = `pi_ref_${saleId.slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, sale_id, shop_id, type, amount_pence, status, stripe_id)
       VALUES (?, ?, ?, 'balance', 2500, 'captured', ?)`
    )
      .bind(crypto.randomUUID(), saleId, s.shop, piId)
      .run();
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: piId, amount: 2500, amount_refunded: 1000 } },
    });
    expect(res.status).toBe(200);
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ outcome: "succeeded", shop_id: s.shop, entity_type: "sale", entity_id: saleId });
    expect(row.changes_json).toBeNull();
    expect(json(row.details_json)).toMatchObject({ event_type: "charge.refunded", handled: true });
    expectNoPersonalData(row, [piId, "ch_1"]);
  });

  it("charge.refunded for a deposit records the booking, details only", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "cancelled");
    const piId = `pi_depref_${bookingId.slice(0, 8)}`;
    await seedDepositTx(s.shop, bookingId, piId, "captured");
    const id = evtId();
    await postSignedEvent({
      id,
      type: "charge.refunded",
      data: { object: { id: "ch_2", payment_intent: piId, amount: 1250, amount_refunded: 1250 } },
    });
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ shop_id: s.shop, entity_type: "booking", entity_id: bookingId });
    expect(row.changes_json).toBeNull();
    expect(json(row.details_json)).toMatchObject({ handled: true });
  });

  it("checkout.session.expired records the cancel", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "pending");
    const sessionId = `cs_exp_${bookingId.slice(0, 8)}`;
    await env.DB.prepare("UPDATE bw_booking_state SET stripe_checkout_session_id = ? WHERE booking_id = ?")
      .bind(sessionId, bookingId)
      .run();
    await seedDepositTx(s.shop, bookingId, sessionId);
    const id = evtId();
    const res = await postSignedEvent({
      id,
      type: "checkout.session.expired",
      data: { object: { id: sessionId, metadata: { bookingId, type: "booking_deposit" } } },
    });
    expect(res.status).toBe(200);
    expect(await bookingStatus(bookingId)).toBe("cancelled");
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ outcome: "succeeded", shop_id: s.shop, entity_type: "booking", entity_id: bookingId });
    expect(json(row.changes_json)).toEqual({ status: ["pending", "cancelled"] });
    expectNoPersonalData(row, [sessionId]);
  });

  it("checkout.session.expired on a booking that is no longer pending records no change", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "cancelled");
    const sessionId = `cs_exp2_${bookingId.slice(0, 8)}`;
    await env.DB.prepare("UPDATE bw_booking_state SET stripe_checkout_session_id = ? WHERE booking_id = ?")
      .bind(sessionId, bookingId)
      .run();
    const id = evtId();
    await postSignedEvent({
      id,
      type: "checkout.session.expired",
      data: { object: { id: sessionId, metadata: { bookingId, type: "booking_deposit" } } },
    });
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ shop_id: s.shop, entity_type: "booking", entity_id: bookingId });
    expect(row.changes_json).toBeNull();
  });

  it("charge.dispute.created and unhandled types record handled false with no entity", async () => {
    for (const type of ["charge.dispute.created", "customer.created"]) {
      const id = evtId();
      const res = await postSignedEvent({ id, type, data: { object: { id: "dp_1", payment_intent: "pi_none" } } });
      expect(res.status).toBe(200);
      const row = await outcomeOf(id);
      expect(row).toMatchObject({ via: "webhook", actor_type: "system", outcome: "succeeded", shop_id: null, entity_id: null });
      expect(json(row.details_json)).toMatchObject({ event_type: type, handled: false });
    }
  });

  it("a redelivered event records a duplicate, not a second change", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "pending");
    await seedDepositTx(s.shop, bookingId, "cs_unpaid_3");
    const id = evtId();
    const event = {
      id,
      type: "payment_intent.succeeded",
      data: { object: { id: `pi_dup_${bookingId.slice(0, 8)}`, metadata: { bookingId, shopId: s.shop, type: "booking_deposit" } } },
    };
    const first = await postSignedEvent(event);
    expect(first.status).toBe(200);
    const second = await postSignedEvent(event);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    const rows = await rowsOf(id);
    expect(rows.map((r) => `${r.phase}:${r.outcome ?? ""}`)).toEqual([
      "started:",
      "outcome:succeeded",
      "started:",
      "outcome:succeeded",
    ]);
    expect(json(rows[1]!.changes_json)).toEqual({ status: ["pending", "confirmed"] });
    expect(rows[3]!.changes_json).toBeNull();
    expect(json(rows[3]!.details_json)).toMatchObject({ duplicate: true, event_id: id });
  });

  it("a handler failure records failed and keeps the event retryable", async () => {
    const s = await setup();
    const acct = `acct_${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = ? WHERE id = ?").bind(acct, s.shop).run();
    const id = evtId();
    const realDb = env.DB;
    const failingDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("UPDATE shops SET stripe_connect_onboarded")) throw new Error("simulated handler failure");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await postWith({ ...env, DB: failingDb } as typeof env, {
      id,
      type: "account.updated",
      data: { object: { id: acct, charges_enabled: true, details_submitted: true } },
    });
    expect(res.status).toBe(500);
    expect(await dedupeRow(id)).toBeNull();
    const row = await outcomeOf(id);
    expect(row).toMatchObject({ outcome: "failed", reason: "HTTP 500" });
    expect(row.changes_json).toBeNull();
    // Retryable: the same event now processes normally.
    const retry = await postSignedEvent({
      id,
      type: "account.updated",
      data: { object: { id: acct, charges_enabled: true, details_submitted: true } },
    });
    expect(retry.status).toBe(200);
  });

  it("an event whose started entry cannot be written answers 503 and is not deduped", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "pending");
    await seedDepositTx(s.shop, bookingId, "cs_unpaid_4");
    const id = evtId();
    const res = await withAuditOff(() =>
      postSignedEvent({
        id,
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_503", metadata: { bookingId, shopId: s.shop, type: "booking_deposit" } } },
      })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSAL);
    expect(await dedupeRow(id)).toBeNull();
    expect(await bookingStatus(bookingId)).toBe("pending");
  });

  it("leaves no audit.gap row", async () => {
    const id = evtId();
    const res = await postSignedEvent({ id, type: "customer.created", data: { object: { id: "cus_1" } } });
    expect(res.status).toBe(200);
    expect(await gapRowsFor(res.headers.get("X-Request-Id")!)).toBe(0);
  });

  it("a request with a bad signature writes no entry", async () => {
    const id = evtId();
    const res = await dispatch("POST", "/webhooks/stripe", {
      headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
      body: { id, type: "customer.created", data: { object: {} } },
    });
    expect(res.status).toBe(400);
    expect(await rowsOf(id)).toHaveLength(0);
  });

  it("no Stripe object id or URL reaches the trail", async () => {
    const s = await setup();
    const bookingId = await seedBooking(s, "pending");
    const sessionId = `cs_secret_${bookingId.slice(0, 8)}`;
    const piId = `pi_secret_${bookingId.slice(0, 8)}`;
    const acct = `acct_secret_${bookingId.slice(0, 8)}`;
    const chargeId = `ch_secret_${bookingId.slice(0, 8)}`;
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = ? WHERE id = ?").bind(acct, s.shop).run();
    await env.DB.prepare("UPDATE bw_booking_state SET stripe_checkout_session_id = ? WHERE booking_id = ?")
      .bind(sessionId, bookingId)
      .run();
    await seedDepositTx(s.shop, bookingId, sessionId);
    const ids: string[] = [];
    const post = async (type: string, object: Record<string, unknown>) => {
      const id = evtId();
      ids.push(id);
      expect((await postSignedEvent({ id, type, data: { object } })).status).toBe(200);
    };
    await post("account.updated", { id: acct, charges_enabled: true, details_submitted: true });
    await post("payment_intent.succeeded", {
      id: piId,
      url: "https://checkout.stripe.com/c/pay/secret",
      metadata: { bookingId, shopId: s.shop, type: "booking_deposit" },
    });
    await post("charge.refunded", { id: chargeId, payment_intent: piId, amount: 1250, amount_refunded: 1250 });
    await post("checkout.session.expired", { id: sessionId, metadata: { bookingId, type: "booking_deposit" } });
    for (const id of ids) {
      for (const row of await rowsOf(id)) {
        expectNoPersonalData(row, [piId, sessionId, acct, chargeId, "checkout.stripe.com", WHO.name, WHO.email, SHOP_NAME]);
      }
    }
  });
});
