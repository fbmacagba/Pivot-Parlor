/** Audit trail Plan 2, Task 6: admin booking status (three forks), the
 *  customer's own cancel and profile, the walk-in queue, and the waitlist
 *  (join, status, manual notify, and the slot-open emails a cancel sends).
 *
 *  Resend interception follows waitlist.notify.test.ts: tests and the worker
 *  share one isolate, so stubbing globalThis.fetch catches the email
 *  service's outbound call. It is installed for the whole file, so no test
 *  that sets RESEND_API_KEY can reach the real API. */
import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_REFUSED_MESSAGE, systemAudit } from "../src/audit/context";
import { notifyWaitlistForOpenedSlot } from "../src/services/waitlist-notify";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedStaff, seedUser, seedWaitlistEntry, tokenFor } from "./helpers";
import { adminToken, devToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const testEnv = env as unknown as Record<string, string | undefined>;
const realFetch = globalThis.fetch;
let resendCalls: string[] = [];
let resendStatus = 200;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
      const parsed = raw ? (JSON.parse(String(raw)) as { to?: string }) : {};
      resendCalls.push(String(parsed.to ?? ""));
      return new Response(resendStatus === 200 ? JSON.stringify({ id: "email-id" }) : "boom", { status: resendStatus });
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

const REFUSED = { success: false, error: AUDIT_REFUSED_MESSAGE };

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

async function rowsForRequest(requestId: string): Promise<number> {
  expect(requestId, "rowsForRequest needs the response's X-Request-Id").toMatch(/.+/);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ?")
    .bind(requestId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function fullRow(entityId: string, action: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY rowid DESC LIMIT 1")
    .bind(entityId, action)
    .first<Record<string, unknown>>();
  expect(row, `no ${action} row for ${entityId}`).toBeTruthy();
  return row!;
}

function phasesAndOutcomes(rows: Record<string, unknown>[]) {
  return rows.map((r) => [r.phase, r.outcome ?? null]);
}

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
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

async function seedBooking(
  shopId: string,
  opts: { status?: string; email?: string; staffId?: string; date?: string } = {}
): Promise<{ id: string; staffId: string; date: string }> {
  const staffId = opts.staffId ?? (await seedStaff(shopId));
  const serviceId = await seedService(shopId);
  const id = crypto.randomUUID();
  const start = new Date(Date.now() + 72 * 3_600_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const date = opts.date ?? start.toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence)
     VALUES (?, ?, ?, ?, 'Cust', ?, ?, ?, ?, ?, 2500)`
  )
    .bind(id, shopId, staffId, serviceId, opts.email ?? "cust@test.local", date, start.toISOString(), end.toISOString(), opts.status ?? "confirmed")
    .run();
  return { id, staffId, date };
}

async function bookingStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

async function waitlistStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM waitlist WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

/** A waitlist entry with distinctive personal values, so a leak is findable. */
async function seedNamedWaitlistEntry(
  shopId: string,
  opts: { preferredDate?: string | null; status?: string } = {}
): Promise<{ id: string; name: string; email: string }> {
  const id = crypto.randomUUID();
  const name = "Philomena Brackenridge";
  const email = `philomena-${crypto.randomUUID()}@bracken.test`;
  await env.DB.prepare(
    `INSERT INTO waitlist (id, shop_id, customer_name, customer_email, preferred_date, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, shopId, name, email, opts.preferredDate ?? null, opts.status ?? "waiting")
    .run();
  return { id, name, email };
}

/** A customer with a verified email and a live session. */
async function verifiedCustomer(): Promise<{ id: string; email: string; headers: Record<string, string> }> {
  const id = await seedUser("customer", null);
  const email = `${id}@test.local`;
  await env.DB.prepare("UPDATE platform_users SET email_verified = 1 WHERE id = ?").bind(id).run();
  return { id, email, headers: authHeaders(await tokenFor(id, "customer", null)) };
}

async function seedFakeCapturedDeposit(shopId: string, bookingId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence,
       deposit_application_fee_pence, deposit_paid_at, stripe_payment_intent_id, updated_at)
     VALUES (?, ?, 'online', 1250, 125, datetime('now'), 'pi_audit_fork', datetime('now'))`
  )
    .bind(bookingId, shopId)
    .run();
  await env.DB.prepare(
    `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
     VALUES (?, ?, ?, 'deposit', 1250, 'captured', 'pi_audit_fork')`
  )
    .bind(crypto.randomUUID(), bookingId, shopId)
    .run();
}

// ─── PUT /api/shops/:shopId/bookings/:bookingId/status ───────────────────────

describe("admin booking status", () => {
  async function setup() {
    const shopId = await seedShop("Audit Bookings Shop");
    const admin = await adminToken(shopId);
    return { shopId, adminId: admin.id, headers: authHeaders(admin.token) };
  }

  it("local cancel records the flip once", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    const url = `/api/shops/${shopId}/bookings/${id}/status`;

    const first = await dispatch("PUT", url, { headers, body: { status: "cancelled" } });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });
    const resave = await dispatch("PUT", url, { headers, body: { status: "cancelled" } });
    expect(resave.status).toBe(200);
    expect(await resave.json()).toEqual({ success: true });

    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([
      ["started", null],
      ["outcome", "succeeded"],
      ["started", null],
      ["outcome", "succeeded"],
    ]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("booking");
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ flipped: true });
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["confirmed", "cancelled"] });
    // The re-save performs no open -> cancelled transition: no change claimed.
    expect(JSON.parse(rows[3]!.details_json as string)).toEqual({ flipped: false });
    expect(rows[3]!.changes_json).toBeNull();
    expect(await bookingStatus(id)).toBe("cancelled");
    expect(await gapRowsFor(rid(first))).toBe(0);
    expect(await gapRowsFor(rid(resave))).toBe(0);
  });

  it("local cancel refuses before changing when the started entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, { headers, body: { status: "cancelled" } }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSED);
    expect(await bookingStatus(id)).toBe("confirmed");
  });

  it("deposit cancel records the forward and its outcome", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    await seedFakeCapturedDeposit(shopId, id);
    const res = await dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, {
      headers,
      body: { status: "cancelled", refund_deposit: true },
    });
    expect(res.status).toBe(201); // the echo stub answers 201 for POST
    const body = (await res.json()) as { data: { stub: string; url: string } };
    expect(body.data.stub).toBe("BOOKING");
    expect(body.data.url).toContain(`/booking/shops/${shopId}/bookings/${id}/cancel`);

    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("booking");
    expect(rows[1]!.reason).toBeNull();
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ deposit: true, refund_deposit: true });
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ deposit: true, refund_deposit: true });
    expect(rows[1]!.changes_json).toBeNull();
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("deposit cancel with no refund choice records refund_deposit null", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    await seedFakeCapturedDeposit(shopId, id);
    const res = await dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, {
      headers,
      body: { status: "cancelled" },
    });
    expect(res.status).toBe(201);
    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ deposit: true, refund_deposit: null });
  });

  it("deposit cancel refuses before the forward when the started entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    await seedFakeCapturedDeposit(shopId, id);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, {
        headers,
        body: { status: "cancelled", refund_deposit: true },
      }),
    );
    // The refusal, not the echo stub's 201: the forward never ran.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSED);
  });

  it("status completed records booking.status before and after", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    const url = `/api/shops/${shopId}/bookings/${id}/status`;
    const res = await dispatch("PUT", url, { headers, body: { status: "completed" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const again = await dispatch("PUT", url, { headers, body: { status: "completed" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true });

    const rows = await entriesFor({ action: "booking.status", shopId, entityId: id });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.phase).toBe("done");
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.entity_type).toBe("booking");
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ status: ["confirmed", "completed"] });
    // A same-status re-save claims no change.
    expect(rows[1]!.changes_json).toBeNull();
    expect(await bookingStatus(id)).toBe("completed");
    expect(await gapRowsFor(rid(res))).toBe(0);
    expect(await gapRowsFor(rid(again))).toBe(0);
  });

  it("a status change changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id } = await seedBooking(shopId);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, { headers, body: { status: "no_show" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await bookingStatus(id)).toBe("confirmed");
  });

  it("a slot-opening cancel records each waitlist email with the canceller as the actor", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    const { shopId, adminId, headers } = await setup();
    const { id, date } = await seedBooking(shopId);
    const entry = await seedNamedWaitlistEntry(shopId, { preferredDate: date });

    const res = await dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, { headers, body: { status: "cancelled" } });
    expect(res.status).toBe(200);
    expect(await waitlistStatus(entry.id)).toBe("notified");
    expect(resendCalls).toEqual([entry.email]);

    const rows = await entriesFor({ action: "waitlist.notify", shopId, entityId: entry.id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("waitlist_entry");
    expect(rows[1]!.actor_type).toBe("admin");
    expect(rows[1]!.actor_ref).toBe(`subj_user_${adminId}`);
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ trigger: "slot_opened" });
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["waiting", "notified"] });
    expectNoPersonalData(rows[1]!, [entry.name, entry.email]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a 403 from the bookings router middleware writes no gap", async () => {
    const { shopId } = await setup();
    const { id } = await seedBooking(shopId);
    const customer = await tokenFor(await seedUser("customer", null), "customer", null);
    const res = await dispatch("PUT", `/api/shops/${shopId}/bookings/${id}/status`, {
      headers: authHeaders(customer),
      body: { status: "cancelled" },
    });
    expect(res.status).toBe(403);
    expect(await gapRowsFor(rid(res))).toBe(0);
    expect(await rowsForRequest(rid(res))).toBe(0);
    expect(await bookingStatus(id)).toBe("confirmed");
  });
});

// ─── /api/me: the customer's own cancel and profile ──────────────────────────

describe("customer self-service", () => {
  const CONFLICT = {
    success: false,
    error: "This booking was modified by another request and could not be cancelled. Please refresh and try again.",
  };
  const ALREADY_CLOSED = { success: false, error: "This booking is already closed" };

  it("a self-cancel records the flip, and its slot-open email names the customer", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    const shopId = await seedShop("Audit Me Cancel");
    const customer = await verifiedCustomer();
    const { id, date } = await seedBooking(shopId, { email: customer.email });
    const entry = await seedNamedWaitlistEntry(shopId, { preferredDate: date });

    const res = await dispatch("POST", `/api/me/bookings/${id}/cancel`, { headers: customer.headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("booking");
    expect(rows[1]!.actor_type).toBe("customer");
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["confirmed", "cancelled"] });
    expect(await bookingStatus(id)).toBe("cancelled");

    const notify = await entriesFor({ action: "waitlist.notify", shopId, entityId: entry.id });
    expect(phasesAndOutcomes(notify)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(notify[1]!.actor_type).toBe("customer");
    expect(notify[1]!.actor_ref).toBe(`subj_user_${customer.id}`);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a self-cancel stopped by the already-closed pre-check writes no row", async () => {
    const shopId = await seedShop("Audit Me Closed");
    const customer = await verifiedCustomer();
    const { id } = await seedBooking(shopId, { email: customer.email, status: "cancelled" });
    const res = await dispatch("POST", `/api/me/bookings/${id}/cancel`, { headers: customer.headers });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(ALREADY_CLOSED);
    expect(await rowsForRequest(rid(res))).toBe(0);
  });

  it("a self-cancel that loses the conditional update records refused", async () => {
    // "completed" passes the closed pre-check (cancelled/no_show only) but
    // not the atomic UPDATE (pending/confirmed only): today's 409.
    const shopId = await seedShop("Audit Me Lost");
    const customer = await verifiedCustomer();
    const { id } = await seedBooking(shopId, { email: customer.email, status: "completed" });
    const res = await dispatch("POST", `/api/me/bookings/${id}/cancel`, { headers: customer.headers });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(CONFLICT);
    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "refused"]]);
    expect(rows[1]!.reason).toBe("HTTP 409");
    expect(rows[1]!.changes_json).toBeNull();
    expect(await bookingStatus(id)).toBe("completed");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a racing second self-cancel never records a second success", async () => {
    // No CF-Connecting-IP: two concurrent IP-subject inserts are not under test.
    const shopId = await seedShop("Audit Me Race");
    const customer = await verifiedCustomer();
    const { id } = await seedBooking(shopId, { email: customer.email });
    const url = `/api/me/bookings/${id}/cancel`;
    const responses = await Promise.all([
      dispatch("POST", url, { headers: customer.headers }),
      dispatch("POST", url, { headers: customer.headers }),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200), `statuses ${JSON.stringify(statuses)}`).toHaveLength(1);
    const winner = statuses.indexOf(200);
    const loser = 1 - winner;
    expect(bodies[winner]).toEqual({ success: true });
    // The loser either reached the atomic UPDATE (409, recorded refused) or
    // was stopped by the closed pre-check (400, records nothing).
    expect([409, 400]).toContain(statuses[loser]);
    expect(bodies[loser]).toEqual(statuses[loser] === 409 ? CONFLICT : ALREADY_CLOSED);

    const rows = await entriesFor({ action: "booking.cancel", shopId, entityId: id });
    const started = rows.filter((r) => r.phase === "started");
    const outcomes = rows.filter((r) => r.phase === "outcome");
    expect(outcomes.filter((r) => r.outcome === "succeeded")).toHaveLength(1);
    for (const other of outcomes.filter((r) => r.outcome !== "succeeded")) {
      expect(other.outcome).toBe("refused");
      expect(other.reason).toBe("HTTP 409");
    }
    expect(started).toHaveLength(outcomes.length);
    expect(outcomes).toHaveLength(statuses[loser] === 409 ? 2 : 1);
    expect(await rowsForRequest(rid(responses[loser]!))).toBe(statuses[loser] === 409 ? 2 : 0);
    expect(await gapRowsFor(rid(responses[0]!))).toBe(0);
    expect(await gapRowsFor(rid(responses[1]!))).toBe(0);
    expect(await bookingStatus(id)).toBe("cancelled");
  });

  it("a self-cancel refuses before changing when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Me Off");
    const customer = await verifiedCustomer();
    const { id } = await seedBooking(shopId, { email: customer.email });
    const res = await withAuditOff(() => dispatch("POST", `/api/me/bookings/${id}/cancel`, { headers: customer.headers }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSED);
    expect(await bookingStatus(id)).toBe("confirmed");
  });

  it("profile update lists field names only", async () => {
    const customer = await verifiedCustomer();
    const name = "Ignatius Fairweather";
    const phone = "07700 900461";
    const res = await dispatch("PATCH", "/api/me/profile", {
      headers: customer.headers,
      body: { name, phone, nickname: "Iggy" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [entry] = await entriesFor({ action: "account.update", entityId: customer.id });
    expect(entry).toBeDefined();
    expect(entry!.phase).toBe("done");
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("platform_user");
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["name", "phone"] });
    expectNoPersonalData(await fullRow(customer.id, "account.update"), [name, phone, "Iggy"]);
    expect(await gapRowsFor(rid(res))).toBe(0);

    // The same values again change nothing, so no field is named.
    const again = await dispatch("PATCH", "/api/me/profile", { headers: customer.headers, body: { name, phone } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true });
    const rows = await entriesFor({ action: "account.update", entityId: customer.id });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.details_json).toBeNull();
    expect(await gapRowsFor(rid(again))).toBe(0);
  });

  it("profile update changes nothing when the entry cannot be written", async () => {
    const customer = await verifiedCustomer();
    const res = await withAuditOff(() =>
      dispatch("PATCH", "/api/me/profile", { headers: customer.headers, body: { name: "Renamed Customer" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT name FROM platform_users WHERE id = ?").bind(customer.id).first<{ name: string }>();
    expect(row!.name).not.toBe("Renamed Customer");
  });
});

// ─── Walk-in queue ───────────────────────────────────────────────────────────

describe("walk-in queue", () => {
  async function seedWalkin(shopId: string, status = "waiting", position = 1): Promise<string> {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO walkin_queue (id, shop_id, name, status, position) VALUES (?, ?, 'Queued Guest', ?, ?)"
    )
      .bind(id, shopId, status, position)
      .run();
    return id;
  }

  async function walkinStatus(id: string): Promise<string | undefined> {
    const row = await env.DB.prepare("SELECT status FROM walkin_queue WHERE id = ?").bind(id).first<{ status: string }>();
    return row?.status;
  }

  it("walk-in join records no name, phone or notes", async () => {
    const shopId = await seedShop("Audit Walkin Join");
    const slug = await slugOf(shopId);
    const ip = "198.51.100.61";
    const name = "Octavia Pemberton";
    const phone = "07700 900777";
    const service = "Beard trim for Octavia";
    const notes = "Allergic to lavender, ask for Desmond";
    const res = await dispatch("POST", `/api/walkin/${slug}/join`, {
      headers: { "CF-Connecting-IP": ip },
      body: { name, phone, service, notes },
    });
    expect(res.status).toBe(201);
    const data = ((await res.json()) as { data: { id: string; position: number } }).data;

    const [entry] = await entriesFor({ action: "walkin.join", shopId, entityId: data.id });
    expect(entry).toBeDefined();
    expect(entry!.phase).toBe("done");
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("walkin_entry");
    expect(entry!.actor_type).toBe("anonymous");
    expect(entry!.actor_ref).toBeNull();
    expect(entry!.ip_ref).toBeTruthy();
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: [null, "waiting"] });
    expectNoPersonalData(await fullRow(data.id, "walkin.join"), [name, phone, service, notes, "Desmond", ip]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("walk-in join leaves no queue row when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Walkin Join Off");
    const slug = await slugOf(shopId);
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/walkin/${slug}/join`, { headers: { "CF-Connecting-IP": "198.51.100.62" }, body: { name: "No Trace" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM walkin_queue WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("walk-in serve and remove pick the right action", async () => {
    const shopId = await seedShop("Audit Walkin Patch");
    const { token } = await adminToken(shopId);
    const headers = authHeaders(token);
    const id = await seedWalkin(shopId);
    const url = `/api/shops/${shopId}/walkin/${id}`;

    const serve = await dispatch("PATCH", url, { headers, body: { status: "serving" } });
    expect(serve.status).toBe(200);
    expect(await serve.json()).toEqual({ success: true });
    const skip = await dispatch("PATCH", url, { headers, body: { status: "skipped" } });
    expect(skip.status).toBe(200);
    expect(await skip.json()).toEqual({ success: true });

    const [served] = await entriesFor({ action: "walkin.serve", shopId, entityId: id });
    expect(served).toBeDefined();
    expect(served!.phase).toBe("done");
    expect(served!.outcome).toBe("succeeded");
    expect(served!.entity_type).toBe("walkin_entry");
    expect(JSON.parse(served!.changes_json as string)).toEqual({ status: ["waiting", "serving"] });
    const [removed] = await entriesFor({ action: "walkin.remove", shopId, entityId: id });
    expect(removed).toBeDefined();
    expect(removed!.phase).toBe("done");
    expect(removed!.outcome).toBe("succeeded");
    expect(removed!.entity_type).toBe("walkin_entry");
    expect(JSON.parse(removed!.changes_json as string)).toEqual({ status: ["serving", "skipped"] });
    expect(await walkinStatus(id)).toBe("skipped");
    expect(await gapRowsFor(rid(serve))).toBe(0);
    expect(await gapRowsFor(rid(skip))).toBe(0);
  });

  it("a walk-in status change changes nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Walkin Patch Off");
    const { token } = await adminToken(shopId);
    const id = await seedWalkin(shopId);
    const res = await withAuditOff(() =>
      dispatch("PATCH", `/api/shops/${shopId}/walkin/${id}`, { headers: authHeaders(token), body: { status: "served" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await walkinStatus(id)).toBe("waiting");
  });

  it("queue clear records the count", async () => {
    const shopId = await seedShop("Audit Walkin Clear");
    const { token } = await adminToken(shopId);
    const a = await seedWalkin(shopId, "waiting", 1);
    const b = await seedWalkin(shopId, "waiting", 2);
    const s = await seedWalkin(shopId, "serving", 3);
    const done = await seedWalkin(shopId, "served", 4);
    const res = await dispatch("DELETE", `/api/shops/${shopId}/walkin`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const rows = await entriesFor({ action: "walkin.remove", shopId });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("walkin_entry");
    expect(rows[1]!.entity_id).toBeNull();
    expect(rows[1]!.changes_json).toBeNull();
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ cleared: 3 });
    for (const id of [a, b, s]) expect(await walkinStatus(id)).toBe("removed");
    expect(await walkinStatus(done)).toBe("served");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("queue clear by a developer never records an unresolved shop id", async () => {
    // Developers bypass the shop check, so :shopId can be any string.
    const { token } = await devToken();
    const bogus = `no-such-shop-${crypto.randomUUID()}`;
    const res = await dispatch("DELETE", `/api/shops/${bogus}/walkin`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const rows = (
      await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY rowid").bind(rid(res)).all<Record<string, unknown>>()
    ).results;
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows.map((r) => r.action)).toEqual(["walkin.remove", "walkin.remove"]);
    expect(rows.map((r) => r.shop_id)).toEqual([null, null]);
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ cleared: 0 });
  });

  it("queue clear refuses before changing when the started entry cannot be written", async () => {
    const shopId = await seedShop("Audit Walkin Clear Off");
    const { token } = await adminToken(shopId);
    const a = await seedWalkin(shopId);
    const res = await withAuditOff(() => dispatch("DELETE", `/api/shops/${shopId}/walkin`, { headers: authHeaders(token) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSED);
    expect(await walkinStatus(a)).toBe("waiting");
  });
});

// ─── Waitlist ────────────────────────────────────────────────────────────────

describe("waitlist", () => {
  it("waitlist join records no customer details", async () => {
    const shopId = await seedShop("Audit Waitlist Join");
    const ip = "198.51.100.71";
    const name = "Bartholomew Quince";
    const email = `bart-${crypto.randomUUID()}@quince.test`;
    const phone = "07700 900888";
    const res = await dispatch("POST", "/api/waitlist", {
      headers: { "CF-Connecting-IP": ip },
      body: { shop_id: shopId, customer_name: name, customer_email: email, customer_phone: phone, preferred_date: "2027-04-09" },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;

    const [entry] = await entriesFor({ action: "waitlist.join", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.phase).toBe("done");
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("waitlist_entry");
    expect(entry!.actor_type).toBe("anonymous");
    expect(entry!.actor_ref).toBeNull();
    expect(entry!.ip_ref).toBeTruthy();
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: [null, "waiting"] });
    expectNoPersonalData(await fullRow(id, "waitlist.join"), [name, email, phone, ip]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("waitlist join leaves no entry when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Waitlist Join Off");
    const res = await withAuditOff(() =>
      dispatch("POST", "/api/waitlist", {
        headers: { "CF-Connecting-IP": "198.51.100.72" },
        body: { shop_id: shopId, customer_name: "No Trace", customer_email: "no-trace@test.local" },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("waitlist status update records before and after", async () => {
    const shopId = await seedShop("Audit Waitlist Status");
    const { token } = await adminToken(shopId);
    const id = await seedWaitlistEntry(shopId);
    const res = await dispatch("PATCH", `/api/waitlist/${id}/status`, { headers: authHeaders(token), body: { status: "booked" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const [entry] = await entriesFor({ action: "waitlist.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.phase).toBe("done");
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.entity_type).toBe("waitlist_entry");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: ["waiting", "booked"] });
    expect(await waitlistStatus(id)).toBe("booked");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a waitlist status update changes nothing when the entry cannot be written", async () => {
    const shopId = await seedShop("Audit Waitlist Status Off");
    const { token } = await adminToken(shopId);
    const id = await seedWaitlistEntry(shopId);
    const res = await withAuditOff(() =>
      dispatch("PATCH", `/api/waitlist/${id}/status`, { headers: authHeaders(token), body: { status: "expired" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await waitlistStatus(id)).toBe("waiting");
  });

  it("manual notify records the claim and the send", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    const shopId = await seedShop("Audit Notify Sent");
    const { token } = await adminToken(shopId);
    const entry = await seedNamedWaitlistEntry(shopId);
    const res = await dispatch("POST", `/api/waitlist/${entry.id}/notify`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { notified: true } });
    expect(resendCalls).toEqual([entry.email]);

    const rows = await entriesFor({ action: "waitlist.notify", shopId, entityId: entry.id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.entity_type).toBe("waitlist_entry");
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ trigger: "manual" });
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ trigger: "manual" });
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["waiting", "notified"] });
    expectNoPersonalData(rows[1]!, [entry.name, entry.email]);
    expect(await waitlistStatus(entry.id)).toBe("notified");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("manual notify records a failed send and reverts the claim", async () => {
    testEnv.RESEND_API_KEY = "test-key";
    resendStatus = 500;
    const shopId = await seedShop("Audit Notify Fail");
    const { token } = await adminToken(shopId);
    const entry = await seedNamedWaitlistEntry(shopId);
    const res = await dispatch("POST", `/api/waitlist/${entry.id}/notify`, { headers: authHeaders(token) });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: "Failed to send notification email" });
    const rows = await entriesFor({ action: "waitlist.notify", shopId, entityId: entry.id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "failed"]]);
    expect(rows[1]!.changes_json).toBeNull();
    expect(await waitlistStatus(entry.id)).toBe("waiting");
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("manual notify refuses before claiming when the started entry cannot be written", async () => {
    // With a key configured, a 503 here can only be the audit refusal, not
    // the "Email sending is not configured" path.
    testEnv.RESEND_API_KEY = "test-key";
    const shopId = await seedShop("Audit Notify Off");
    const { token } = await adminToken(shopId);
    const entry = await seedNamedWaitlistEntry(shopId);
    const res = await withAuditOff(() => dispatch("POST", `/api/waitlist/${entry.id}/notify`, { headers: authHeaders(token) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(REFUSED);
    expect(await waitlistStatus(entry.id)).toBe("waiting");
    expect(resendCalls).toEqual([]);
  });

  it("notifying an already-notified entry leaves no gap", async () => {
    const shopId = await seedShop("Audit Notify Again");
    const { token } = await adminToken(shopId);
    const id = await seedWaitlistEntry(shopId, { status: "notified" });
    const res = await dispatch("POST", `/api/waitlist/${id}/notify`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { notified: false, already_notified: true } });
    const rows = await entriesFor({ action: "waitlist.notify", shopId, entityId: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe("done");
    expect(rows[0]!.outcome).toBe("refused");
    expect(rows[0]!.reason).toBe("already_notified");
    expect(rows[0]!.entity_type).toBe("waitlist_entry");
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ trigger: "manual" });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("an already-notified answer stands when its entry cannot be written", async () => {
    // Best effort (Ruling 3): the no-op entry failing never turns the 200 into an error.
    const shopId = await seedShop("Audit Notify Again Off");
    const { token } = await adminToken(shopId);
    const id = await seedWaitlistEntry(shopId, { status: "notified" });
    const res = await withAuditOff(() => dispatch("POST", `/api/waitlist/${id}/notify`, { headers: authHeaders(token) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { notified: false, already_notified: true } });
    expect(await waitlistStatus(id)).toBe("notified");
  });
});

// ─── Slot-open fan-out ───────────────────────────────────────────────────────

describe("slot-open fan-out", () => {
  it("an unrecordable slot-open email is skipped like a send failure", async () => {
    const shopId = await seedShop("Audit Fanout Off");
    const entry = await seedNamedWaitlistEntry(shopId);
    const staffId = await seedStaff(shopId);
    const slug = await slugOf(shopId);
    const sent = await withAuditOff(() =>
      notifyWaitlistForOpenedSlot(
        env.DB,
        "test-key",
        { id: shopId, name: "Audit Fanout Off", slug },
        { bookingDate: "2027-05-01", staffId },
        systemAudit(env.DB, "api"),
      ),
    );
    expect(sent).toBe(0);
    expect(resendCalls).toEqual([]);
    expect(await waitlistStatus(entry.id)).toBe("waiting");
  });
});
