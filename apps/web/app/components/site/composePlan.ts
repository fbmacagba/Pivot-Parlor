import type {
  DesignSpec,
  DesignSectionKey,
  Density,
  HeroMotion,
  HeroVariant,
  Motif,
  RevealStyle,
  SignatureId,
} from "@repo/utils";

export interface HeroPlan {
  variant: HeroVariant;
  motion: HeroMotion;
  centered: boolean;
  minH: "screen" | "tall";
}

export interface SectionPlan {
  key: DesignSectionKey;
  variant: string;
}

export interface RevealPlan {
  style: RevealStyle;
  intensity: "calm" | "lively";
}

export interface RenderPlan {
  hero: HeroPlan;
  sections: SectionPlan[];
  signature: SignatureId | null;
  glow: boolean;
  motif: Motif;
  density: Density;
  /** null when motion.intensity is "off": no wrappers, no hero motion, static marquee. */
  reveal: RevealPlan | null;
}

const HERO_LAYOUTS: Record<HeroVariant, Pick<HeroPlan, "centered" | "minH">> = {
  "full-bleed": { centered: false, minH: "screen" },
  split: { centered: false, minH: "screen" },
  editorial: { centered: true, minH: "tall" },
  minimal: { centered: true, minH: "tall" },
};

/** Map a normalized DesignSpec to the render plan the v3 template consumes.
 *  Variant ids are trusted (normalizeDesignSpec already constrained them to
 *  the SECTION_VARIANTS pools); unknown ids fall back to each section's
 *  standard component at the dispatch site. */
export function composeRenderPlan(spec: DesignSpec): RenderPlan {
  const reveal: RevealPlan | null =
    spec.motion.intensity === "off"
      ? null
      : { style: spec.motion.reveal, intensity: spec.motion.intensity };
  return {
    hero: {
      variant: spec.hero.variant,
      motion: reveal ? spec.hero.motion : "none",
      ...HERO_LAYOUTS[spec.hero.variant],
    },
    sections: spec.sections
      .filter((s) => s.include)
      // The marquee-reviews signature IS the reviews block; rendering the
      // middle reviews section too would repeat the same six quotes.
      .filter((s) => !(spec.signature === "marquee-reviews" && s.key === "reviews"))
      .map((s) => ({ key: s.key, variant: s.variant })),
    signature: spec.signature,
    glow: spec.motif !== "none",
    motif: spec.motif,
    density: spec.density,
    reveal,
  };
}

/** Which of the shop's own photos exist. A few v3 variants are built around
 *  imagery and fall back to a plain gradient panel when there is none — on a
 *  photo-less shop that reads as blank squares, not a design. The two service
 *  signals differ because the variants consume images differently: "showcase"
 *  puts a photo in every card, while the single-photo variants need only one. */
export interface ImageAvailability {
  /** Every service carries a non-empty image_url (so "showcase" fills every
   *  card — one imageless service leaves a blank card). */
  everyServiceImaged: boolean;
  /** At least one service carries a non-empty image_url (enough for the
   *  single-photo variants: the spotlight signature and about "split-image"). */
  anyServiceImaged: boolean;
  /** A non-empty hero image is present. */
  hasHeroImage: boolean;
}

/** Post-process a render plan so no image-hungry variant renders a placeholder
 *  panel for a shop that lacks the photos it needs. Applied after
 *  composeRenderPlan at render time (it needs the shop's live media, which the
 *  pure spec does not carry). Each affected variant is downgraded exactly when
 *  it would go blank:
 *   - services "showcase" → "rows" (a price list) unless EVERY service is
 *     imaged, because showcase gives each card its own photo slot
 *   - "spotlight" signature (a single-photo stage) is dropped when no service
 *     is imaged
 *   - about "split-image" → "story" only when there is neither a service image
 *     nor a hero image, since split-image falls back to the hero photo
 *  Every other variant (grid's thin accent band, the self-guarding gallery
 *  signature, all hero variants) already degrades to an intentional look and
 *  is left alone. */
export function downgradeForImages(plan: RenderPlan, images: ImageAvailability): RenderPlan {
  const { everyServiceImaged, anyServiceImaged, hasHeroImage } = images;
  return {
    ...plan,
    sections: plan.sections.map((s) => {
      if (s.key === "services" && s.variant === "showcase" && !everyServiceImaged)
        return { ...s, variant: "rows" };
      if (s.key === "about" && s.variant === "split-image" && !anyServiceImaged && !hasHeroImage)
        return { ...s, variant: "story" };
      return s;
    }),
    signature: plan.signature === "spotlight" && !anyServiceImaged ? null : plan.signature,
  };
}
