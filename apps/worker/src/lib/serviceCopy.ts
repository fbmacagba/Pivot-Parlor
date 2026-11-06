/**
 * Generated per-service copy lives in shop_sites.services_json (written by the
 * site assembler); the services table has no description column. This joins
 * the two by service NAME so the public site and the booking flow show the
 * same description for the same service. Prices and durations always come
 * from the services table, never from generated JSON.
 */
export function normalizeServiceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const MAX_DESCRIPTION = 280;

export function serviceDescriptionsByName(servicesJson: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!servicesJson) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(servicesJson);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { name, description } = item as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || typeof description !== "string") continue;
    const text = description.trim();
    if (!text) continue;
    const key = normalizeServiceName(name);
    if (key && !out.has(key)) out.set(key, text.slice(0, MAX_DESCRIPTION));
  }
  return out;
}
