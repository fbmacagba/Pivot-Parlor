import type { DesignSpec, DesignSectionKey } from "@repo/utils";

export interface HeroPlan {
  centered: boolean;
  minH: "screen" | "tall";
}

export interface SectionPlan {
  key: DesignSectionKey;
  variant: string;
}

export interface RenderPlan {
  hero: HeroPlan;
  sections: SectionPlan[];
  glow: boolean;
}

/**
 * Map a normalized DesignSpec to layout options. 2b-1: every variant renders
 * the single existing component; hero variants map to static align/height
 * pairs; glow follows motif !== "none" (matches the archetype default feel).
 * 2b-2 swaps variant ids to real alternate components.
 */
export function composeRenderPlan(spec: DesignSpec): RenderPlan {
  const heroVariantMap: Record<string, HeroPlan> = {
    "full-bleed": { centered: false, minH: "screen" },
    split: { centered: false, minH: "screen" },
    editorial: { centered: true, minH: "tall" },
    minimal: { centered: true, minH: "tall" },
  };

  return {
    hero: heroVariantMap[spec.hero.variant] || { centered: false, minH: "screen" },
    sections: spec.sections
      .filter((s) => s.include)
      .map((s) => ({ key: s.key, variant: s.variant })),
    glow: spec.motif !== "none",
  };
}
