import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedShop, seedStaff } from "./helpers";
import { processReminder } from "../src/services/reminder";

let shopId: string;
let staffId: string;
let serviceId: string;

let slotCounter = 10;

async function seedBooking(status: string): Promise<string> {
  const id = crypto.randomUUID();
  // Distinct start_time per booking — idx_bookings_active_slot is unique on
  // (staff_id, start_time) for non-cancelled rows.
  const hh = String(slotCounter++).padStart(2, "0");
  await env.DB.prepare(
    `INSERT INTO bookings (id, shop_id, staff_id, service_id, customer_name, customer_email,
       booking_date, start_time, end_time, status, amount_pence, commission_pence, reminder_sent)
     VALUES (?, ?, ?, ?, 'Cust', 'cust@test.local', '2027-05-10',
             ?, ?, ?, 25, 2.5, 0)`
  )
    .bind(id, shopId, staffId, serviceId, `2027-05-10T${hh}:00:00.000Z`, `2027-05-10T${hh}:30:00.000Z`, status)
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
  shopId = await seedShop("Reminder Shop");
  staffId = await seedStaff(shopId);
  serviceId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence) VALUES (?, ?, 'Cut', 30, 2500)"
  )
    .bind(serviceId, shopId)
    .run();
});

describe("reminder status gate (review finding 3)", () => {
  it("sends a reminder for a PENDING booking (self-service bookings are never auto-confirmed)", async () => {
    const id = await seedBooking("pending");
    await processReminder({ bookingId: id, sendAt: "2027-05-09T10:00:00.000Z" }, env.DB, undefined);
    expect(await reminderSent(id)).toBe(1);
  });

  it("sends a reminder for a confirmed booking", async () => {
    const id = await seedBooking("confirmed");
    await processReminder({ bookingId: id, sendAt: "2027-05-09T10:00:00.000Z" }, env.DB, undefined);
    expect(await reminderSent(id)).toBe(1);
  });

  it("does not send for a cancelled booking", async () => {
    const id = await seedBooking("cancelled");
    await processReminder({ bookingId: id, sendAt: "2027-05-09T10:00:00.000Z" }, env.DB, undefined);
    expect(await reminderSent(id)).toBe(0);
  });
});
