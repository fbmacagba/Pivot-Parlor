/** Generate a URL-friendly slug from a string */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Format a price (cents) to a locale currency string */
export function formatPrice(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/** Format a date-time string to a readable locale string */
export function formatDateTime(iso: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/** Format minutes into "Xhr Ymin" display */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}hr`;
  return `${h}hr ${m}min`;
}

/** Calculate platform commission */
export function calcCommission(amount: number, ratePercent: number): number {
  return Math.round(amount * (ratePercent / 100));
}

/** Add minutes to a Date and return a new Date */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** Check if two date ranges overlap */
export function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Generate a cryptographically-random ID (safe in both browser and Workers) */
export function generateId(length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse JSON without throwing. Returns null on null/undefined input or on a
 * parse error — use for KV/DB-stored JSON where a corrupt value must degrade
 * to "absent" (cache miss, no theme, empty list) rather than crash the handler.
 */
export function safeJsonParse<T = unknown>(raw: string | null | undefined): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Cloudflare Queues maximum delaySeconds (12 hours). */
export const MAX_QUEUE_DELAY_S = 43_200;

/**
 * Seconds to delay a reminder message so it (re)arrives at or after sendAt.
 * Queues cap delays at 12h, so longer waits are made in hops: the producer
 * delays the first 12h and the consumer re-delays (msg.retry) the remainder.
 * Returns 0 when sendAt is due or past.
 */
export function reminderDelaySeconds(sendAt: Date, now: Date): number {
  const remainingS = Math.ceil((sendAt.getTime() - now.getTime()) / 1000);
  if (remainingS <= 0) return 0;
  return Math.min(remainingS, MAX_QUEUE_DELAY_S);
}
