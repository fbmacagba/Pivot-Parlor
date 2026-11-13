// Query helpers for the public booking path, moved from
// apps/worker/src/db/queries.ts in WS-1 — the booking worker is now the sole
// writer of public booking creation. Row types carry only the fields this
// worker reads.
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { rangesOverlap } from "@repo/utils";
import {
  BOOKING_CLASH_SQL,
  CLOCK_START_SQL,
  INSTANT_START_SQL,
  bookingClashBinds,
  bookingInterval,
  shiftDate,
  type BookingTimes,
} from "../lib/bookingTimes.js";

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

/** A plain insert with no clash check, kept for seeding tests. Every route
 *  books through createBookingIfFree, which refuses a time already held. */
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

/** A booking row to insert; `status` left out keeps the column's default. */
export type NewBooking = Parameters<typeof createBooking>[1] & { status?: string };

/**
 * Insert the booking only if no active booking holds any of its time for the
 * same staff member, as ONE statement (INSERT ... SELECT ... WHERE NOT
 * EXISTS), which D1 runs atomically. A request that wins an overlapping time
 * between a caller's checkSlotConflict and this insert makes it a no-op, never
 * a second booking. idx_bookings_active_slot alone stops only an identical
 * start string.
 *
 * "taken" on a clash (an identical start included), "created" otherwise. A
 * booking whose own times cannot be read is "taken", as slotTaken treats it.
 * The clash rule is @repo/utils BOOKING_CLASH_SQL, shared with the API's
 * status changes.
 */
export async function createBookingIfFree(
  db: D1Database,
  b: NewBooking,
  timeZone: string,
): Promise<"created" | "taken"> {
  const interval = bookingInterval(b, timeZone);
  if (!interval) return "taken";

  const row: Array<[string, unknown]> = [
    ["id", b.id],
    ["shop_id", b.shop_id],
    ["staff_id", b.staff_id],
    ["service_id", b.service_id],
    ["customer_name", b.customer_name],
    ["customer_email", b.customer_email],
    ["customer_phone", b.customer_phone ?? null],
    ["booking_date", b.booking_date],
    ["start_time", b.start_time],
    ["end_time", b.end_time],
    ["notes", b.notes ?? null],
    ["amount_pence", b.amount_pence],
    ["commission_pence", b.commission_pence],
  ];
  if (b.status !== undefined) row.push(["status", b.status]);

  try {
    const result = await db
      .prepare(
        `INSERT INTO bookings (${row.map(([column]) => column).join(", ")})
         SELECT ${row.map(() => "?").join(", ")}
         WHERE NOT ${BOOKING_CLASH_SQL}`
      )
      .bind(...row.map(([, value]) => value), ...bookingClashBinds(b.staff_id, b.id, interval, timeZone))
      .run();
    return (result.meta?.changes ?? 0) === 1 ? "created" : "taken";
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return "taken";
    throw err;
  }
}

/**
 * Put a cancelled booking back to confirmed, only if no active booking holds
 * any of its time for the same staff member. The clash check is part of the
 * UPDATE (one statement, which D1 runs atomically), and the status it left is
 * read in the same batch, so nothing can book the time in between:
 * - "reinstated": confirmed again;
 * - "taken": still cancelled, because another booking now holds its time;
 * - "unchanged": it was no longer cancelled, so nothing was written.
 * A booking whose own times cannot be read is reinstated unchecked, as the
 * API's status changes treat it (bookingTimeTaken). The clash rule is
 * @repo/utils BOOKING_CLASH_SQL, as for createBookingIfFree.
 */
export async function reinstateCancelledIfFree(
  db: D1Database,
  b: { id: string; shop_id: string; staff_id: string } & BookingTimes,
  timeZone: string,
): Promise<"reinstated" | "taken" | "unchanged"> {
  const interval = bookingInterval(b, timeZone);
  const guard = interval ? ` AND NOT ${BOOKING_CLASH_SQL}` : "";
  const clashBinds = interval ? bookingClashBinds(b.staff_id, b.id, interval, timeZone) : [];
  let update: D1Result | undefined;
  let read: D1Result | undefined;
  try {
    [update, read] = await db.batch([
      db
        .prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ? AND shop_id = ? AND status = 'cancelled'${guard}`)
        .bind(b.id, b.shop_id, ...clashBinds),
      db.prepare("SELECT status FROM bookings WHERE id = ? AND shop_id = ?").bind(b.id, b.shop_id),
    ]);
  } catch (err) {
    // Only reachable unchecked: an identical start already active.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return "taken";
    throw err;
  }
  if ((update?.meta?.changes ?? 0) === 1) return "reinstated";
  const status = (read?.results?.[0] as { status?: string } | undefined)?.status;
  return status === "cancelled" ? "taken" : "unchanged";
}

export async function checkSlotConflict(
  db: D1Database,
  staffId: string,
  startTime: string,
  endTime: string,
  timeZone: string = "Europe/London"
): Promise<boolean> {
  // Overlap is a pure instant-range comparison — do NOT gate on booking_date.
  // booking_date is the UTC calendar date, so an overlapping booking whose
  // instant straddles UTC midnight onto an adjacent date would be missed by a
  // single-date filter, letting two different-start bookings double-book.
  //
  // Walk-in and deposit bookings hold the shop's clock reading ("09:30") on
  // booking_date (lib/bookingTimes.ts). Those are fetched by a date range wide
  // enough for any zone and a past-midnight end, then read in `timeZone`.
  const { results } = await db
    .prepare(
      `SELECT booking_date, start_time, end_time FROM bookings
       WHERE staff_id = ?
         AND status NOT IN ('cancelled', 'no_show')
         AND ((${INSTANT_START_SQL} AND start_time < ? AND end_time > ?)
           OR (${CLOCK_START_SQL} AND booking_date BETWEEN ? AND ?))`
    )
    .bind(staffId, endTime, startTime, shiftDate(startTime.slice(0, 10), -2), shiftDate(endTime.slice(0, 10), 1))
    .all<BookingTimes>();
  const start = new Date(startTime);
  const end = new Date(endTime);
  return results.some((row) => {
    const interval = bookingInterval(row, timeZone);
    return interval !== null && rangesOverlap(start, end, interval.start, interval.end);
  });
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
