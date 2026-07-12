/**
 * WS-8 phase 2 / LEG-6: the retention sweep deletes or anonymises exactly
 * what the policy says — old rows go, fresh rows stay, money fields survive
 * booking anonymisation, sweeps are idempotent, and every sweep is bounded
 * per run.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  runRetentionSweep,
  RETENTION_POLICY,
} from "../src/services/retention";
import { REDACTED_EMAIL, REDACTED_NAME } from "../src/db/queries";
import { seedShop, seedStaff } from "./helpers";

let seq = 0;
const uid = (p: string) => `${p}-ret-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

async function seedService(shopId: string): Promise<string> {
  const id = uid("svc");
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, 'Cut', 30, 2000)`
  )
    .bind(id, shopId)
    .run();
  return id;
}

async function seedBooking(
  shopId: string,
  staffId: string,
  serviceId: string,
  bookingDate: string
): Promise<string> {
  const id = uid("bk");
  // Unique start times per seed — migration 018's slot race guard is
  // UNIQUE on (staff_id, start_time) territory.
  const startTime = `10:${String(10 + (seq % 50)).padStart(2, "0")}`;
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
                           customer_phone, booking_date, start_time, end_time, status, notes,
                           amount_pence, commission_pence)
     VALUES (?, ?, ?, ?, 'Jane Doe', 'jane@example.com', '07700900000', ?, ?, '11:00',
             'completed', 'allergic to product X', 3500, 350)`
  )
    .bind(id, shopId, staffId, serviceId, bookingDate, startTime)
    .run();
  return id;
}

async function seedChatSession(shopId: string, updatedAt: string): Promise<string> {
  const id = uid("chat");
  await env.DB.prepare(
    `INSERT INTO chat_sessions (id, shop_id, visitor_id, messages_json, created_at, updated_at)
     VALUES (?, ?, 'v1', '[{"role":"user","content":"my number is 07700900000"}]', ?, ?)`
  )
    .bind(id, shopId, updatedAt, updatedAt)
    .run();
  return id;
}

const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().replace("T", " ").slice(0, 19);
};
const dateDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("retention sweep (LEG-6)", () => {
  it("deletes expired chat sessions and keeps fresh ones", async () => {
    const shopId = await seedShop("Retention Chat");
    const oldId = await seedChatSession(shopId, daysAgo(RETENTION_POLICY.chatSessionsDays + 5));
    const freshId = await seedChatSession(shopId, daysAgo(5));

    const { counts, errors } = await runRetentionSweep(env.DB);
    expect(errors).toEqual([]);
    expect(counts.chat_sessions).toBeGreaterThanOrEqual(1);

    const rows = await env.DB.prepare("SELECT id FROM chat_sessions WHERE id IN (?, ?)")
      .bind(oldId, freshId)
      .all<{ id: string }>();
    expect((rows.results ?? []).map((r) => r.id)).toEqual([freshId]);
  });

  it("anonymises old booking PII but keeps the row and its money", async () => {
    const shopId = await seedShop("Retention Bookings");
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    const oldId = await seedBooking(
      shopId,
      staffId,
      serviceId,
      dateDaysAgo(RETENTION_POLICY.bookingPiiMonths * 31 + 10)
    );
    const freshId = await seedBooking(shopId, staffId, serviceId, dateDaysAgo(30));

    const { errors } = await runRetentionSweep(env.DB);
    expect(errors).toEqual([]);

    const old = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(oldId).first<{
      customer_name: string;
      customer_email: string;
      customer_phone: string | null;
      notes: string | null;
      amount_pence: number;
      commission_pence: number;
      status: string;
    }>();
    expect(old).not.toBeNull();
    expect(old!.customer_name).toBe(REDACTED_NAME);
    expect(old!.customer_email).toBe(REDACTED_EMAIL);
    expect(old!.customer_phone).toBeNull();
    expect(old!.notes).toBeNull();
    // Money and status untouched — reports and the audit trail keep working.
    expect(old!.amount_pence).toBe(3500);
    expect(old!.commission_pence).toBe(350);
    expect(old!.status).toBe("completed");

    const fresh = await env.DB.prepare("SELECT customer_email FROM bookings WHERE id = ?")
      .bind(freshId)
      .first<{ customer_email: string }>();
    expect(fresh!.customer_email).toBe("jane@example.com");
  });

  it("is idempotent — a second run reports zero new anonymisations for the same rows", async () => {
    const shopId = await seedShop("Retention Idempotent");
    const staffId = await seedStaff(shopId);
    const serviceId = await seedService(shopId);
    await seedBooking(shopId, staffId, serviceId, dateDaysAgo(800));

    await runRetentionSweep(env.DB);
    const second = await runRetentionSweep(env.DB);
    expect(second.errors).toEqual([]);
    expect(second.counts.bookings_anonymised).toBe(0);
  });

  it("deletes stale waitlist, expired invites, and unonboarded contacts; keeps onboarded contacts", async () => {
    const shopId = await seedShop("Retention Misc");

    const oldWait = uid("wait");
    await env.DB.prepare(
      `INSERT INTO waitlist (id, shop_id, customer_name, customer_email, created_at)
       VALUES (?, ?, 'W', 'w@example.com', ?)`
    )
      .bind(oldWait, shopId, daysAgo(RETENTION_POLICY.waitlistDays + 10))
      .run();

    const oldInvite = uid("inv");
    await env.DB.prepare(
      `INSERT INTO invites (id, email, shop_id, token, expires_at)
       VALUES (?, 'i@example.com', ?, ?, ?)`
    )
      .bind(oldInvite, shopId, uid("tok"), daysAgo(RETENTION_POLICY.invitesGraceDays + 5))
      .run();

    const oldContact = uid("con");
    const keptContact = uid("con");
    await env.DB.prepare(
      `INSERT INTO contacts (id, full_name, shop_name, shop_type, email, created_at)
       VALUES (?, 'C', 'Shop', 'barber', 'c@example.com', ?)`
    )
      .bind(oldContact, daysAgo(RETENTION_POLICY.contactsMonths * 31 + 10))
      .run();
    await env.DB.prepare(
      `INSERT INTO contacts (id, full_name, shop_name, shop_type, email, created_at, onboarded_at, shop_id)
       VALUES (?, 'K', 'Shop', 'barber', 'k@example.com', ?, datetime('now'), ?)`
    )
      .bind(keptContact, daysAgo(RETENTION_POLICY.contactsMonths * 31 + 10), shopId)
      .run();

    const { errors } = await runRetentionSweep(env.DB);
    expect(errors).toEqual([]);

    const wait = await env.DB.prepare("SELECT id FROM waitlist WHERE id = ?").bind(oldWait).first();
    expect(wait).toBeNull();
    const invite = await env.DB.prepare("SELECT id FROM invites WHERE id = ?").bind(oldInvite).first();
    expect(invite).toBeNull();
    const gone = await env.DB.prepare("SELECT id FROM contacts WHERE id = ?").bind(oldContact).first();
    expect(gone).toBeNull();
    const kept = await env.DB.prepare("SELECT id FROM contacts WHERE id = ?").bind(keptContact).first();
    expect(kept).not.toBeNull();
  });

  it("is bounded per table per run — a backlog drains across runs, never in one", async () => {
    const shopId = await seedShop("Retention Bounded");
    const old = daysAgo(RETENTION_POLICY.chatSessionsDays + 30);
    for (let i = 0; i < 5; i++) await seedChatSession(shopId, old);

    const first = await runRetentionSweep(env.DB, 2);
    expect(first.counts.chat_sessions).toBe(2);
    const second = await runRetentionSweep(env.DB, 2);
    expect(second.counts.chat_sessions).toBe(2);

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chat_sessions WHERE shop_id = ?"
    )
      .bind(shopId)
      .first<{ n: number }>();
    expect(left!.n).toBe(1);
  });

  it("prunes old ai_usage_log rows", async () => {
    const oldId = uid("ai");
    const freshId = uid("ai");
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (id, worker_name, model, usage_type, created_at)
       VALUES (?, 'research', 'm', 'site', ?)`
    )
      .bind(oldId, daysAgo(RETENTION_POLICY.aiUsageLogMonths * 31 + 10))
      .run();
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (id, worker_name, model, usage_type, created_at)
       VALUES (?, 'research', 'm', 'site', datetime('now'))`
    )
      .bind(freshId)
      .run();

    const { errors } = await runRetentionSweep(env.DB);
    expect(errors).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM ai_usage_log WHERE id = ?").bind(oldId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM ai_usage_log WHERE id = ?").bind(freshId).first()).not.toBeNull();
  });
});
