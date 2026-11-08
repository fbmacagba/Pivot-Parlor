/** Task 9: the API worker's crons and the reminder queue record themselves in
 *  the audit trail under the system actor (they run outside the HTTP gap guard). */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import index from "../src/index";
import { systemAudit } from "../src/audit/context";
import { getBookingsDueForReminder } from "../src/db/queries";
import { deliverReminder } from "../src/services/reminder-deliver";
import { entriesFor, expectNoPersonalData, withAuditOff } from "./audit-helpers";
import { seedShop, seedStaff, seedUser } from "./helpers";

const CUSTOMER_NAME = "Zelda Quimby";
const CUSTOMER_EMAIL = "zelda.quimby@example.test";
const SERVICE_NAME = "Quimby Special Trim";
const RESEND_KEY = "test-resend-key";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const cronEvent = (cron: string) => ({ cron }) as unknown as ScheduledEvent;
const keyedEnv = () => ({ ...env, RESEND_API_KEY: RESEND_KEY }) as typeof env;

let shopId: string;
let staffId: string;
let serviceId: string;
let tomorrow: string;
let today: string;
let slot = 8;

async function seedBooking(date: string): Promise<string> {
  const id = crypto.randomUUID();
  const hh = String(slot++).padStart(2, "0");
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence, reminder_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 2500, 250, 0)`
  )
    .bind(id, shopId, staffId, serviceId, CUSTOMER_NAME, CUSTOMER_EMAIL, date, `${date}T${hh}:00:00.000Z`, `${date}T${hh}:30:00.000Z`)
    .run();
  return id;
}

async function reminderSent(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT reminder_sent FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ reminder_sent: number }>();
  return row?.reminder_sent ?? -1;
}

async function seedStaleChat(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO chat_sessions (id, shop_id, visitor_id, messages_json, created_at, updated_at)
     VALUES (?, ?, 'v1', '[]', '2020-01-01 00:00:00', '2020-01-01 00:00:00')`
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function chatExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM chat_sessions WHERE id = ?").bind(id).first();
  return row !== null;
}

function parse(row: Record<string, unknown>, col: "details_json" | "changes_json"): Record<string, any> {
  return JSON.parse(String(row[col]));
}

beforeAll(async () => {
  shopId = await seedShop("Cron Audit Shop");
  staffId = await seedStaff(shopId);
  serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, ?, 30, 2500)"
  )
    .bind(serviceId, shopId, SERVICE_NAME)
    .run();
  const row = await env.DB.prepare("SELECT date('now', '+1 day') AS t, date('now') AS d").first<{ t: string; d: string }>();
  tomorrow = row!.t;
  today = row!.d;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("03:00 retention", () => {
  it("retention run records counts per table", async () => {
    const stale = await seedStaleChat();
    await index.scheduled(cronEvent("0 3 * * *"), env, ctx);

    const rows = await entriesFor({ action: "data.retention" });
    expect(rows.map((r) => r.phase), JSON.stringify(rows.map((r) => [r.phase, r.outcome, r.reason]))).toEqual([
      "started",
      "outcome",
    ]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.actor_type).toBe("system");
    expect(outcome.via).toBe("cron");
    expect(outcome.parent_id).toBe(rows[0]!.id);
    const details = parse(outcome, "details_json");
    expect(details.counts.chat_sessions).toBeGreaterThanOrEqual(1);
    expect(details.failed_tables).toEqual([]);
    expect(await chatExists(stale)).toBe(false);
  });

  it("retention is skipped when its entry cannot be written", async () => {
    const stale = await seedStaleChat();
    await withAuditOff(async () => {
      await index.scheduled(cronEvent("0 3 * * *"), env, ctx);
    });
    expect(await chatExists(stale)).toBe(true);
  });
});

describe("08:00 reminders", () => {
  it("cron reminder records the booking and marks it sent", async () => {
    const id = await seedBooking(tomorrow);
    await index.scheduled(cronEvent("0 8 * * *"), env, ctx);

    const rows = await entriesFor({ action: "booking.reminder", entityId: id });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("succeeded");
    expect(row.entity_type).toBe("booking");
    expect(row.shop_id).toBe(shopId);
    expect(row.actor_type).toBe("system");
    expect(row.via).toBe("cron");
    expect(row.request_id).toBeNull();
    expect(parse(row, "details_json")).toEqual({ channel: "log_only", send: "ok" });
    expectNoPersonalData(row, [CUSTOMER_NAME, CUSTOMER_EMAIL, SERVICE_NAME]);
    expect(await reminderSent(id)).toBe(1);
  });

  it("reminder mark and entry share one batch", async () => {
    const id = await seedBooking(tomorrow);
    await withAuditOff(async () => {
      // The batch fails as a whole (audit_log is missing), the same failure
      // class as markReminderSent failing today: it propagates and the
      // booking stays unmarked.
      await index.scheduled(cronEvent("0 8 * * *"), env, ctx).catch(() => undefined);
    });
    expect(await reminderSent(id), "no entry could be written, so the reminder must stay unmarked").toBe(0);

    // The entry is written after the send, in a single DB.batch call.
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (prop === "batch") {
          return (...args: unknown[]) => {
            batches++;
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof env.DB;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const due = (await getBookingsDueForReminder(env.DB, 500)).find((b) => b.id === id)!;
    expect(due, "the unmarked booking is still due").toBeDefined();
    const recorder = createAuditRecorder({
      db,
      worker: "pivot-parlor-api",
      via: "cron",
      actor: { type: "system" },
      requestId: null,
    });
    await deliverReminder(db, RESEND_KEY, due, recorder);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(batches, "one booking costs exactly one DB.batch call").toBe(1);
    expect(await reminderSent(id)).toBe(1);
    const rows = await entriesFor({ action: "booking.reminder", entityId: id });
    expect(rows.length).toBe(1);
    expect(parse(rows[0]!, "details_json")).toEqual({ channel: "email", send: "ok" });
  });

  it("a Resend non-2xx records the reminder failed with HTTP 401 and no message text", async () => {
    const id = await seedBooking(tomorrow);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid api key: secret-vendor-text", { status: 401 }));
    await index.scheduled(cronEvent("0 8 * * *"), keyedEnv(), ctx);

    const rows = await entriesFor({ action: "booking.reminder", entityId: id });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.outcome).toBe("failed");
    expect(row.reason).toBe("HTTP 401");
    expect(parse(row, "details_json")).toEqual({ channel: "email", send: "failed" });
    expectNoPersonalData(row, [CUSTOMER_NAME, CUSTOMER_EMAIL, SERVICE_NAME, "secret-vendor-text", "invalid api key"]);
    // Today's semantics, unchanged: a failed send is still marked sent.
    expect(await reminderSent(id)).toBe(1);
  });
});

describe("reminder queue", () => {
  const queueBatch = (messages: unknown[]) =>
    ({ queue: "pivot-parlor-reminders", messages }) as unknown as Parameters<typeof index.queue>[0];
  const message = (id: string, bookingId: string, sendAt: string) => ({
    id,
    body: { bookingId, sendAt },
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it("queue reminder records the message id as request id", async () => {
    const bookingId = await seedBooking(tomorrow);
    const msg = message("msg-queue-123", bookingId, "2020-01-01T00:00:00.000Z");
    await index.queue(queueBatch([msg]), env);

    const rows = await entriesFor({ action: "booking.reminder", entityId: bookingId });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.request_id).toBe("msg-queue-123");
    expect(row.via).toBe("queue");
    expect(row.actor_type).toBe("system");
    expect(row.outcome).toBe("succeeded");
    expect(row.shop_id).toBe(shopId);
    expectNoPersonalData(row, [CUSTOMER_NAME, CUSTOMER_EMAIL, SERVICE_NAME]);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(await reminderSent(bookingId)).toBe(1);
  });

  it("not-due and already-sent messages write nothing", async () => {
    const notDue = await seedBooking(tomorrow);
    const future = message("msg-future", notDue, new Date(Date.now() + 3 * 3600_000).toISOString());
    await index.queue(queueBatch([future]), env);
    expect(future.retry).toHaveBeenCalledTimes(1);
    expect(future.ack).not.toHaveBeenCalled();
    expect(await entriesFor({ action: "booking.reminder", entityId: notDue })).toEqual([]);
    expect(await reminderSent(notDue)).toBe(0);

    const sent = await seedBooking(tomorrow);
    await env.DB.prepare("UPDATE bookings SET reminder_sent = 1 WHERE id = ?").bind(sent).run();
    const again = message("msg-sent", sent, "2020-01-01T00:00:00.000Z");
    await index.queue(queueBatch([again]), env);
    expect(again.ack).toHaveBeenCalledTimes(1);
    expect(await entriesFor({ action: "booking.reminder", entityId: sent })).toEqual([]);
  });

  it("a queue reminder whose entry cannot be written is left unmarked and retried", async () => {
    const bookingId = await seedBooking(tomorrow);
    const msg = message("msg-off", bookingId, "2020-01-01T00:00:00.000Z");
    await withAuditOff(async () => {
      await index.queue(queueBatch([msg]), env);
    });
    expect(await reminderSent(bookingId)).toBe(0);
    // Today's handling of a failed mark: the batch error reaches the
    // consumer's catch, which retries the message.
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe("20:00 EOD summary", () => {
  it("writes no entry when no email is attempted (no API key)", async () => {
    await seedUser("developer", null);
    await index.scheduled(cronEvent("0 20 * * *"), env, ctx);
    expect(await entriesFor({ action: "booking.eod_summary" })).toEqual([]);
  });

  it("EOD summary records counts, never the developer email", async () => {
    const devId = await seedUser("developer", null);
    await seedBooking(today);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const dev = await env.DB.prepare("SELECT email FROM platform_users WHERE role = 'developer' LIMIT 1").first<{ email: string }>();
    await index.scheduled(cronEvent("0 20 * * *"), keyedEnv(), ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await entriesFor({ action: "booking.eod_summary" });
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.actor_type).toBe("system");
    const details = parse(outcome, "details_json");
    expect(details.date).toBe(today);
    expect(details.booking_count).toBeGreaterThanOrEqual(1);
    expect(details.shop_count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(details).sort()).toEqual(["booking_count", "date", "shop_count"]);
    expectNoPersonalData(outcome, [dev!.email, devId, "Cron Audit Shop"]);
  });

  it("a failed EOD send records failed with the HTTP status only", async () => {
    await seedUser("developer", null);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope: vendor text", { status: 403 }));
    await index.scheduled(cronEvent("0 20 * * *"), keyedEnv(), ctx);
    const rows = (await entriesFor({ action: "booking.eod_summary" })).filter((r) => r.phase === "outcome");
    const failed = rows.find((r) => r.outcome === "failed");
    expect(failed, JSON.stringify(rows.map((r) => [r.outcome, r.reason]))).toBeDefined();
    expect(failed!.reason).toBe("EmailSendError (HTTP 403)");
    expectNoPersonalData(failed!, ["vendor text"]);
  });
});

describe("systemAudit", () => {
  it("is stateless, so one recorder serves a whole cron run", async () => {
    const r = systemAudit(env.DB, "cron");
    const id = await seedBooking(tomorrow);
    const due = (await getBookingsDueForReminder(env.DB, 500)).find((b) => b.id === id)!;
    await deliverReminder(env.DB, undefined, due, r);
    expect((await entriesFor({ action: "booking.reminder", entityId: id })).length).toBe(1);
  });
});
