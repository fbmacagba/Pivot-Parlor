/**
 * Timezone conversion for schedule math. Schedule times ("HH:MM") are
 * shop-local wall-clock times; bookings/slots are stored as UTC instants.
 * Workers ship full ICU, so Intl handles DST tables.
 *
 * Moved from apps/worker/src/lib/timezone.ts in WS-1 — the booking worker is
 * the canonical owner of slot computation.
 */

/** Offset of `tz` from UTC (ms) at the given instant. Positive = ahead of UTC. */
function tzOffsetMs(tz: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

/**
 * UTC instant for wall-clock `time` ("HH:MM") on calendar `date` ("YYYY-MM-DD")
 * in `tz`. Two-pass so dates around a DST transition resolve with the offset
 * that is actually in force at the resulting instant.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const first = new Date(guess.getTime() - tzOffsetMs(tz, guess));
  const offset = tzOffsetMs(tz, first);
  return new Date(guess.getTime() - offset);
}
