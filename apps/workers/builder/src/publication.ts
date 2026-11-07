/**
 * Publication gate for generated sites: the last checks before the assembler
 * writes a candidate over the shop's published row. Pure, unit-tested.
 *
 *  1. Truthfulness. Generated copy may not assert facts the platform cannot
 *     back: client or booking counts, star ratings, review scores, awards,
 *     rankings, years trading, guarantees, credentials, press or third-party
 *     review platforms. A claim survives only when the owner's own notes or
 *     records contain it. Dropped items are replaced from the shop's records.
 *  2. No downgrade. Every image slot that failed or timed out in this job keeps
 *     the photo already published in that slot, so a bad regeneration can
 *     never replace a usable site with an emptier one. Per-service photos are
 *     reused only while the service list is unchanged, because catalog slots
 *     are positional and an old photo would otherwise land on another service.
 */

const CLAIM_PATTERNS: RegExp[] = [
  // "500+ happy clients", "2,000 cuts", "10k customers"
  /\b\d[\d,.]*\s*k?\s*\+?\s*(?:happy\s+|satisfied\s+|loyal\s+|regular\s+)?(?:clients?|customers?|guests?|cuts|haircuts|reviews?|bookings?|appointments|visits|members)\b/i,
  // "5-star", "five star", "4.9/5", "rated", "top-rated"
  /\b(?:[1-5](?:\.\d)?|five|four)[\s-]*stars?\b/i,
  /\b\d(?:\.\d)?\s*\/\s*5\b/,
  /\b(?:top|highest|best|highly)[\s-]+rated\b|\brated\b/i,
  /\baward(?:s|[\s-]*winning)?\b/i,
  /(?:#\s?1\b|\bno\.?\s?1\b|\bnumber\s+one\b)/i,
  /\b(?:the\s+)?best\s+(?:barbers?|barbershop|salon|stylists?|hairdressers?|hair|cuts?|fades?|value|in\b|around\b|near\b)/i,
  /\bguarantee(?:s|d)?\b/i,
  /\b(?:since|established|est\.?|founded|opened)\s+(?:in\s+)?(?:19|20)\d{2}\b/i,
  /\b\d+\s*\+?\s*years?\b/i,
  /\b(?:voted|featured\s+in|as\s+seen\s+(?:in|on)|celebrit(?:y|ies)|famous)\b/i,
  /\b(?:certified|accredited|award|licensed|trained\s+at|master\s+barber)\b/i,
  /\b(?:google|trustpilot|treatwell|fresha|booksy|yelp)\b/i,
  /\btestimonials?\b|\breviews?\b/i,
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** True when `text` asserts something the owner's facts do not contain. */
export function isUnverifiableClaim(text: string, ownerFacts: string): boolean {
  const facts = norm(ownerFacts);
  for (const re of CLAIM_PATTERNS) {
    const m = text.match(re);
    if (m && !facts.includes(norm(m[0]))) return true;
  }
  return false;
}

export function filterClaims(items: string[], ownerFacts: string): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of items) {
    const item = typeof raw === "string" ? raw.trim() : "";
    if (!item) continue;
    (isUnverifiableClaim(item, ownerFacts) ? dropped : kept).push(item);
  }
  return { kept, dropped };
}

/** Remove only the sentences that carry an unverifiable claim. */
export function scrubSentences(text: string, ownerFacts: string): { text: string; dropped: string[] } {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const dropped: string[] = [];
  const kept = sentences.filter((s) => {
    if (!s.trim()) return false;
    if (isUnverifiableClaim(s, ownerFacts)) {
      dropped.push(s.trim());
      return false;
    }
    return true;
  });
  return { text: kept.join("").trim(), dropped };
}

/** Fill a list to `n` from fallbacks that themselves pass the gate. */
export function fillFrom(kept: string[], fallbacks: string[], n: number, ownerFacts: string): string[] {
  const out = [...kept];
  for (const f of fallbacks) {
    if (out.length >= n) break;
    if (f.trim() && !out.includes(f) && !isUnverifiableClaim(f, ownerFacts)) out.push(f);
  }
  return out.slice(0, n);
}

/** A locked slot always keeps its published image; an unlocked slot takes the
 *  new image, or keeps the published one when this job produced none. */
export function chooseImage(args: { generated: string | null | undefined; existing: string | null | undefined; locked: boolean }): string | null {
  const existing = args.existing?.trim() || null;
  if (args.locked) return existing;
  return args.generated?.trim() || existing;
}

const serviceKey = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** Names of the services a published services_json row was generated for. */
export function servicesJsonNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const p = JSON.parse(json) as unknown;
    return Array.isArray(p)
      ? p.map((x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? (x as { name: string }).name : ""))
      : [];
  } catch {
    return [];
  }
}

/** One catalog slot per current service. A failed slot reuses the published
 *  photo only when the published row was built for the same service list in
 *  the same order; otherwise it stays empty (the card renders imageless). */
export function mergeCatalog(args: {
  generated: string[];
  existing: string[];
  serviceNames: string[];
  existingServiceNames: string[];
}): string[] {
  const sameList =
    args.existingServiceNames.length === args.serviceNames.length &&
    args.serviceNames.every((n, i) => serviceKey(n) === serviceKey(args.existingServiceNames[i] ?? ""));
  return args.serviceNames.map((_, i) => {
    const g = typeof args.generated[i] === "string" ? args.generated[i]!.trim() : "";
    if (g) return g;
    return sameList && typeof args.existing[i] === "string" ? args.existing[i]!.trim() : "";
  });
}

/** Gallery photos are not tied to a service: keep each new photo, fill any
 *  failed slot from the published gallery, drop empties, cap at `max`. */
export function mergeGallery(generated: string[], existing: string[], max = 3): string[] {
  const out: string[] = [];
  const len = Math.max(generated.length, existing.length);
  for (let i = 0; i < len && out.length < max; i++) {
    const g = generated[i]?.trim();
    const e = existing[i]?.trim();
    const pick = g || e;
    if (pick && !out.includes(pick)) out.push(pick);
  }
  return out;
}

// ─── Owner review (migration 049) ────────────────────────────────────────────
// A regeneration of a site the public can already reach (live or paused) is
// stored in shop_site_candidates and published only when the developer or the
// shop's admin approves it. Drafts and brand-new sites are written directly,
// as before. The API worker reads, validates and publishes the payload
// (apps/worker/src/lib/siteCandidate.ts); its column list must stay identical
// to this one (a worker test compares them).

/** shop_sites columns a regeneration writes, in the site UPDATE's order. */
export const CANDIDATE_COLUMNS = [
  "headline",
  "tagline",
  "about",
  "services_json",
  "hero_image_url",
  "logo_url",
  "catalog_images_json",
  "color_primary",
  "color_accent",
  "font_heading",
  "font_body",
  "seo_title",
  "seo_description",
  "trust_signals_json",
  "usps_json",
  "layout_mood",
  "brand_voice",
  "hero_cta",
  "about_title",
  "palette_json",
  "heading_weight",
  "heading_style",
  "design_spec",
  "design_version",
  "gallery_images_json",
  "generated_at",
] as const;

export type CandidateColumn = (typeof CANDIDATE_COLUMNS)[number];
export type CandidateColumnValues = Record<CandidateColumn, string | number | null>;

/** Where this job's result goes. Only a draft (or a shop with no site row)
 *  is written in place; any other status, including one this code does not
 *  know, waits for review, so the public site never changes unapproved. */
export function siteWriteTarget(existing: { website_status?: string | null } | null | undefined): "direct" | "candidate" {
  if (!existing) return "direct";
  const status = (existing.website_status ?? "draft").trim().toLowerCase() || "draft";
  return status === "draft" ? "direct" : "candidate";
}

/** The stored candidate: every column, the owner palette override (if this
 *  job carried one) and the menu the positional catalog was built for. */
export function buildCandidatePayload(args: {
  columns: CandidateColumnValues;
  ownerPalette: { primary: string; accent: string } | null;
  serviceNames: string[];
}): string {
  const columns: Record<string, string | number | null> = {};
  for (const key of CANDIDATE_COLUMNS) columns[key] = args.columns[key] ?? null;
  return JSON.stringify({
    version: 1,
    columns,
    owner_palette: args.ownerPalette,
    service_names: args.serviceNames,
  });
}

export interface CandidateCopy {
  headline: string;
  tagline: string;
  about: string;
  seo_title: string;
  seo_description: string;
  hero_cta: string | null;
  about_title: string | null;
  trust_signals: string[];
  usps: string[];
  services: Array<{ name: string; description: string }>;
}

export interface GateInput {
  shopName: string;
  /** Everything the owner told us: style notes, team, hours, area, service
   *  names. A claim found here is the owner's own and may be published. */
  ownerFacts: string;
  copy: CandidateCopy;
  /** Research's copy, used when the text pass's version had to be dropped. */
  researchHeadline?: string;
  researchAbout?: string;
  /** True statements from the shop's records (opening days, team size...). */
  factSignals: string[];
}

export interface GateResult {
  copy: CandidateCopy;
  dropped: string[];
}

/** Apply the truthfulness gate to every published string. */
export function gateCopy(input: GateInput): GateResult {
  const { ownerFacts, shopName } = input;
  const dropped: string[] = [];
  const clean = (s: string | null | undefined): string => {
    const r = scrubSentences(s ?? "", ownerFacts);
    dropped.push(...r.dropped);
    return r.text;
  };
  const single = (s: string | null | undefined, fallback: string): string => {
    const t = (s ?? "").trim();
    if (t && !isUnverifiableClaim(t, ownerFacts)) return t;
    if (t) dropped.push(t);
    return fallback;
  };

  const researchHeadline = input.researchHeadline?.trim() ?? "";
  const headline = single(
    input.copy.headline,
    researchHeadline && !isUnverifiableClaim(researchHeadline, ownerFacts) ? researchHeadline : shopName,
  );
  const about = clean(input.copy.about) || clean(input.researchAbout) || "";
  const trust = filterClaims(input.copy.trust_signals, ownerFacts);
  const usps = filterClaims(input.copy.usps, ownerFacts);
  dropped.push(...trust.dropped, ...usps.dropped);

  return {
    dropped,
    copy: {
      headline,
      tagline: clean(input.copy.tagline),
      about,
      seo_title: single(input.copy.seo_title, `${shopName} | Book online`),
      seo_description: clean(input.copy.seo_description) || `Book an appointment at ${shopName} online.`,
      hero_cta: input.copy.hero_cta ? single(input.copy.hero_cta, "Book now") : null,
      about_title: input.copy.about_title ? single(input.copy.about_title, "About us") : null,
      trust_signals: fillFrom(trust.kept, input.factSignals, 3, ownerFacts),
      usps: fillFrom(usps.kept, ["Every price shown up front", "Pick your own team member", "Book online, any time"], 3, ownerFacts),
      services: input.copy.services.map((s) => ({ ...s, description: clean(s.description) })),
    },
  };
}
