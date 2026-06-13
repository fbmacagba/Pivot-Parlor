import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { safeJsonParse } from "@repo/utils";
import { zonedTimeToUtc } from "../lib/timezone.js";

export interface SlotResult {
  staff_id: string;
  start_time: string;   // ISO string
  end_time: string;     // ISO string
  is_available: boolean;
}

interface ScheduleRow {
  staff_id: string;
  start_time: string;  // "HH:MM"
  end_time: string;    // "HH:MM"
}

interface BookingRow {
  staff_id: string;
  start_time: string;  // ISO string
  end_time: string;    // ISO string
}

const SLOT_STEP_MIN = 30;         // slot start interval
const KV_TTL_SECONDS = 5 * 60;   // 5 minute cache

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function rangesOverlap(s1: Date, e1: Date, s2: Date, e2: Date): boolean {
  return s1 < e2 && e1 > s2;
}

/**
 * Returns available time slots for a given shop/staff/date.
 *
 * Steps:
 *  1. Check KV cache  → slots:{shopId}:{staffId}:{date}
 *  2. Query schedules for matching day_of_week
 *  3. Query existing bookings for that date
 *  4. Generate slots at SLOT_STEP_MIN intervals within each schedule window
 *  5. Filter out overlapping booked slots
 *  6. Write to KV with 5-min TTL
 *  7. Return slot array
 */
export async function getAvailableSlots(
  shopId: string,
  staffId: string | null,
  date: string,         // "YYYY-MM-DD"
  durationMin: number,
  db: D1Database,
  kv: KVNamespace
): Promise<SlotResult[]> {
  const cacheKey = `slots:${shopId}:${staffId ?? "any"}:${date}:${durationMin}`;

  // 1. KV cache check (a corrupt cache value degrades to a miss, not a crash)
  const cached = safeJsonParse<SlotResult[]>(await kv.get(cacheKey));
  if (cached) {
    return cached;
  }

  // 2. Resolve the shop's timezone — schedule times are shop-local wall clock,
  //    slots are UTC instants. (Falls back to Europe/London, the column default.)
  const shopRow = await db
    .prepare("SELECT timezone FROM shops WHERE id = ? LIMIT 1")
    .bind(shopId)
    .first<{ timezone: string | null }>();
  const tz = shopRow?.timezone || "Europe/London";

  // Query schedules for this date's day_of_week. schedules.day_of_week uses a
  // Monday-first convention (0=Mon..6=Sun) — that's what the admin schedule
  // editor writes. JS getUTCDay() is Sunday-first (0=Sun), so convert, or every
  // weekday's schedule is looked up one day off.
  const jsDay = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

  let scheduleQuery =
    `SELECT sc.staff_id, sc.start_time, sc.end_time
     FROM schedules sc
     JOIN staff s ON s.id = sc.staff_id
     WHERE s.shop_id = ? AND sc.day_of_week = ? AND sc.is_active = 1`;
  const scheduleParams: unknown[] = [shopId, jsDay];
  if (staffId) {
    scheduleQuery += " AND sc.staff_id = ?";
    scheduleParams.push(staffId);
  }

  const { results: schedules } = await db
    .prepare(scheduleQuery)
    .bind(...scheduleParams)
    .all<ScheduleRow>();

  if (schedules.length === 0) {
    await kv.put(cacheKey, "[]", { expirationTtl: KV_TTL_SECONDS });
    return [];
  }

  // 3. Query existing bookings overlapping this local day's UTC window.
  //    booking_date is stored as the UTC calendar date of the instant, which
  //    can differ from the shop-local date for non-UTC shops (a local evening
  //    slot can land on the next UTC date). Filtering by the UTC instant window
  //    avoids missing those bookings; the in-memory rangesOverlap below still
  //    does the exact per-slot filtering.
  const dayStartUtc = zonedTimeToUtc(date, "00:00", tz).toISOString();
  const nextDateObj = new Date(`${date}T00:00:00Z`);
  nextDateObj.setUTCDate(nextDateObj.getUTCDate() + 1);
  const dayEndUtc = zonedTimeToUtc(nextDateObj.toISOString().slice(0, 10), "00:00", tz).toISOString();

  let bookingQuery =
    `SELECT staff_id, start_time, end_time FROM bookings
     WHERE shop_id = ?
       AND status NOT IN ('cancelled', 'no_show')
       AND start_time < ? AND end_time > ?`;
  const bookingParams: unknown[] = [shopId, dayEndUtc, dayStartUtc];
  if (staffId) {
    bookingQuery += " AND staff_id = ?";
    bookingParams.push(staffId);
  }

  const { results: existingBookings } = await db
    .prepare(bookingQuery)
    .bind(...bookingParams)
    .all<BookingRow>();

  // 4 & 5. Generate slots, filter booked
  const slots: SlotResult[] = [];

  for (const schedule of schedules) {
    const [startH, startM] = schedule.start_time.split(":").map(Number) as [number, number];
    const [endH, endM] = schedule.end_time.split(":").map(Number) as [number, number];

    let current = zonedTimeToUtc(date, `${pad(startH)}:${pad(startM)}`, tz);
    const windowEnd = zonedTimeToUtc(date, `${pad(endH)}:${pad(endM)}`, tz);

    while (current < windowEnd) {
      const slotEnd = addMinutes(current, durationMin);
      if (slotEnd > windowEnd) break;

      const isBooked = existingBookings.some(
        (b) =>
          b.staff_id === schedule.staff_id &&
          rangesOverlap(current, slotEnd, new Date(b.start_time), new Date(b.end_time))
      );

      slots.push({
        staff_id: schedule.staff_id,
        start_time: current.toISOString(),
        end_time: slotEnd.toISOString(),
        is_available: !isBooked,
      });

      current = addMinutes(current, SLOT_STEP_MIN);
    }
  }

  slots.sort((a, b) => a.start_time.localeCompare(b.start_time));

  // 6. Cache result
  await kv.put(cacheKey, JSON.stringify(slots), { expirationTtl: KV_TTL_SECONDS });

  return slots;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
