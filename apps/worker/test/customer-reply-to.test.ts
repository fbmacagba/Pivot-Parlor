/** A customer who replies to an email the platform sends for a shop reaches
 *  that shop: reply-to is the shop's owner_email (every shop has one), when it
 *  is one plausible address. Covers each API email a customer receives: the
 *  reminder (cron and queue paths), the review request and the waitlist
 *  slot-opened email. The booking confirmation is the booking worker's
 *  (apps/workers/booking/test/confirmation-reply-to.test.ts).
 *
 *  Tests and the worker share one isolate, so stubbing fetch catches the
 *  email service's Resend call; D1 and service bindings bypass it. */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import index from "../src/index";
import { processReminder } from "../src/services/reminder";
import { authHeaders, seedShop, seedStaff, seedUser, seedWaitlistEntry, tokenFor } from "./helpers";
import { dispatch } from "./request";

type Sent = { to?: unknown; subject?: string; reply_to?: unknown };

const testEnv = env as unknown as Record<string, string | undefined>;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let sent: Sent[] = [];

function captureResend(): void {
  sent = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails") return realFetch(input as never, init);
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Sent);
    return Response.json({ id: "sent-in-test" });
  });
}

/** The emails sent to `to`, so other files' bookings never interfere. */
const sentTo = (to: string) => sent.filter((m) => m.to === to);

afterEach(() => {
  vi.restoreAllMocks();
  delete testEnv.RESEND_API_KEY;
});

async function ownerEmail(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT owner_email FROM shops WHERE id = ?").bind(shopId).first<{ owner_email: string }>();
  return row!.owner_email;
}

async function setOwnerEmail(shopId: string, value: string): Promise<void> {
  await env.DB.prepare("UPDATE shops SET owner_email = ? WHERE id = ?").bind(value, shopId).run();
}

/** A confirmed booking at a fresh shop, for `date` ("tomorrow" = the reminder day). */
async function seedBooking(opts: { date?: "tomorrow" | "later"; status?: string } = {}) {
  const shopId = await seedShop("Reply To Barbers");
  const staffId = await seedStaff(shopId);
  const serviceId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, 'Cut', 30, 2500)")
    .bind(serviceId, shopId)
    .run();
  const day = await env.DB.prepare(`SELECT date('now', ?) AS d`)
    .bind(opts.date === "later" ? "+20 day" : "+1 day")
    .first<{ d: string }>();
  const id = crypto.randomUUID();
  const customerEmail = `cust-${id.slice(0, 8)}@example.test`;
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, reminder_sent)
     VALUES (?, ?, ?, ?, 'Ada Fictional', ?, ?, ?, ?, ?, 2500, 0)`,
  )
    .bind(id, shopId, staffId, serviceId, customerEmail, day!.d, `${day!.d}T10:00:00.000Z`, `${day!.d}T10:30:00.000Z`, opts.status ?? "confirmed")
    .run();
  return { id, shopId, customerEmail };
}

describe("reminder reply-to", () => {
  it("the 08:00 cron reminder replies to the shop", async () => {
    const b = await seedBooking();
    captureResend();
    await index.scheduled({ cron: "0 8 * * *" } as unknown as ScheduledEvent, { ...env, RESEND_API_KEY: "test-resend-key" } as never, ctx);
    const mine = sentTo(b.customerEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reply_to).toBe(await ownerEmail(b.shopId));
  });

  it("the queued reminder replies to the shop", async () => {
    const b = await seedBooking();
    captureResend();
    await processReminder({ bookingId: b.id, sendAt: new Date().toISOString() }, env.DB, "test-resend-key");
    const mine = sentTo(b.customerEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reply_to).toBe(await ownerEmail(b.shopId));
  });

  it("a doubtful shop address is left out, and the reminder still goes", async () => {
    const b = await seedBooking();
    await setOwnerEmail(b.shopId, "owner at example dot test");
    captureResend();
    await processReminder({ bookingId: b.id, sendAt: new Date().toISOString() }, env.DB, "test-resend-key");
    const mine = sentTo(b.customerEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reply_to).toBeUndefined();
  });
});

describe("review request reply-to", () => {
  it("marking a booking completed sends a review request that replies to the shop", async () => {
    const b = await seedBooking({ date: "later" });
    const admin = await tokenFor(await seedUser("admin", b.shopId), "admin", b.shopId);
    testEnv.RESEND_API_KEY = "test-resend-key";
    captureResend();
    const res = await dispatch("PUT", `/api/shops/${b.shopId}/bookings/${b.id}/status`, {
      headers: authHeaders(admin),
      body: { status: "completed" },
    });
    expect(res.status).toBe(200);
    const mine = sentTo(b.customerEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain("How was your visit");
    expect(mine[0]!.reply_to).toBe(await ownerEmail(b.shopId));
  });
});

describe("waitlist reply-to", () => {
  it("the slot-opened email replies to the shop", async () => {
    const shopId = await seedShop("Reply Waitlist Barbers");
    const entry = await seedWaitlistEntry(shopId);
    const admin = await tokenFor(await seedUser("admin", shopId), "admin", shopId);
    testEnv.RESEND_API_KEY = "test-resend-key";
    captureResend();
    const res = await dispatch("POST", `/api/waitlist/${entry}/notify`, { headers: authHeaders(admin) });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reply_to).toBe(await ownerEmail(shopId));
  });
});
