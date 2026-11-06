/**
 * Owner review for regenerated public sites (migration 049).
 *
 * When a site is already public, the assembler stores its result in
 * shop_site_candidates instead of overwriting shop_sites. These helpers read
 * that stored candidate back, decide whether it can still be published, and
 * shape exactly what Publish will write, so the preview and the publish agree.
 */
import { normalizeServiceName } from "./serviceCopy.js";

/**
 * shop_sites columns a regeneration may change. Mirrors the assembler's site
 * write and its CANDIDATE_COLUMNS (apps/workers/builder/src/publication.ts).
 * A stored payload with any other key is refused, never written.
 */
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
export type CandidateColumns = Partial<Record<CandidateColumn, string | number | null>>;

export interface SiteCandidatePayload {
  version: 1;
  columns: CandidateColumns;
  owner_palette: { primary: string; accent: string } | null;
  /** The shop's service names when the candidate was made, in menu order. */
  service_names: string[];
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const ALLOWED = new Set<string>(CANDIDATE_COLUMNS);

/** Parse and validate a stored candidate. Null when it is not a payload this
 *  worker understands; publish then refuses instead of guessing. */
export function parseCandidatePayload(json: string | null | undefined): SiteCandidatePayload | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (!o.columns || typeof o.columns !== "object" || Array.isArray(o.columns)) return null;

  const columns: CandidateColumns = {};
  for (const [key, value] of Object.entries(o.columns as Record<string, unknown>)) {
    if (!ALLOWED.has(key)) return null;
    if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
    columns[key as CandidateColumn] = value as string | number | null;
  }
  if (typeof columns.headline !== "string" || !columns.headline.trim()) return null;

  let owner_palette: SiteCandidatePayload["owner_palette"] = null;
  if (o.owner_palette !== null && o.owner_palette !== undefined) {
    const p = o.owner_palette as { primary?: unknown; accent?: unknown };
    if (typeof p.primary !== "string" || typeof p.accent !== "string") return null;
    if (!HEX6.test(p.primary) || !HEX6.test(p.accent)) return null;
    owner_palette = { primary: p.primary, accent: p.accent };
  }

  if (!Array.isArray(o.service_names) || !o.service_names.every((n) => typeof n === "string")) return null;
  return { version: 1, columns, owner_palette, service_names: o.service_names as string[] };
}

/** Visual-editor locks (migration 045) still win at publish time: a hero or
 *  logo locked after the candidate was made keeps the live image. */
export function withoutLockedImages(
  columns: CandidateColumns,
  lockedImagesJson: string | null | undefined
): CandidateColumns {
  let locked: { hero?: unknown; logo?: unknown } = {};
  try {
    const parsed = lockedImagesJson ? (JSON.parse(lockedImagesJson) as unknown) : null;
    if (parsed && typeof parsed === "object") locked = parsed as typeof locked;
  } catch {
    locked = {};
  }
  const out: CandidateColumns = { ...columns };
  if (locked.hero === true) delete out.hero_image_url;
  if (locked.logo === true) delete out.logo_url;
  return out;
}

/** Catalog photos are positional (catalog[i] belongs to service i), so a
 *  candidate can be published only while the menu it was made for is
 *  unchanged: the same names in the same order. */
export function servicesUnchanged(candidateNames: string[], currentNames: string[]): boolean {
  if (candidateNames.length !== currentNames.length) return false;
  return candidateNames.every((name, i) => normalizeServiceName(name) === normalizeServiceName(currentNames[i] ?? ""));
}

/** The published row with the candidate's columns laid over it: what the
 *  public site will read after Publish. Used for the preview. */
export function overlayCandidate<T extends Record<string, unknown>>(row: T, columns: CandidateColumns): T {
  return { ...row, ...columns };
}
