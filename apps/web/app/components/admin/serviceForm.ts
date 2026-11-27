/**
 * A service's duration from its form field: a whole number of minutes from 1
 * to a full day. Anything else is null, for both adding and editing: the edit
 * form once sent `parseInt("")` (NaN, which JSON turns into null) to the API.
 */
export const MAX_DURATION_MINUTES = 24 * 60;

export function parseDurationMinutes(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= 1 && minutes <= MAX_DURATION_MINUTES ? minutes : null;
}

export const DURATION_ERROR = "Enter the duration as a whole number of minutes, for example 30.";
