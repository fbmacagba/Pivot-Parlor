/**
 * Reading the JSON an activity entry carries (`changes_json`, `details_json`).
 *
 * The trail is append-only and holds entries from every release, so one entry
 * with a truncated or unexpected value must cost that entry's detail and
 * nothing else: the page shows "Details unavailable" for it and keeps going.
 */

export type ParsedChanges =
  | { ok: true; rows: Array<{ field: string; before: string; after: string }> }
  | { ok: false };

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "(unreadable)";
  }
}

/** `{ field: [before, after] }` as rows, or `{ ok: false }` when it is not that. null when there is nothing. */
export function parseChanges(raw: string | null | undefined): ParsedChanges | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const rows = Object.entries(parsed as Record<string, unknown>).map(([field, value]) =>
    Array.isArray(value) && value.length === 2
      ? { field, before: show(value[0]), after: show(value[1]) }
      : // Not a before/after pair: show what is there rather than drop it.
        { field, before: "", after: show(value) },
  );
  return { ok: true, rows };
}

export type ParsedDetails = { ok: true; pretty: string } | { ok: false };

/** The details pretty-printed, or `{ ok: false }` when they do not parse. null when there are none. */
export function parseDetails(raw: string | null | undefined): ParsedDetails | null {
  if (!raw) return null;
  try {
    return { ok: true, pretty: JSON.stringify(JSON.parse(raw), null, 2) };
  } catch {
    return { ok: false };
  }
}
