/**
 * Every date, time and count the website shows goes through here.
 *
 * A page is rendered twice: on the server (Cloudflare, en-US, UTC) and again
 * in the visitor's browser (their language, their time zone). Anything
 * formatted with the defaults comes out differently on the two sides, React
 * throws the server's page away (a hydration failure, which the browser
 * alert reports), and in British Summer Time the server's HTML shows times
 * an hour early. So everything here is fixed to UK English and London time,
 * unless a call names another zone (a shop's own).
 *
 * Timestamps from the API are read with toInstant: SQLite's datetime('now')
 * writes "2026-11-12 15:00:00", UTC with no offset, which JavaScript would
 * otherwise read as local time.
 *
 * tests/e2e/dashboards.spec.ts sweeps the dashboards in Tokyo time, and
 * dateFormatGuard.test.ts keeps date formatting out of every other file.
 */

export const UK_LOCALE = "en-GB";
export const UK_TIME_ZONE = "Europe/London";

type DateInput = string | number | Date;
type Options = Intl.DateTimeFormatOptions;

// "2026-11-12 15:00:00" or "2026-11-12T15:00:00(.123)", with no offset.
const NO_OFFSET = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A clock reading with no date: walk-ins and deposit bookings store their
// start_time as the shop's own "09:30" (the booking worker's slot_time).
const WALL_TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

function wallClock(value: DateInput): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = WALL_TIME.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** A timestamp from the API as an instant. An offset-less date and time is UTC. */
export function toInstant(value: DateInput): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "number") return new Date(value);
  const text = value.trim();
  const match = NO_OFFSET.exec(text);
  return new Date(match ? `${match[1]}T${match[2]}Z` : text);
}

function format(value: DateInput, options: Options, as: "date" | "time" | "both"): string {
  const wall = wallClock(value);
  if (wall) {
    // Already the shop's clock: shown as written, never shifted, and it has no date.
    if (as !== "time") return "";
    const at = Date.UTC(1970, 0, 1, wall.hour, wall.minute);
    return new Date(at).toLocaleTimeString(UK_LOCALE, { ...options, timeZone: "UTC" });
  }
  const d = toInstant(value);
  if (Number.isNaN(d.getTime())) return "";
  const render = (timeZone: string) => {
    const opts = { ...options, timeZone };
    if (as === "date") return d.toLocaleDateString(UK_LOCALE, opts);
    if (as === "time") return d.toLocaleTimeString(UK_LOCALE, opts);
    return d.toLocaleString(UK_LOCALE, opts);
  };
  const zone = options.timeZone || UK_TIME_ZONE;
  try {
    return render(zone);
  } catch (error) {
    // A zone this browser does not know (a shop's, from the API) would
    // otherwise throw and take the whole page down: show London time.
    if (error instanceof RangeError && zone !== UK_TIME_ZONE) return render(UK_TIME_ZONE);
    throw error;
  }
}

/** The date of an instant, in London. "" for an invalid value. */
export function formatDate(value: DateInput, options: Options = {}): string {
  return format(value, options, "date");
}

/** The time of an instant, in London. "" for an invalid value. */
export function formatTime(value: DateInput, options: Options = {}): string {
  return format(value, options, "time");
}

/** The date and time of an instant, in London. "" for an invalid value. */
export function formatDateTime(value: DateInput, options: Options = {}): string {
  return format(value, options, "both");
}

/**
 * A calendar day ("2026-11-12": a booking date, a waitlist day) as that same
 * day everywhere. Not an instant, so no zone applies. Anything else is
 * returned as it is.
 */
export function formatDay(day: string, options: Options = {}): string {
  if (!DAY.test(day)) return day;
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(UK_LOCALE, { ...options, timeZone: "UTC" });
}

/** A whole number with UK thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString(UK_LOCALE);
}

export interface UkParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
  /** 0 is Sunday, as Date.getDay. */
  weekday: number;
}

const PARTS = new Intl.DateTimeFormat(UK_LOCALE, {
  timeZone: UK_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The London clock's reading for an instant (now by default), instead of the
 * machine's getHours() and friends. Never throws, since it runs while a page
 * renders: a value that is not an instant gives NaN fields and weekday -1.
 */
export function ukParts(value: DateInput = new Date()): UkParts {
  const instant = toInstant(value);
  if (Number.isNaN(instant.getTime())) {
    return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, weekday: -1 };
  }
  const parts: Record<string, string> = {};
  for (const p of PARTS.formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

/**
 * The hour and minute a booking starts, for a page to lay out: a walk-in's
 * "09:30" as written, an instant on the London clock. null when the value is
 * neither, so the caller can show it as it is.
 */
export function clockOf(value: DateInput): { hour: number; minute: number } | null {
  const wall = wallClock(value);
  if (wall) return wall;
  const { hour, minute } = ukParts(value);
  return Number.isNaN(hour) ? null : { hour, minute };
}

/** Today's date in London, as "YYYY-MM-DD". */
export function ukToday(now: Date = new Date()): string {
  const { year, month, day } = ukParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Today's date on a shop's own calendar, as "YYYY-MM-DD". London when the
 * shop names no zone, or one this machine does not know (as format() does).
 */
export function shopToday(timeZone: string | null | undefined, now: Date = new Date()): string {
  if (!timeZone || timeZone === UK_TIME_ZONE) return ukToday(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(UK_LOCALE, { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch (error) {
    if (error instanceof RangeError) return ukToday(now);
    throw error;
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
