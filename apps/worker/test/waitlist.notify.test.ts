/**
 * Waitlist slot-opened notifications: the explicit POST /:id/notify endpoint
 * (scoping, idempotent claim, revert-on-failure) and the automatic hooks on
 * both cancellation paths (admin status change, customer self-cancel).
 *
 * Resend interception: tests and the worker share one isolate (dispatch calls
 * worker.fetch directly), so stubbing globalThis.fetch catches the email
 * service's outbound call. This pool version exports no fetchMock from
 * cloudflare:test, and D1/KV/service bindings bypass global fetch, so the
 * stub only ever sees the Resend request.
 */
import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { claimWaitlistNotification } from "../src/db/queries";
import { authHeaders, seedShop, seedStaff, seedUser, seedWaitlistEntry, tokenFor } from "./helpers";
import { dispatch } from "./request";

const testEnv = env as unknown as Record<string, string | undefined>;

const realFetch = globalThis.fetch;
interface ResendCall {
  to: string;
  subject: string;
  html: string;
}
let resendCalls: ResendCall[] = [];
let resendStatus = 200;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      const parsed = raw ? (JSON.parse(String(raw)) as ResendCall) : ({} as ResendCall);
      resendCalls.push({ to: parsed.to, subject: parsed.subject, html: parsed.html });
      return new Response(
        resendStatus === 200 ? JSON.stringify({ id: "email-id" }) : "boom",
        { status: resendStatus },
      );
    }
    return realFetch(input as never, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  delete testEnv.RESEND_API_KEY;
  resendCalls = [];
  resendStatus = 200;
});

async function statusOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM waitlist WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

async function seedService(shopId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, is_active) VALUES (?, ?, 'Cut', 30, 2500, 1)"
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedConfirmedBooking(
  shopId: string,
  staffId: string,
  opts: { date: string; email?: string; hoursFromNow?: number } = { date: "2027-06-01" }
): Promise<string> {
  const serviceId = await seedService(shopId);
  const id = crypto.randomUUID();
  const start = new Date(Date.now() + (opts.hoursFromNow ?? 72) * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', ?, ?, ?, ?, 'confirmed', 2500)`
  )
    .bind(
      id,
      shopId,
      staffId,
      serviceId,
      opts.email ?? "cust@test.local",
      opts.date,
      start.toISOString(),
      end.toISOString()
    )
    .run();
  return id;
}

// ─── POST /api/waitlist/:id/notify ───────────────────────────────────────────

describe("POST /api/waitlist/:id/notify", () => {
  it("scopes like the PATCH route: foreign admin 404, customer 403, unknown 404", async () => {
    const shopA = await seedShop("Notify A");
    const shopB = await seedShop("Notify B");
    const entryB = await seedWaitlistEntry(shopB);
    const adminA = await tokenFor(await seedUser("admin", shopA), "admin", shopA);
    const customer = await tokenFor(await seedUser("customer", null), "customer", null);

    const foreign = await dispatch("POST", `/api/waitlist/${entryB}/notify`, {
      headers: authHeaders(adminA),
    });
    expect(foreign.status).toBe(404);

    const cust = await dispatch("POST", `/api/waitlist/${entryB}/notify`, {
      headers: authHeaders(customer),
    });
    expect(cust.status).toBe(403);

    const unknown = await dispatch("POST", `/api/waitlist/does-not-exist/notify`, {
      headers: authHeaders(adminA),
    });
    expect(unknown.status).toBe(404);

    expect(await statusOf(entryB)).toBe("waiting");
  });

  it("returns 503 and leaves the entry waiting when email is not configured", async () => {
    const shop = await seedShop("Notify NoKey");
    const entry = await seedWaitlistEntry(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    const res = await dispatch("POST", `/api/waitlist/${entry}/notify`, {
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(503);
    expect(await statusOf(entry)).toBe("waiting");
  });

  it("sends exactly one email, marks notified, and is idempotent on a second call", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Notify Happy");
    const entry = await seedWaitlistEntry(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    const first = await dispatch("POST", `/api/waitlist/${entry}/notify`, {
      headers: authHeaders(admin),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { notified: boolean } };
    expect(firstBody.data.notified).toBe(true);
    expect(await statusOf(entry)).toBe("notified");
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].to).toBe(`${entry}@test.local`);
    expect(resendCalls[0].subject).toContain("A slot just opened");

    const second = await dispatch("POST", `/api/waitlist/${entry}/notify`, {
      headers: authHeaders(admin),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: { notified: boolean; already_notified?: boolean };
    };
    expect(secondBody.data.notified).toBe(false);
    expect(secondBody.data.already_notified).toBe(true);
    expect(resendCalls).toHaveLength(1); // no second send
  });

  it("rejects booked/expired entries with 400", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    const shop = await seedShop("Notify Closed");
    const entry = await seedWaitlistEntry(shop, { status: "booked" });
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    const res = await dispatch("POST", `/api/waitlist/${entry}/notify`, {
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(400);
    expect(await statusOf(entry)).toBe("booked");
  });

  it("reverts to waiting when Resend fails", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    resendStatus = 500;

    const shop = await seedShop("Notify Fail");
    const entry = await seedWaitlistEntry(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);

    const res = await dispatch("POST", `/api/waitlist/${entry}/notify`, {
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(502);
    expect(await statusOf(entry)).toBe("waiting");
  });

  it("escapes HTML from the public signup fields in the outgoing email", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Notify Escape");
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const entryId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO waitlist (id, shop_id, customer_name, customer_email)
       VALUES (?, ?, ?, 'victim@test.local')`
    )
      .bind(entryId, shop, `<img src=x onerror=alert(1)>Mallory`)
      .run();

    const res = await dispatch("POST", `/api/waitlist/${entryId}/notify`, {
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(200);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].html).not.toContain("<img src=x");
    expect(resendCalls[0].html).toContain("&lt;img src=x");
  });
});

// ─── Cancellation hooks ──────────────────────────────────────────────────────

describe("waitlist auto-notify on booking cancellation", () => {
  it("notifies matching + wildcard entries up to the cap of 3", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Hook Cap");
    const staffId = await seedStaff(shop);
    const otherStaff = await seedStaff(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const bookingId = await seedConfirmedBooking(shop, staffId, { date: "2027-06-01" });

    // Seeded in age order (helpers uid is monotonic, created_at identical
    // granularity so ORDER BY created_at keeps insert order via rowid tiebreak
    // is NOT guaranteed — assert set membership, not order).
    const matchDate = await seedWaitlistEntry(shop, { preferredDate: "2027-06-01" });
    const wildcard = await seedWaitlistEntry(shop); // NULL date + NULL staff
    const matchBoth = await seedWaitlistEntry(shop, {
      preferredDate: "2027-06-01",
      staffId,
    });
    const wrongDate = await seedWaitlistEntry(shop, { preferredDate: "2027-12-25" });
    const wrongStaff = await seedWaitlistEntry(shop, {
      preferredDate: "2027-06-01",
      staffId: otherStaff,
    });
    const fourthMatch = await seedWaitlistEntry(shop, { preferredDate: "2027-06-01" });

    const res = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(res.status).toBe(200);

    // Exactly 3 of the 4 eligible entries flipped (the cap); which three is
    // timestamp-tied (second granularity) so assert the count, not the order.
    const eligible = [matchDate, wildcard, matchBoth, fourthMatch];
    const statuses = await Promise.all(eligible.map(statusOf));
    expect(statuses.filter((s) => s === "notified")).toHaveLength(3);
    expect(statuses.filter((s) => s === "waiting")).toHaveLength(1);
    expect(await statusOf(wrongDate)).toBe("waiting");
    expect(await statusOf(wrongStaff)).toBe("waiting");
    expect(resendCalls).toHaveLength(3);
    // Every recipient is an eligible entry; the ineligible two never emailed.
    const eligibleEmails = new Set(eligible.map((id) => `${id}@test.local`));
    for (const call of resendCalls) expect(eligibleEmails.has(call.to)).toBe(true);
  });

  it("does not fire on a non-cancellation transition or without RESEND_API_KEY", async () => {
    const shop = await seedShop("Hook NoKey");
    const staffId = await seedStaff(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const entry = await seedWaitlistEntry(shop, { preferredDate: "2027-06-02" });

    // No RESEND_API_KEY: cancellation still succeeds, entry untouched.
    const b1 = await seedConfirmedBooking(shop, staffId, { date: "2027-06-02" });
    const cancelled = await dispatch("PUT", `/api/shops/${shop}/bookings/${b1}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(cancelled.status).toBe(200);
    expect(await statusOf(entry)).toBe("waiting");

    // With a key but a completed transition: hook must not fire (no interceptor
    // is registered for the review email either, so completed also proves the
    // review block is gated separately — use no_show to avoid that path).
    testEnv.RESEND_API_KEY = "test-key";
    const b2 = await seedConfirmedBooking(shop, staffId, { date: "2027-06-02" });
    const noShow = await dispatch("PUT", `/api/shops/${shop}/bookings/${b2}/status`, {
      headers: authHeaders(admin),
      body: { status: "no_show" },
    });
    expect(noShow.status).toBe(200);
    expect(await statusOf(entry)).toBe("waiting");
  });

  it("does not re-fire on a cancelled to cancelled re-save", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Hook Resave");
    const staffId = await seedStaff(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const bookingId = await seedConfirmedBooking(shop, staffId, { date: "2027-06-04" });
    await seedWaitlistEntry(shop, { preferredDate: "2027-06-04" });
    // Pre-seed extra waiting entries so a second fan-out would have targets.
    await seedWaitlistEntry(shop, { preferredDate: "2027-06-04" });

    const first = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(first.status).toBe(200);
    expect(resendCalls).toHaveLength(2);

    const resave = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(resave.status).toBe(200); // contract unchanged
    expect(resendCalls).toHaveLength(2); // no second fan-out
  });

  it("does not fire for a past-dated booking (housekeeping cancellations)", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Hook Past");
    const staffId = await seedStaff(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const entry = await seedWaitlistEntry(shop); // wildcard, would match any date
    const bookingId = await seedConfirmedBooking(shop, staffId, {
      date: "2026-01-05",
      hoursFromNow: -48,
    });

    const res = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(res.status).toBe(200);
    expect(await statusOf(entry)).toBe("waiting");
    expect(resendCalls).toHaveLength(0);
  });

  it("reverts entries and still returns 200 when every send fails", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    resendStatus = 500;

    const shop = await seedShop("Hook SendFail");
    const staffId = await seedStaff(shop);
    const admin = await tokenFor(await seedUser("admin", shop), "admin", shop);
    const e1 = await seedWaitlistEntry(shop, { preferredDate: "2027-06-05" });
    const e2 = await seedWaitlistEntry(shop, { preferredDate: "2027-06-05" });
    const bookingId = await seedConfirmedBooking(shop, staffId, { date: "2027-06-05" });

    const res = await dispatch("PUT", `/api/shops/${shop}/bookings/${bookingId}/status`, {
      headers: authHeaders(admin),
      body: { status: "cancelled" },
    });
    expect(res.status).toBe(200); // fan-out failures are non-fatal
    // Both entries attempted exactly once (the tried-set prevents retry loops)
    // and both reverted so no customer is stranded as notified with no email.
    expect(resendCalls).toHaveLength(2);
    expect(await statusOf(e1)).toBe("waiting");
    expect(await statusOf(e2)).toBe("waiting");
  });

  it("claim is atomic: the WHERE status='waiting' filter yields exactly one winner", async () => {
    const shop = await seedShop("Claim Atomic");
    const entry = await seedWaitlistEntry(shop);

    const first = await claimWaitlistNotification(env.DB, entry);
    expect(first.meta.changes).toBe(1);
    expect(await statusOf(entry)).toBe("notified");

    // Any subsequent claim (double-click, concurrent fan-out) must lose.
    const second = await claimWaitlistNotification(env.DB, entry);
    expect(second.meta.changes).toBe(0);
    expect(await statusOf(entry)).toBe("notified");
  });

  it("fires on the customer self-cancel path", async () => {
    testEnv.RESEND_API_KEY = "test-key";

    const shop = await seedShop("Hook SelfCancel");
    const staffId = await seedStaff(shop);
    const entry = await seedWaitlistEntry(shop, { preferredDate: "2027-06-03" });

    const customerId = await seedUser("customer", null);
    const email = `${customerId}@test.local`;
    await env.DB.prepare("UPDATE platform_users SET email = ?, email_verified = 1 WHERE id = ?")
      .bind(email, customerId)
      .run();
    const token = await tokenFor(customerId, "customer", null);

    const bookingId = await seedConfirmedBooking(shop, staffId, {
      date: "2027-06-03",
      email,
      hoursFromNow: 72,
    });

    const res = await dispatch("POST", `/api/me/bookings/${bookingId}/cancel`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    expect(await statusOf(entry)).toBe("notified");
  });
});
