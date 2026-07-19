/**
 * SYNCED COPY of the designSpec core from packages/utils/src/designSpec.ts
 * (this worker is standalone and cannot import @repo/utils — same pattern as
 * the curated-fonts copy). The block between the SYNC markers must stay
 * byte-identical; apps/web/app/lib/designSpecSync.test.ts enforces it.
 */

/** FNV-1a 32-bit — local copy (utils imports it from siteTheme). */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// SYNC-START designSpec
export type ComposerId = "ai" | "seed";
export type HeroVariant = "full-bleed" | "split" | "editorial" | "minimal";
export type HeroMotion = "parallax" | "fade" | "none";
export type DesignSectionKey =
  | "trust"
  | "services"
  | "about"
  | "team"
  | "how"
  | "reviews"
  | "location";
export type MotionIntensity = "calm" | "lively" | "off";
export type RevealStyle = "fade-up" | "scale" | "slide";
export type Motif = "line" | "dot-grid" | "arc" | "none";
export type SignatureId = "gallery" | "marquee-reviews" | "spotlight";
export type Density = "airy" | "compact";

export interface DesignSpecSection {
  key: DesignSectionKey;
  variant: string;
  include: boolean;
}

export interface DesignSpec {
  composer: ComposerId;
  hero: { variant: HeroVariant; motion: HeroMotion };
  /** Ordered; hero renders first and the final CTA last regardless. */
  sections: DesignSpecSection[];
  motion: { intensity: MotionIntensity; reveal: RevealStyle };
  motif: Motif;
  signature: SignatureId | null;
  density: Density;
}

export const HERO_VARIANTS: readonly HeroVariant[] = ["full-bleed", "split", "editorial", "minimal"];
export const HERO_MOTIONS: readonly HeroMotion[] = ["parallax", "fade", "none"];
export const DESIGN_SECTION_KEYS: readonly DesignSectionKey[] = [
  "trust",
  "services",
  "about",
  "team",
  "how",
  "reviews",
  "location",
];
export const SECTION_VARIANTS: Record<DesignSectionKey, readonly string[]> = {
  trust: ["icons", "chips"],
  services: ["grid", "rows", "showcase"],
  about: ["standard", "split-image", "story"],
  team: ["cards", "strip"],
  how: ["grid", "row"],
  reviews: ["cards", "marquee", "spotlight"],
  location: ["standard", "map-first"],
};
/** The six WS-6 archetype orders — the seed composer picks one whole order. */
export const SECTION_ORDERS: readonly (readonly DesignSectionKey[])[] = [
  ["trust", "services", "about", "team", "how", "reviews", "location"],
  ["trust", "services", "how", "about", "team", "reviews", "location"],
  ["trust", "services", "reviews", "about", "team", "how", "location"],
  ["trust", "about", "services", "team", "reviews", "how", "location"],
  ["trust", "about", "services", "team", "how", "reviews", "location"],
  ["trust", "services", "team", "about", "how", "reviews", "location"],
];
export const MOTION_INTENSITIES: readonly MotionIntensity[] = ["calm", "lively", "off"];
export const REVEAL_STYLES: readonly RevealStyle[] = ["fade-up", "scale", "slide"];
export const MOTIFS: readonly Motif[] = ["line", "dot-grid", "arc", "none"];
export const SIGNATURES: readonly SignatureId[] = ["gallery", "marquee-reviews", "spotlight"];
export const DENSITIES: readonly Density[] = ["airy", "compact"];

/** An owner-picked template (WS-6) constrains which hero families fit its mood. */
export const TEMPLATE_HERO_CONSTRAINTS: Record<string, readonly HeroVariant[]> = {
  minimal: ["minimal", "editorial"],
  luxury: ["full-bleed", "split"],
  vibrant: ["full-bleed", "split"],
  editorial: ["editorial", "split"],
  classic: ["full-bleed", "editorial"],
  fresh: ["split", "minimal"],
};

export function parseComposer(v: unknown): ComposerId | undefined {
  return v === "ai" || v === "seed" ? v : undefined;
}

/**
 * Deterministic composer: same shop id (and template) always yields the same
 * spec. Never picks intensity "off" or a null signature — muting is an AI or
 * owner decision, and seeded sites should move.
 */
export function seedComposeDesignSpec(
  shopId: string,
  opts: { template?: string } = {},
): DesignSpec {
  const pick = <T>(axis: string, pool: readonly T[]): T =>
    pool[fnv1a(`${shopId}:design:${axis}`) % pool.length]!;
  const template = opts.template?.trim().toLowerCase() ?? "";
  const heroPool = TEMPLATE_HERO_CONSTRAINTS[template] ?? HERO_VARIANTS;
  const order = pick("order", SECTION_ORDERS);
  return {
    composer: "seed",
    hero: { variant: pick("hero", heroPool), motion: pick("hero-motion", HERO_MOTIONS) },
    sections: order.map((key) => ({
      key,
      variant: pick(`section:${key}`, SECTION_VARIANTS[key]),
      include: true,
    })),
    motion: {
      intensity: pick("intensity", ["calm", "lively"] as const),
      reveal: pick("reveal", REVEAL_STYLES),
    },
    motif: pick("motif", MOTIFS),
    signature: pick("signature", SIGNATURES),
    density: pick("density", DENSITIES),
  };
}

/**
 * Repair a model-produced design_spec field by field: every invalid or
 * missing value takes the fallback's value and is recorded in `fellBack`.
 * Wholly invalid input returns the fallback verbatim with fellBack ["all"].
 * The result's composer is "ai" unless everything fell back. services and
 * location can never be excluded (a booking site needs both).
 */
export function normalizeDesignSpec(
  raw: unknown,
  fallback: DesignSpec,
): { spec: DesignSpec; fellBack: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { spec: structuredClone(fallback) as DesignSpec, fellBack: ["all"] };
  }
  const fellBack: string[] = [];
  const o = raw as Record<string, unknown>;

  const pickValid = <T>(field: string, value: unknown, pool: readonly T[], fb: T): T => {
    if (pool.includes(value as T)) return value as T;
    fellBack.push(field);
    return fb;
  };

  const heroRaw = (o.hero && typeof o.hero === "object" ? o.hero : {}) as Record<string, unknown>;
  const hero = {
    variant: pickValid("hero.variant", heroRaw.variant, HERO_VARIANTS, fallback.hero.variant),
    motion: pickValid("hero.motion", heroRaw.motion, HERO_MOTIONS, fallback.hero.motion),
  };

  const sections: DesignSpecSection[] = [];
  const seen = new Set<DesignSectionKey>();
  if (Array.isArray(o.sections)) {
    for (const entry of o.sections) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const key = DESIGN_SECTION_KEYS.includes(e.key as DesignSectionKey)
        ? (e.key as DesignSectionKey)
        : null;
      if (!key || seen.has(key)) {
        fellBack.push(`sections.${String(e.key ?? "?")}`);
        continue;
      }
      seen.add(key);
      const pool = SECTION_VARIANTS[key];
      let variant: string;
      if (typeof e.variant === "string" && pool.includes(e.variant)) {
        variant = e.variant;
      } else {
        fellBack.push(`sections.${key}.variant`);
        variant = fallback.sections.find((s) => s.key === key)?.variant ?? pool[0]!;
      }
      const include = key === "services" || key === "location" ? true : e.include !== false;
      sections.push({ key, variant, include });
    }
  } else {
    fellBack.push("sections");
  }
  for (const fb of fallback.sections) {
    if (!seen.has(fb.key)) {
      if (Array.isArray(o.sections)) fellBack.push(`sections.${fb.key}`);
      sections.push({ ...fb });
    }
  }

  const motionRaw = (o.motion && typeof o.motion === "object" ? o.motion : {}) as Record<
    string,
    unknown
  >;
  const motion = {
    intensity: pickValid(
      "motion.intensity",
      motionRaw.intensity,
      MOTION_INTENSITIES,
      fallback.motion.intensity,
    ),
    reveal: pickValid("motion.reveal", motionRaw.reveal, REVEAL_STYLES, fallback.motion.reveal),
  };

  const motif = pickValid("motif", o.motif, MOTIFS, fallback.motif);
  let signature: SignatureId | null;
  if (o.signature === null) {
    signature = null;
  } else if (SIGNATURES.includes(o.signature as SignatureId)) {
    signature = o.signature as SignatureId;
  } else {
    fellBack.push("signature");
    signature = fallback.signature;
  }
  const density = pickValid("density", o.density, DENSITIES, fallback.density);

  return {
    spec: { composer: "ai", hero, sections, motion, motif, signature, density },
    fellBack,
  };
}
// SYNC-END designSpec
