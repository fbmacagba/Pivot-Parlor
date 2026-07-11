import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, tokenFor } from "./helpers";

/**
 * SEC-3 (WS-7): /api/me matches bookings purely on customer_email, so the
 * surface must stay closed until address ownership is proven. Password
 * self-registration starts unverified; the everify:<token> KV flow flips the
 * flag. (In tests RESEND_API_KEY is unset, so no email goes out — the token
 * is read straight from KV.)
 */

async function setVerified(userId: string, value: 0 | 1) {
  await env.DB.prepare("UPDATE platform_users SET email_verified = ? WHERE id = ?")
    .bind(value, userId)
    .run();
}

async function emailOf(userId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT email FROM platform_users WHERE id = ?")
    .bind(userId)
    .first<{ email: string }>();
  return row!.email;
}

async function seedCancellableBooking(shopId: string, customerEmail: string): Promise<string> {
  const staffId = await seedStaff(shopId);
  const serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)"
  )
    .bind(serviceId, shopId)
    .run();
  const id = crypto.randomUUID();
  // Far-future start so the 2h online-cancel window never interferes.
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', ?, '2099-06-15', '2099-06-15T10:00:00.000Z', '2099-06-15T10:30:00.000Z', 'confirmed', 2500)`
  )
    .bind(id, shopId, staffId, serviceId, customerEmail)
    .run();
  return id;
}

describe("SEC-3: /api/me email-verified gate", () => {
  it("blocks bookings list + cancel for an unverified customer, then allows once verified", async () => {
    const shop = await seedShop("SEC3 Shop");
    const userId = await seedUser("customer", null); // seeded rows default to unverified
    const token = await tokenFor(userId, "customer", null);
    const bookingId = await seedCancellableBooking(shop, await emailOf(userId));

    const blockedList = await dispatch("GET", "/api/me/bookings", { headers: authHeaders(token) });
    expect(blockedList.status).toBe(403);
    const listBody = await blockedList.json<{ code?: string }>();
    expect(listBody.code).toBe("email_unverified");

    const blockedCancel = await dispatch("POST", `/api/me/bookings/${bookingId}/cancel`, {
      headers: authHeaders(token),
    });
    expect(blockedCancel.status).toBe(403);
    const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?")
      .bind(bookingId)
      .first<{ status: string }>();
    expect(row?.status).toBe("confirmed");

    await setVerified(userId, 1);

    const okList = await dispatch("GET", "/api/me/bookings", { headers: authHeaders(token) });
    expect(okList.status).toBe(200);
    const okBody = await okList.json<{ success: boolean; data: { upcoming: unknown[] } }>();
    expect(okBody.success).toBe(true);
    expect(okBody.data.upcoming.length).toBe(1);

    const okCancel = await dispatch("POST", `/api/me/bookings/${bookingId}/cancel`, {
      headers: authHeaders(token),
    });
    expect(okCancel.status).toBe(200);
  });

  it("register → everify token in KV → POST /auth/verify-email flips the flag once", async () => {
    const email = `verifyme-${crypto.randomUUID()}@test.local`;
    const reg = await dispatch("POST", "/auth/register", {
      headers: { "CF-Connecting-IP": "203.0.113.50" },
      body: { name: "Vera", email, password: "pw-123456" },
    });
    expect(reg.status).toBe(201);
    const regBody = await reg.json<{ data: { id: string; verification_email_sent: boolean } }>();
    // No RESEND_API_KEY in tests — the token exists but no email goes out.
    expect(regBody.data.verification_email_sent).toBe(false);

    const before = await env.DB.prepare("SELECT email_verified FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ email_verified: number }>();
    expect(before?.email_verified).toBe(0);

    const list = await env.KV.list({ prefix: "everify:" });
    expect(list.keys.length).toBe(1);
    const token = list.keys[0]!.name.slice("everify:".length);

    const verify = await dispatch("POST", "/auth/verify-email", {
      headers: { "CF-Connecting-IP": "203.0.113.51" },
      body: { token },
    });
    expect(verify.status).toBe(200);

    const after = await env.DB.prepare("SELECT email_verified FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ email_verified: number }>();
    expect(after?.email_verified).toBe(1);

    // Single-use: the consumed token is gone.
    const replay = await dispatch("POST", "/auth/verify-email", {
      headers: { "CF-Connecting-IP": "203.0.113.51" },
      body: { token },
    });
    expect(replay.status).toBe(400);
  });

  it("rejects garbage verify tokens", async () => {
    const res = await dispatch("POST", "/auth/verify-email", {
      headers: { "CF-Connecting-IP": "203.0.113.52" },
      body: { token: "not-a-real-token" },
    });
    expect(res.status).toBe(400);
  });

  it("resend-verification mints a fresh token (502 without a mail transport) and 400s when already verified", async () => {
    const userId = await seedUser("customer", null);
    const token = await tokenFor(userId, "customer", null);

    // Unverified: a token is minted even though sending fails (no RESEND key).
    const resend = await dispatch("POST", "/auth/resend-verification", {
      headers: authHeaders(token),
    });
    expect(resend.status).toBe(502);
    const list = await env.KV.list({ prefix: "everify:" });
    expect(list.keys.length).toBe(1);

    await setVerified(userId, 1);
    const already = await dispatch("POST", "/auth/resend-verification", {
      headers: authHeaders(token),
    });
    expect(already.status).toBe(400);
  });

  it("developer-provisioned accounts are born verified", async () => {
    const devToken = await tokenFor(await seedUser("developer", null), "developer", null);
    const email = `provisioned-${crypto.randomUUID()}@test.local`;
    const res = await dispatch("POST", "/auth/register", {
      headers: { ...authHeaders(devToken), "CF-Connecting-IP": "203.0.113.53" },
      body: { name: "Owner", email, password: "pw-123456", role: "admin" },
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT email_verified FROM platform_users WHERE email = ?")
      .bind(email)
      .first<{ email_verified: number }>();
    expect(row?.email_verified).toBe(1);
  });
});
