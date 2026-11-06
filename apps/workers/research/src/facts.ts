/**
 * Owner-entered business facts for site generation, and the factual fallbacks
 * built from them. Generated copy may state these facts and nothing else about
 * the business: no client counts, ratings, awards, years trading or guarantees
 * unless the owner wrote them in their notes.
 */

/** Mirrors SiteResearchBusiness in apps/worker/src/lib/siteResearchContext.ts. */
export interface ResearchBusiness {
  locality?: string;
  hours?: Record<string, string>;
  team: Array<{ name: string; speciality?: string }>;
  categories: string[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAMES: Record<(typeof DAYS)[number], string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Defensive parse of the queue's optional `business` block (absent on
 *  messages from an older main worker: returns an empty fact set). */
export function parseBusiness(raw: unknown): ResearchBusiness {
  const empty: ResearchBusiness = { team: [], categories: [] };
  if (!raw || typeof raw !== "object") return empty;
  const o = raw as Record<string, unknown>;
  const locality = str(o.locality, 80);
  let hours: Record<string, string> | undefined;
  if (o.hours && typeof o.hours === "object") {
    const h = o.hours as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const d of DAYS) out[d] = str(h[d], 40) ?? "closed";
    if (Object.values(out).some((v) => v.toLowerCase() !== "closed")) hours = out;
  }
  const team = Array.isArray(o.team)
    ? o.team
        .map((m) => {
          if (!m || typeof m !== "object") return null;
          const t = m as Record<string, unknown>;
          const name = str(t.name, 60);
          if (!name) return null;
          const speciality = str(t.speciality, 80);
          return { name, ...(speciality ? { speciality } : {}) };
        })
        .filter((m): m is { name: string; speciality?: string } => m !== null)
        .slice(0, 12)
    : [];
  const categories = Array.isArray(o.categories)
    ? o.categories.map((c) => str(c, 40)).filter((c): c is string => Boolean(c)).slice(0, 12)
    : [];
  return { ...(locality ? { locality } : {}), ...(hours ? { hours } : {}), team, categories };
}

function isOpen(v: string | undefined): boolean {
  return Boolean(v) && v!.toLowerCase() !== "closed";
}

/** "Tuesday to Saturday" for a contiguous open run, else "6 days a week". */
export function openDaysPhrase(hours: Record<string, string> | undefined): string | undefined {
  if (!hours) return undefined;
  const open = DAYS.filter((d) => isOpen(hours[d]));
  if (open.length === 0) return undefined;
  if (open.length === 7) return "Open seven days a week";
  if (open.length === 1) return `Open ${DAY_NAMES[open[0]!]} only`;
  const first = DAYS.indexOf(open[0]!);
  const last = DAYS.indexOf(open[open.length - 1]!);
  if (last - first + 1 === open.length && open.length >= 2) {
    return `Open ${DAY_NAMES[open[0]!]} to ${DAY_NAMES[open[open.length - 1]!]}`;
  }
  return `Open ${open.length} days a week`;
}

/** The facts block given to the model, in plain lines. */
export function formatFactsBlock(b: ResearchBusiness, services: Array<{ name: string }>): string {
  const lines: string[] = [];
  if (b.locality) lines.push(`Area: ${b.locality}`);
  if (b.hours) {
    lines.push(`Opening hours: ${DAYS.map((d) => `${DAY_NAMES[d]} ${b.hours![d]}`).join("; ")}`);
  }
  if (b.team.length > 0) {
    lines.push(
      `Team (${b.team.length}): ${b.team.map((m) => (m.speciality ? `${m.name} (${m.speciality})` : m.name)).join(", ")}`,
    );
  }
  if (b.categories.length > 0) lines.push(`Service categories: ${b.categories.join(", ")}`);
  lines.push(`Number of services on the menu: ${services.length}`);
  lines.push("Customers book online on the shop's own site and choose their team member.");
  return lines.join("\n");
}

/** True trust-strip lines derivable from the shop's records, best first. Used
 *  to fill the strip when model output is missing or was dropped as an
 *  unverifiable claim. Never states counts of clients, ratings or awards. */
export function factSignals(b: ResearchBusiness, serviceCount: number, shopType: string): string[] {
  const out: string[] = [];
  const days = openDaysPhrase(b.hours);
  if (days) out.push(days);
  if (b.team.length >= 2) {
    const role = shopType === "barber_shop" ? "barbers" : shopType === "beauty_parlor" ? "stylists" : "team members";
    out.push(`Choose from ${b.team.length} ${role}`);
  }
  out.push("Book online, any time");
  if (serviceCount >= 3) out.push(`${serviceCount} services, clearly priced`);
  if (b.locality) out.push(`Based in ${b.locality}`);
  out.push("No account needed to book");
  return Array.from(new Set(out));
}

/** Map a model-authored { [service name]: description } object onto the real
 *  service names (case and punctuation insensitive). Unknown keys are ignored
 *  so a model can never add a service; missing ones are simply absent. */
export function alignServiceCopy(raw: unknown, services: Array<{ name: string }>): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const byNorm = new Map<string, string>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const text = typeof v === "string" ? v.trim() : "";
      if (text) byNorm.set(norm(k), text.slice(0, 280));
    }
  }
  const out: Record<string, string> = {};
  for (const s of services) {
    const d = byNorm.get(norm(s.name));
    if (d) out[s.name] = d;
  }
  return out;
}

/** Three "the space" photo prompts: interior, tools/products, a detail. No
 *  identifiable people, no text, so they read as the shop's own ambiance. */
export function normalizeGalleryPrompts(raw: unknown, layoutMood: string, shopType: string): string[] {
  const place = shopType === "barber_shop" ? "barbershop" : shopType === "beauty_parlor" ? "hair salon" : "barbershop and salon";
  const fromModel = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string" && p.trim().length > 20).map((p) => p.trim().slice(0, 600))
    : [];
  const fallback = [
    `Photograph of the empty interior of an independent ${place}, ${layoutMood} mood, natural light, no people, no text, no signage`,
    `Close-up still life of the tools and products on a ${place} counter, ${layoutMood} mood, shallow depth of field, no text, no logos`,
    `Photograph of a single styling chair and mirror in an independent ${place}, ${layoutMood} mood, no people, no text`,
  ];
  const out = fromModel.slice(0, 3);
  for (const f of fallback) {
    if (out.length >= 3) break;
    out.push(f);
  }
  return out.map((p) => (/no text/i.test(p) ? p : `${p}, no people, no text, no logos`));
}
