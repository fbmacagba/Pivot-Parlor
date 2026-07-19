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
