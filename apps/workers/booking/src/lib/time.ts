import { shiftDate, zonedTimeToUtc, zonedWallClock } from "@repo/utils";

/**
 * The shop's calendar. Workers run in UTC, but a UK shop's day starts at
 * midnight London time, which in British Summer Time is 23:00 UTC the
 * evening before. Every "today", every booking's booking_date and every
 * "sales on this day" in this worker is the shop's day, read here.
 * shops.timezone defaults to Europe/London.
 */
export const PLATFORM_TIME_ZONE = "Europe/London";

/** The shop's zone, or London when it is missing or unknown (a bad zone must not take the till down). */
function knownZone(timeZone: string | null | undefined): string {
  const zone = timeZone || PLATFORM_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return PLATFORM_TIME_ZONE;
  }
}

/** The shop's calendar date of an instant, "YYYY-MM-DD". */
export function shopDateOf(instant: Date, timeZone: string | null | undefined): string {
  return zonedWallClock(instant, knownZone(timeZone)).slice(0, 10);
}

/** The shop's date now, "YYYY-MM-DD". */
export function shopToday(timeZone: string | null | undefined, now: Date = new Date()): string {
  return shopDateOf(now, timeZone);
}

/** A UTC instant as the database writes timestamps: datetime('now') gives "YYYY-MM-DD HH:MM:SS". */
function asDbTimestamp(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The shop's day `date` ("YYYY-MM-DD") as UTC timestamps: `from` inclusive,
 * `to` exclusive. 24 hours long, except on the days the clocks change.
 * Compare with shopDaySql, which reads a stored timestamp in either shape
 * ("YYYY-MM-DD HH:MM:SS" or an ISO instant).
 */
export function shopDayBounds(date: string, timeZone: string | null | undefined): { from: string; to: string } {
  const zone = knownZone(timeZone);
  return {
    from: asDbTimestamp(zonedTimeToUtc(date, "00:00", zone)),
    to: asDbTimestamp(zonedTimeToUtc(shiftDate(date, 1), "00:00", zone)),
  };
}

/** SQL: the timestamp `column` falls in a shop's day. Binds `from` then `to` from shopDayBounds. */
export function shopDaySql(column: string): string {
  return `datetime(${column}) >= ? AND datetime(${column}) < ?`;
}

export function addMinutesToHm(hm: string, addMin: number): string {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return hm;
  let total = h * 60 + m + addMin;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

export function minutesToHm(total: number): string {
  const t = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Generate ["09:00","09:30",...] from start to end (exclusive of end), step minutes. */
export function generateSlotTimes(start: string, end: string, stepMin: number): string[] {
  const out: string[] = [];
  let cur = hmToMinutes(start);
  const endM = hmToMinutes(end);
  while (cur + stepMin <= endM) {
    out.push(minutesToHm(cur));
    cur += stepMin;
  }
  return out;
}
