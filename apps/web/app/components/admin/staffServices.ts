/**
 * The services an owner can assign to a staff member.
 *
 * `GET /api/shops/:shopId/services` answers in the public shape
 * (`durationMinutes`, `isActive`), while the services nested in a staff row
 * are raw database rows (`duration_min`, `is_active` as 0 or 1). The staff
 * page once read the list in the raw shape, found no active service in it and
 * never drew the assignment block. This reads either shape.
 */
export interface AssignableService {
  id: string;
  name: string;
  durationMinutes: number;
  price_pence: number;
}

function isOn(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function assignableServices(raw: unknown): AssignableService[] {
  if (!Array.isArray(raw)) return [];
  const out: AssignableService[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string") continue;
    // A row with no flag at all came from the active-only list.
    const flag = r.isActive ?? r.is_active;
    if (flag !== undefined && !isOn(flag)) continue;
    const duration = Number(r.durationMinutes ?? r.duration_min ?? 0);
    const price = Number(r.price_pence ?? 0);
    out.push({
      id: r.id,
      name: r.name,
      durationMinutes: Number.isFinite(duration) ? duration : 0,
      price_pence: Number.isInteger(price) ? price : 0,
    });
  }
  return out;
}

/** A staff row's `is_active`, which the API sends as 0 or 1. */
export function isActiveFlag(value: unknown): boolean {
  return isOn(value);
}
