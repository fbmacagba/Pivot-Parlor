import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { dispatch } from "./request";
import { seedShop, seedStaff, seedService } from "./helpers";

/**
 * WS-2 payment integrity: atomic slot claim before the PaymentIntent,
 * Idempotency-Key on every Stripe money call, atomic checkout transition
 * (no double charge on double submit), no-show deposit capture at close, and
 * Connect Express onboarding. Stripe is faked by the outboundService in
 * vitest.config.ts — PI creation echoes the Idempotency-Key into the id
 * (pi_idem_<key>), so persisted rows prove which key was sent; a PI id
 * containing "fail" makes capture 500.
 */

async function tokenFor(role: string, shopId: string): Promise<string> {
  return sign(
    { sub: `user-${role}`, role, shop_id: shopId, exp: Math.floor(Date.now() / 1000) + 3600 },
    "test-secret"
  );
}

async function seedConnectedShop() {
  const shop = await seedShop("Pay Shop");
  await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_test1' WHERE id = ?")
    .bind(shop)
    .run();
  const staff = await seedStaff(shop);
  const service = await seedService(shop, 30);
  return { shop, staff, service, token: await tokenFor("admin", shop) };
}

async function seedAvailability(shop: string, staff: string, slotDate: string, slotTime: string) {
  await env.DB.prepare(
    `INSERT INTO bw_availability (id, shop_id, staff_id, slot_date, slot_time, is_booked)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).bind(crypto.randomUUID(), shop, staff, slotDate, slotTime).run();
}

describe("deposit booking (POST /booking/shops/:shopId/bookings)", () => {
  it("claims the slot atomically and sends the deterministic Idempotency-Key", async () => {
    const { shop, staff, service, token } = await seedConnectedShop();
    await seedAvailability(shop, staff, "2099-06-15", "10:00");

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        serviceId: service,
        staffId: staff,
        slotDate: "2099-06-15",
        slotTime: "10:00",
        customerName: "Casey",
        customerEmail: "casey@t.local",
        customerPhone: "0",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; bookingId: string };
    expect(body.success).toBe(true);

    // The fake Stripe echoes the Idempotency-Key into the PI id.
    const state = await env.DB
      .prepare("SELECT stripe_payment_intent_id FROM bw_booking_state WHERE booking_id = ?")
      .bind(body.bookingId)
      .first<{ stripe_payment_intent_id: string }>();
    expect(state?.stripe_payment_intent_id).toBe(
      `pi_idem_deposit:${shop}:${staff}:2099-06-15:10:00`
    );

    const av = await env.DB
      .prepare("SELECT is_booked, booking_id FROM bw_availability WHERE shop_id = ? AND slot_time = '10:00'")
      .bind(shop)
      .first<{ is_booked: number; booking_id: string | null }>();
    expect(av?.is_booked).toBe(1);
    expect(av?.booking_id).toBe(body.bookingId);

    // Deposit tx stays pending until the webhook reconciles it.
    const tx = await env.DB
      .prepare("SELECT status, type FROM bw_transactions WHERE booking_id = ?")
      .bind(body.bookingId)
      .first<{ status: string; type: string }>();
    expect(tx).toMatchObject({ type: "deposit", status: "pending" });
  });

  it("a second request for the same slot loses the atomic claim (400, no booking)", async () => {
    const { shop, staff, service, token } = await seedConnectedShop();
    await seedAvailability(shop, staff, "2099-06-16", "11:00");

    const mk = () =>
      dispatch("POST", `/booking/shops/${shop}/bookings`, {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          serviceId: service,
          staffId: staff,
          slotDate: "2099-06-16",
          slotTime: "11:00",
          customerName: "Casey",
          customerEmail: "casey@t.local",
          customerPhone: "0",
        },
      });

    const first = await mk();
    expect(first.status).toBe(200);
    const second = await mk();
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toMatch(/not available/i);

    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ? AND start_time = '11:00'")
      .bind(shop)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("checkout (POST /booking/shops/:shopId/bookings/:bookingId/checkout)", () => {
  async function seedCheckedInBooking(shop: string, staff: string, service: string, piId = "pi_hold_1") {
    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, 'C', 'c@t.local', '2099-01-01', '10:00', '10:30', 'confirmed', 2500, 250)`
    ).bind(bookingId, shop, staff, service).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, deposit_amount_pence, stripe_payment_intent_id, checked_in_at, updated_at)
       VALUES (?, ?, 1000, ?, datetime('now'), datetime('now'))`
    ).bind(bookingId, shop, piId).run();
    // No pre-checkout line items (WS-3): the checkout derives the base service
    // from bookings.amount_pence (2500 above) and creates the sale itself.
    return bookingId;
  }

  it("captures once with honest ledger state and 409s a double submit", async () => {
    const { shop, staff, service, token } = await seedConnectedShop();
    const bookingId = await seedCheckedInBooking(shop, staff, service);

    const first = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(first.status).toBe(200);

    // Balance PI id proves the deterministic key: balance:<bookingId>.
    const state = await env.DB
      .prepare("SELECT stripe_balance_pi, completed_at FROM bw_booking_state WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ stripe_balance_pi: string; completed_at: string | null }>();
    expect(state?.stripe_balance_pi).toBe(`pi_idem_balance:${bookingId}`);
    // Outstanding balance → not settled yet.
    expect(state?.completed_at).toBeNull();

    const ledger = await env.DB
      .prepare("SELECT status FROM bw_commission_ledger WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(ledger?.status).toBe("pending");

    const balTx = await env.DB
      .prepare("SELECT status FROM bw_transactions WHERE booking_id = ? AND type = 'balance'")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(balTx?.status).toBe("pending");

    const second = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    // Sequential double-submit hits the completed pre-check (400); a true
    // race that passes the pre-check loses the atomic claim instead (409).
    expect([400, 409]).toContain(second.status);

    // Exactly one sale with one line item — no duplicates from the losing
    // submit (WS-3: the checkout persists on the sales spine).
    const sales = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sales WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ n: number }>();
    expect(sales?.n).toBe(1);
    const items = await env.DB
      .prepare(
        "SELECT COUNT(*) AS n FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE sa.booking_id = ?"
      )
      .bind(bookingId)
      .first<{ n: number }>();
    expect(items?.n).toBe(1);
    const ledgers = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM bw_commission_ledger WHERE booking_id = ?")
      .bind(bookingId)
      .first<{ n: number }>();
    expect(ledgers?.n).toBe(1);
  });

  it("reverts the status claim when Stripe fails so checkout can be retried", async () => {
    const { shop, staff, service, token } = await seedConnectedShop();
    const bookingId = await seedCheckedInBooking(shop, staff, service, "pi_hold_fail");

    const res = await dispatch("POST", `/booking/shops/${shop}/bookings/${bookingId}/checkout`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { tipPercent: 0 },
    });
    expect(res.status).toBe(500);

    const row = await env.DB
      .prepare("SELECT status FROM bookings WHERE id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");
  });
});

describe("no-show deposit capture at day close", () => {
  it("captures the hold of an un-checked-in booking and rebrands its deposit tx", async () => {
    const { shop, staff, service, token } = await seedConnectedShop();
    const today = new Date().toISOString().slice(0, 10);

    await env.DB.prepare(
      `INSERT INTO bw_business_days (id, shop_id, date, status, opened_at)
       VALUES (?, ?, ?, 'open', datetime('now'))`
    ).bind(crypto.randomUUID(), shop, today).run();

    const bookingId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
        booking_date, start_time, end_time, status, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, 'Ghost', 'g@t.local', ?, '10:00', '10:30', 'confirmed', 2500, 250)`
    ).bind(bookingId, shop, staff, service, today).run();
    await env.DB.prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, deposit_amount_pence, stripe_payment_intent_id, updated_at)
       VALUES (?, ?, 1250, 'pi_ns_1', datetime('now'))`
    ).bind(bookingId, shop).run();
    await env.DB.prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
       VALUES (?, ?, ?, 'deposit', 1250, 'pending', 'pi_ns_1')`
    ).bind(crypto.randomUUID(), bookingId, shop).run();

    const res = await dispatch("POST", `/booking/shops/${shop}/close`, {
      headers: { Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(res.status).toBe(200);

    const booking = await env.DB
      .prepare("SELECT status FROM bookings WHERE id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(booking?.status).toBe("no_show");

    const tx = await env.DB
      .prepare("SELECT type, status FROM bw_transactions WHERE stripe_id = 'pi_ns_1'")
      .first<{ type: string; status: string }>();
    expect(tx).toMatchObject({ type: "no_show_capture", status: "captured" });
  });
});

describe("Connect onboarding (/booking/shops/:shopId/connect)", () => {
  it("creates the Express account once, persists it, and returns an onboarding URL", async () => {
    const shop = await seedShop("Onboard Shop");
    const token = await tokenFor("admin", shop);

    const res = await dispatch("POST", `/booking/shops/${shop}/connect/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { return_url: "https://pivotparlor.com/admin/payments?connect=return", refresh_url: "https://pivotparlor.com/admin/payments?connect=refresh" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { account_id: string; url: string } };
    expect(body.data.account_id).toBe("acct_new_1");
    expect(body.data.url).toContain("connect.stripe.com");

    const row = await env.DB
      .prepare("SELECT stripe_connect_account_id FROM shops WHERE id = ?")
      .bind(shop)
      .first<{ stripe_connect_account_id: string }>();
    expect(row?.stripe_connect_account_id).toBe("acct_new_1");
  });

  it("status polls Stripe and syncs the onboarded flag (webhook backstop)", async () => {
    const shop = await seedShop("Status Shop");
    await env.DB.prepare("UPDATE shops SET stripe_connect_account_id = 'acct_poll_1' WHERE id = ?")
      .bind(shop)
      .run();
    const token = await tokenFor("admin", shop);

    const res = await dispatch("GET", `/booking/shops/${shop}/connect/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboarded: boolean } };
    expect(body.data.onboarded).toBe(true);

    const row = await env.DB
      .prepare("SELECT stripe_connect_onboarded FROM shops WHERE id = ?")
      .bind(shop)
      .first<{ stripe_connect_onboarded: number }>();
    expect(row?.stripe_connect_onboarded).toBe(1);
  });

  it("staff cannot manage the payout account (403)", async () => {
    const shop = await seedShop("Deny Shop");
    const token = await tokenFor("staff", shop);
    const res = await dispatch("POST", `/booking/shops/${shop}/connect/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      body: { return_url: "https://x.test/r", refresh_url: "https://x.test/f" },
    });
    expect(res.status).toBe(403);
  });
});
