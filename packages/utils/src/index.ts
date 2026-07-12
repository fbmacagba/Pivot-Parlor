export * from "./siteTheme";
export * from "./curatedFonts";

/** Generate a URL-friendly slug from a string */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Money (WS-4) ─────────────────────────────────────────────────────────────
// All money is stored and computed as INTEGER pence. Pounds exist only at two
// boundaries: form input (parsePoundsToPence) and display/presentation
// (formatPence / penceToPoundsNumber). Never do arithmetic on pounds values.

export interface CommissionBreakdownPence {
  amount_pence: number;
  commission_pence: number;
  shop_revenue_pence: number;
  commission_rate: number;
}

/**
 * The single commission rounding path (WS-4). `commissionRate` is a decimal
 * rate (0.10 = 10%). Commission rounds to the nearest penny; shop revenue is
 * the exact integer remainder, so commission + shop_revenue === amount.
 */
export function calculateCommissionPence(
  amountPence: number,
  commissionRate: number
): CommissionBreakdownPence {
  if (!Number.isInteger(amountPence)) {
    throw new Error(`amountPence must be an integer, got ${amountPence}`);
  }
  const commission_pence = Math.round(amountPence * commissionRate);
  return {
    amount_pence: amountPence,
    commission_pence,
    shop_revenue_pence: amountPence - commission_pence,
    commission_rate: commissionRate,
  };
}

/** Display boundary: 2550 -> "£25.50". Always two decimals. */
export function formatPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(Math.round(pence));
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Presentation boundary (AI copy, price_gbp fields): 2550 -> 25.5. Not for arithmetic. */
export function penceToPoundsNumber(pence: number): number {
  return Math.round(pence) / 100;
}

/** One-off conversion boundary: 25.5 -> 2550. Not for arithmetic chains. */
export function poundsToPence(pounds: number): number {
  return Math.round(pounds * 100);
}

/**
 * Form-input boundary: "25", "25.5", "£25.50", " 25.50 " -> pence integer.
 * Returns null for anything that is not a plain non-negative pounds amount
 * with at most two decimal places.
 */
export function parsePoundsToPence(input: string): number | null {
  const cleaned = input.trim().replace(/^£/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
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
