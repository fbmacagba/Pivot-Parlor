// Query helpers for the public booking path, moved from
// apps/worker/src/db/queries.ts in WS-1 — the booking worker is now the sole
// writer of public booking creation. Row types carry only the fields this
// worker reads.
import type { D1Database } from "@cloudflare/workers-types";

export interface ShopRow {
  id: string;
  slug: string;
  name: string;
  is_active: number;
  commission_rate: number;
  timezone: string | null;
}

export interface ServiceRow {
  id: string;
  shop_id: string;
  name: string;
  duration_min: number;
  price: number;
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
  amount: number;
  commission: number;
}) {
  return db
    .prepare(
      `INSERT INTO bookings
         (id, shop_id, staff_id, service_id,
          customer_name, customer_email, customer_phone,
          booking_date, start_time, end_time,
          notes, amount, commission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      b.id, b.shop_id, b.staff_id, b.service_id,
      b.customer_name, b.customer_email, b.customer_phone ?? null,
      b.booking_date, b.start_time, b.end_time,
      b.notes ?? null, b.amount, b.commission
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
