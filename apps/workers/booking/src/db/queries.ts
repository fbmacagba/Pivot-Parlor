// Query helpers for the public booking path, moved from
// apps/worker/src/db/queries.ts in WS-1 — the booking worker is now the sole
// writer of public booking creation. Row types carry only the fields this
// worker reads.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export interface ShopRow {
  id: string;
  slug: string;
  name: string;
  is_active: number;
  commission_rate: number;
  timezone: string | null;
  stripe_connect_account_id?: string | null;
  stripe_connect_onboarded?: number | null;
}

export interface ServiceRow {
  id: string;
  shop_id: string;
  name: string;
  duration_min: number;
  price_pence: number;
  is_active: number;
}

export interface StaffRow {
  id: string;
  shop_id: string;
  display_name: string;
  is_active: number;
}

export function getShopById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM shops WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ShopRow>();
}

export function getShopBySlug(db: D1Database, slug: string) {
  return db
    .prepare("SELECT * FROM shops WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<ShopRow>();
}

export function getServiceById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM services WHERE id = ? LIMIT 1")
    .bind(id)
    .first<ServiceRow>();
}

export function getStaffById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM staff WHERE id = ? LIMIT 1")
    .bind(id)
    .first<StaffRow>();
}

export function createBooking(db: D1Database, b: {
  id: string;
  shop_id: string;
  staff_id: string;
  service_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone?: string | null;
  booking_date: string;
  start_time: string;
  end_time: string;
  notes?: string | null;
  amount_pence: number;
  commission_pence: number;
}) {
  return db
    .prepare(
      `INSERT INTO bookings
         (id, shop_id, staff_id, service_id,
          customer_name, customer_email, customer_phone,
          booking_date, start_time, end_time,
          notes, amount_pence, commission_pence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      b.id, b.shop_id, b.staff_id, b.service_id,
      b.customer_name, b.customer_email, b.customer_phone ?? null,
      b.booking_date, b.start_time, b.end_time,
      b.notes ?? null, b.amount_pence, b.commission_pence
    )
    .run();
}

export async function checkSlotConflict(
  db: D1Database,
  staffId: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  // Overlap is a pure instant-range comparison — do NOT gate on booking_date.
  // booking_date is the UTC calendar date, so an overlapping booking whose
  // instant straddles UTC midnight onto an adjacent date would be missed by a
  // single-date filter, letting two different-start bookings double-book.
  const row = await db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE staff_id = ?
         AND status NOT IN ('cancelled', 'no_show')
         AND start_time < ? AND end_time > ?
       LIMIT 1`
    )
    .bind(staffId, endTime, startTime)
    .first();
  return !!row;
}

/** Cancel an unpaid deposit booking, but only while it is still 'pending'.
 *  The status write is a guard: on any other status it writes NULL into the
 *  NOT NULL bookings.status, so D1 rolls the WHOLE batch back (the audit
 *  entry batched with it included). Callers batch these with their entry and,
 *  on a thrown batch, re-read the status to tell a lost race from a real
 *  failure. ensure-schema asserts the NOT NULL this relies on. */
export function cancelPendingBookingStmts(db: D1Database, bookingId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "UPDATE bookings SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE NULL END WHERE id = ?"
      )
      .bind(bookingId),
    db
      .prepare(
        "UPDATE bw_transactions SET status = 'cancelled' WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'"
      )
      .bind(bookingId),
  ];
}
