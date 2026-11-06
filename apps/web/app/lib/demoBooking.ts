/**
 * Read-only booking support for the portfolio demos. The demo booking flow
 * shows the backing shop's REAL services and team (so site, chat and booking
 * agree), but its times are synthetic: no slots API, no booking, no payment,
 * no email. Times follow the shop's opening hours so a closed day reads as
 * closed, exactly like the live flow.
 */

export interface DemoSlot {
  staff_id: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

function validDate(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date ? d : null;
}

/** The opening window for `date`. `null` = closed that day; `undefined` = the
 *  shop has not published hours, so a neutral 09:00 to 17:00 day is used. */
export function openingWindow(
  hoursJson: string | null | undefined,
  date: string,
): { open: number; close: number } | null | undefined {
  const d = validDate(date);
  if (!d || !hoursJson) return undefined;
  let hours: Record<string, unknown>;
  try {
    const parsed = JSON.parse(hoursJson) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    hours = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const raw = hours[WEEKDAY_KEYS[d.getUTCDay()]!];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.toLowerCase() === "closed") return null;
  const [a, b] = text.split(/\s*[-–]\s*/);
  const open = a ? minutes(a) : null;
  const close = b ? minutes(b) : null;
  return open !== null && close !== null && close > open ? { open, close } : undefined;
}

export function weekdayName(date: string): string {
  const d = validDate(date);
  return d ? WEEKDAY_NAMES[d.getUTCDay()]! : "";
}

/** UTC instant for a wall-clock time in `timeZone` (handles BST/GMT). */
export function zonedTimeToUtc(date: string, minuteOfDay: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (shown - guess));
}

/** Small deterministic hash so the sample diary looks lived-in but is stable. */
function taken(seed: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 4 === 0;
}

/**
 * Synthetic availability for a demo selection. Every id is checked against
 * the lists the page itself loaded, so a crafted query cannot address any
 * other shop's records; dates in the past or outside opening hours return [].
 */
export function demoSlots(args: {
  date: string;
  serviceId: string;
  staffId: string;
  services: Array<{ id: string; durationMinutes: number }>;
  staff: Array<{ id: string }>;
  hoursJson?: string | null;
  timeZone: string;
  now?: Date;
}): DemoSlot[] {
  if (!validDate(args.date)) return [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: args.timeZone }).format(args.now ?? new Date());
  if (args.date < today) return [];
  const service = args.services.find((s) => s.id === args.serviceId);
  if (!service) return [];
  const member =
    args.staffId && args.staffId !== "any" ? args.staff.find((s) => s.id === args.staffId) : args.staff[0];
  if (!member) return [];
  const window = openingWindow(args.hoursJson, args.date);
  if (window === null) return [];
  const { open, close } = window ?? { open: 9 * 60, close: 17 * 60 };
  const out: DemoSlot[] = [];
  for (let t = open; t + service.durationMinutes <= close; t += 30) {
    if (taken(`${args.date}:${member.id}:${t}`)) continue;
    const start = zonedTimeToUtc(args.date, t, args.timeZone);
    out.push({
      staff_id: member.id,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + service.durationMinutes * 60000).toISOString(),
      is_available: true,
    });
  }
  return out;
}
