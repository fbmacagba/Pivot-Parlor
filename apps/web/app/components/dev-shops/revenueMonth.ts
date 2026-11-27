/** How many months back the revenue page's picker offers, this month included. */
export const MONTHS_OFFERED = 24;

/**
 * The month the address asks for, or this month when it asks for none or for
 * one that cannot be shown (not a number, month 13, a month still to come, or
 * one older than the picker offers). `adjusted` says the address was not
 * honoured, so the page can say which month it is showing instead.
 */
export function monthFromParams(
  params: URLSearchParams,
  now: Date,
): { year: number; month: number; adjusted: boolean } {
  // UTC, as the API's own "this month" is.
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  const rawYear = params.get("year");
  const rawMonth = params.get("month");
  if (rawYear === null && rawMonth === null) return { year: thisYear, month: thisMonth, adjusted: false };
  const year = /^\d{4}$/.test(rawYear ?? "") ? Number(rawYear) : NaN;
  const month = /^\d{1,2}$/.test(rawMonth ?? "") ? Number(rawMonth) : NaN;
  const monthsAgo = (thisYear - year) * 12 + (thisMonth - month);
  const ok = Number.isInteger(year) && month >= 1 && month <= 12 && monthsAgo >= 0 && monthsAgo < MONTHS_OFFERED;
  return ok ? { year, month, adjusted: false } : { year: thisYear, month: thisMonth, adjusted: true };
}
