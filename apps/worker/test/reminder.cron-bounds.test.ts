import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedShop, seedStaff } from "./helpers";
import { getBookingsDueForReminder } from "../src/db/queries";
import { sendPendingReminders, REMINDER_MAX_PER_RUN } from "../src/services/reminder";

// Guard for the reminder-cron scale cliff: getBookingsDueForReminder must apply
// a bound so the fan-out in sendPendingReminders can never approach the Workers
// subrequest ceiling (2 subrequests per booking). miniflare enforces no ceiling,
// so an unbounded query/Promise.all passes tests and only fails at scale.

let shopId: string;
let staffId: string;
let serviceId: string;
let tomorrow: string;
let hourCounter = 8;

async function seedDueBooking(): Promise<string> {
  const id = crypto.randomUUID();
  // Distinct start_time — idx is unique on (staff_id, start_time) for live rows.
  const hh = String(hourCounter++).padStart(2, "0");
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence, reminder_sent)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', ?, ?, ?, 'confirmed', 2500, 250, 0)`
  )
    .bind(id, shopId, staffId, serviceId, tomorrow, `${tomorrow}T${hh}:00:00.000Z`, `${tomorrow}T${hh}:30:00.000Z`)
    .run();
  return id;
}

async function reminderSent(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT reminder_sent FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ reminder_sent: number }>();
  return row?.reminder_sent ?? -1;
}

beforeAll(async () => {
  shopId = await seedShop("Reminder Bounds Shop");
  staffId = await seedStaff(shopId);
  serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, 'Cut', 30, 2500)"
  )
    .bind(serviceId, shopId)
    .run();
  // Resolve "tomorrow" from the same clock the query uses, to avoid TZ drift.
  const row = await env.DB.prepare("SELECT date('now', '+1 day') AS d").first<{ d: string }>();
  tomorrow = row!.d;
});

describe("reminder cron subrequest bounding", () => {
  it("getBookingsDueForReminder applies the LIMIT", async () => {
    for (let i = 0; i < 3; i++) await seedDueBooking();

    const capped = await getBookingsDueForReminder(env.DB, 2);
    expect(capped.length).toBe(2);

    // Under the real per-run cap all seeded rows are visible.
    const all = await getBookingsDueForReminder(env.DB, REMINDER_MAX_PER_RUN);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("sendPendingReminders processes every due booking under the cap (bounded waves, none dropped)", async () => {
    const ids = [await seedDueBooking(), await seedDueBooking()];
    // No API key -> console path, no outbound fetch; still marks reminders sent.
    await sendPendingReminders(env.DB, undefined);
    for (const id of ids) expect(await reminderSent(id)).toBe(1);
  });
});
