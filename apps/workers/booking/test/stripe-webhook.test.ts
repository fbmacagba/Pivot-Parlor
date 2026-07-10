import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService } from "./helpers";
import { verifyStripeSignature } from "../src/lib/stripe";

/**
 * WS-2: webhook signature verification, event dedup, and reconciliation
 * (account.updated onboarding flip; payment_intent.succeeded settling the
 * ledger). The signing secret is whsec_test (vitest.config.ts).
 */

const SECRET = "whsec_test";
const encoder = new TextEncoder();

async function sigHeader(payload: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${hex}`;
}

async function postEvent(event: Record<string, unknown>, headerOverride?: string) {
  const payload = JSON.stringify(event);
  const header = headerOverride ?? (await sigHeader(payload));
  return dispatch("POST", "/webhooks/stripe", {
    headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
    body: event,
  });
}

describe("verifyStripeSignature", () => {
  it("accepts a valid fresh signature and rejects a tampered payload", async () => {
    const payload = '{"id":"evt_x"}';
    const header = await sigHeader(payload);
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true);
    expect(await verifyStripeSignature('{"id":"evt_y"}', header, SECRET)).toBe(false);
    expect(await verifyStripeSignature(payload, header, "whsec_other")).toBe(false);
    expect(await verifyStripeSignature(payload, undefined, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp (replay window)", async () => {
    const payload = '{"id":"evt_x"}';
    const staleT = Math.floor(Date.now() / 1000) - 3600;
    const header = await sigHeader(payload, SECRET, staleT);
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });
});

describe("POST /webhooks/stripe", () => {
  it("400s an invalid signature", async () => {
    const res = await postEvent(
      { id: "evt_bad", type: "account.updated", data: { object: {} } },
      "t=1,v1=deadbeef"
    );
    expect(res.status).toBe(400);
  });

  it("account.updated flips stripe_connect_onboarded and dedups redelivery", async () => {
    const shop = await seedShop("Webhook Shop");
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_wh1' WHERE id = ?")
      .bind(shop).run();

    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: "account.updated",
      data: { object: { id: "acct_wh1", charges_enabled: true, details_submitted: true } },
    };
    const first = await postEvent(event);
    expect(first.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT stripe_connect_onboarded FROM shops WHERE id = ?")
      .bind(shop)
      .first<{ stripe_connect_onboarded: number }>();
    expect(row?.stripe_connect_onboarded).toBe(1);

    const second = await postEvent(event);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ received: true, duplicate: true });
  });

  it("payment_intent.succeeded settles the balance: tx captured, ledger transferred, completed_at stamped", async () => {
    const shop = await seedShop("Settle Shop");
    const staff = await seedStaff(shop);
    const service = await seedService(shop);
    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount, commission)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-01', '10:00', '10:30', 'completed', 25, 2.5)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, stripe_balance_pi, updated_at)
       VALUES (?, ?, 'pi_bal_1', datetime('now'))`
    ).bind(bookingId, shop).run();
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount, status, stripe_id)
       VALUES (?, ?, ?, 'balance', 15, 'pending', 'pi_bal_1')`
    ).bind(crypto.randomUUID(), bookingId, shop).run();
    await env.DB.prepare(
      `INSERT INTO bw_commission_ledger (id, shop_id, booking_id, services_amount, commission_amount, commission_bearer, status)
       VALUES (?, ?, ?, 25, 2.5, 'shop', 'pending')`
    ).bind(crypto.randomUUID(), shop, bookingId).run();

    const res = await postEvent({
      id: `evt_${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_bal_1", metadata: { bookingId } } },
    });
    expect(res.status).toBe(200);

    const tx = await env.DB
      .prepare("SELECT status FROM bw_transactions WHERE stripe_id = 'pi_bal_1'")
      .first<{ status: string }>();
    expect(tx?.status).toBe("captured");

    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("transferred");

    const state = await env.DB
      .prepare("SELECT completed_at FROM bw_booking_state WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ completed_at: string | null }>();
    expect(state?.completed_at).toBeTruthy();
  });

  it("charge.refunded marks tx and ledger refunded", async () => {
    const shop = await seedShop("Refund Shop");
    const staff = await seedStaff(shop);
    const service = await seedService(shop);
    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount, commission)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-02', '10:00', '10:30', 'completed', 25, 2.5)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount, status, stripe_id)
       VALUES (?, ?, ?, 'balance', 15, 'captured', 'pi_ref_1')`
    ).bind(crypto.randomUUID(), bookingId, shop).run();
    await env.DB.prepare(
      `INSERT INTO bw_commission_ledger (id, shop_id, booking_id, services_amount, commission_amount, commission_bearer, status)
       VALUES (?, ?, ?, 25, 2.5, 'shop', 'transferred')`
    ).bind(crypto.randomUUID(), shop, bookingId).run();

    const res = await postEvent({
      id: `evt_${crypto.randomUUID()}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_ref_1" } },
    });
    expect(res.status).toBe(200);

    const tx = await env.DB
      .prepare("SELECT status FROM bw_transactions WHERE stripe_id = 'pi_ref_1'")
      .first<{ status: string }>();
    expect(tx?.status).toBe("refunded");
    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("refunded");
  });
});
