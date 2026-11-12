/**
 * The shop's calendar and clock, for the API's "today" and hour-of-day
 * answers. Workers run in UTC, but a UK shop's day starts at midnight London
 * time: an hour before UTC's in British Summer Time.
 *
 * shops.timezone defaults to Europe/London and no route writes it yet, so in
 * practice every shop is on London time. booking_date is written as the UTC
 * date of the booking's start (booking worker), which is the London date for
 * every booking that starts at 01:00 London time or later.
 */

export const PLATFORM_TIME_ZONE = "Europe/London";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | null | undefined): Intl.DateTimeFormat {
  const zone = timeZone || PLATFORM_TIME_ZONE;
  const cached = formatters.get(zone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch (error) {
    // An unknown zone must not take a dashboard down: read London's clock.
    if (error instanceof RangeError && zone !== PLATFORM_TIME_ZONE) return formatterFor(PLATFORM_TIME_ZONE);
    throw error;
  }
  formatters.set(zone, formatter);
  return formatter;
}

function partsAt(instant: Date, timeZone: string | null | undefined) {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The shop's date now, "YYYY-MM-DD" (London when the zone is missing or unknown). */
export function shopToday(timeZone?: string | null, now: Date = new Date()): string {
  const { year, month, day } = partsAt(now, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The first day of the month `monthsBack` months before the shop's current month, "YYYY-MM-01". */
export function shopMonthStart(monthsBack: number, timeZone?: string | null, now: Date = new Date()): string {
  const { year, month } = partsAt(now, timeZone);
  const index = year * 12 + (month - 1) - monthsBack;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}-01`;
}

/**
 * The SQL bucket for a booking's start hour. bookings.start_time holds either
 * an instant (online bookings: "2026-07-01T09:00:00.000Z"), bucketed by UTC
 * date and hour, or a walk-in or deposit booking's own clock reading
 * ("09:30", the booking worker's slot_time), bucketed as "wall:09".
 */
export const START_HOUR_BUCKET_SQL =
  "CASE WHEN start_time GLOB '[0-9][0-9][0-9][0-9]-*' THEN strftime('%Y-%m-%dT%H', start_time) " +
  "ELSE 'wall:' || strftime('%H', start_time) END";

const WALL_BUCKET = /^wall:(\d{2})$/;
const UTC_BUCKET = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/;

/**
 * Turns START_HOUR_BUCKET_SQL counts into counts per hour of the shop's day.
 * A UTC hour maps to one shop hour: exact for whole-hour zones such as
 * London, whose clock changes fall on whole UTC hours.
 */
export function peakHoursInShopTime(
  rows: Array<{ bucket: string | null; booking_count: number }>,
  timeZone?: string | null,
): Array<{ hour: number; booking_count: number }> {
  const totals = new Map<number, number>();
  for (const row of rows) {
    let hour: number | null = null;
    const wall = row.bucket ? WALL_BUCKET.exec(row.bucket) : null;
    const utc = row.bucket ? UTC_BUCKET.exec(row.bucket) : null;
    if (wall) hour = Number(wall[1]);
    else if (utc) hour = partsAt(new Date(`${utc[1]}T${utc[2]}:00:00Z`), timeZone).hour;
    if (hour === null || Number.isNaN(hour)) continue;
    totals.set(hour, (totals.get(hour) ?? 0) + Number(row.booking_count));
  }
  return [...totals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, booking_count]) => ({ hour, booking_count }));
}
