/**
 * The owner-entered facts the generation pipeline may state about a shop.
 * The research and text prompts treat this block as the ONLY source of
 * business facts (team, hours, area); anything not listed here must not be
 * claimed by generated copy. Pure, so it is unit-tested without a database.
 */
export interface SiteResearchBusiness {
  /** "Deptford, London": the address minus the street line and postcode. */
  locality?: string;
  /** Owner-entered opening hours per day ("closed" when empty). */
  hours?: Record<string, string>;
  /** Public team names with their owner-entered specialism. */
  team: Array<{ name: string; speciality?: string }>;
  /** Distinct service categories, in menu order. */
  categories: string[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

export function localityFromAddress(address: string | null | undefined): string | undefined {
  if (!address) return undefined;
  const parts = address
    .split(",")
    .map((p) => p.replace(UK_POSTCODE, "").trim())
    .filter(Boolean);
  // A single-line address is all street: there is no locality to keep.
  if (parts.length < 2) return undefined;
  const locality = parts.slice(1).join(", ").slice(0, 80);
  return locality || undefined;
}

export function hoursFromJson(json: string | null | undefined): Record<string, string> | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  let any = false;
  for (const d of DAYS) {
    const v = o[d];
    const raw = typeof v === "string" ? v.trim() : "";
    // The admin editor writes "" for a closed day; older rows may say "Closed".
    const text = raw && raw.toLowerCase() !== "closed" ? raw.slice(0, 40) : "closed";
    if (text !== "closed") any = true;
    out[d] = text;
  }
  return any ? out : undefined;
}

export function buildSiteResearchBusiness(input: {
  staff: Array<{ display_name: string; speciality?: string | null }>;
  services: Array<{ category?: string | null }>;
  address?: string | null;
  hours_json?: string | null;
}): SiteResearchBusiness {
  const categories: string[] = [];
  for (const s of input.services) {
    const c = typeof s.category === "string" ? s.category.trim() : "";
    if (c && c.toLowerCase() !== "service" && !categories.includes(c)) categories.push(c);
  }
  const team = input.staff.slice(0, 12).map((m) => {
    const speciality = typeof m.speciality === "string" && m.speciality.trim() ? m.speciality.trim().slice(0, 80) : undefined;
    return { name: m.display_name.trim().slice(0, 60), ...(speciality ? { speciality } : {}) };
  });
  const locality = localityFromAddress(input.address);
  const hours = hoursFromJson(input.hours_json);
  return {
    ...(locality ? { locality } : {}),
    ...(hours ? { hours } : {}),
    team,
    categories,
  };
}
