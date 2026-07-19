import { describe, it, expect } from "vitest";
import {
  DESIGN_SECTION_KEYS,
  SECTION_VARIANTS,
  TEMPLATE_HERO_CONSTRAINTS,
  seedComposeDesignSpec,
  normalizeDesignSpec,
  parseComposer,
  type DesignSpec,
} from "@repo/utils";

describe("seedComposeDesignSpec", () => {
  it("is deterministic for a shop id", () => {
    const a = seedComposeDesignSpec("shop-123");
    const b = seedComposeDesignSpec("shop-123");
    expect(a).toEqual(b);
  });

  it("differs across shop ids on at least one axis", () => {
    const a = seedComposeDesignSpec("shop-123");
    const b = seedComposeDesignSpec("shop-456");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits every section key exactly once with a valid variant", () => {
    const spec = seedComposeDesignSpec("any-shop");
    expect(spec.sections.map((s) => s.key).sort()).toEqual([...DESIGN_SECTION_KEYS].sort());
    for (const s of spec.sections) {
      expect(SECTION_VARIANTS[s.key]).toContain(s.variant);
      expect(s.include).toBe(true);
    }
  });

  it("marks itself as the seed composer and never picks off/null", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const spec = seedComposeDesignSpec(id);
      expect(spec.composer).toBe("seed");
      expect(spec.motion.intensity).not.toBe("off");
      expect(spec.signature).not.toBeNull();
    }
  });

  it("respects the owner template's hero constraint", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const spec = seedComposeDesignSpec(id, { template: "luxury" });
      expect(TEMPLATE_HERO_CONSTRAINTS.luxury).toContain(spec.hero.variant);
    }
  });

  // Golden pin: the composer's every axis is derived from fnv1a hashes of
  // strings like `${shopId}:design:${axis}`. An innocent refactor of those
  // hash-input strings (renaming an axis, reordering SECTION_ORDERS, etc.)
  // would silently re-theme every seed-composed site without any other test
  // noticing, since the other tests only check shape/validity, not the exact
  // mapping. This pins the full output for one fixed shop id.
  it("pins the exact composed spec for a fixed shop id (golden)", () => {
    const spec = seedComposeDesignSpec("golden-shop");
    expect(spec).toEqual({
      composer: "seed",
      hero: { variant: "split", motion: "fade" },
      sections: [
        { key: "trust", variant: "icons", include: true },
        { key: "services", variant: "showcase", include: true },
        { key: "team", variant: "strip", include: true },
        { key: "about", variant: "story", include: true },
        { key: "how", variant: "grid", include: true },
        { key: "reviews", variant: "marquee", include: true },
        { key: "location", variant: "map-first", include: true },
      ],
      motion: { intensity: "calm", reveal: "scale" },
      motif: "line",
      signature: "gallery",
      density: "compact",
    });
  });
});

describe("normalizeDesignSpec", () => {
  const fallback: DesignSpec = seedComposeDesignSpec("fallback-shop");

  it("falls back entirely on garbage input", () => {
    const { spec, fellBack } = normalizeDesignSpec("not an object", fallback);
    expect(fellBack).toEqual(["all"]);
    expect(spec).toEqual(fallback);
    expect(spec.composer).toBe("seed");
  });

  it("accepts a fully valid ai spec and marks composer ai", () => {
    const raw = {
      hero: { variant: "split", motion: "fade" },
      sections: [
        { key: "trust", variant: "chips", include: true },
        { key: "services", variant: "rows", include: true },
        { key: "about", variant: "story", include: true },
        { key: "team", variant: "strip", include: false },
        { key: "how", variant: "row", include: true },
        { key: "reviews", variant: "marquee", include: true },
        { key: "location", variant: "map-first", include: true },
      ],
      motion: { intensity: "calm", reveal: "slide" },
      motif: "arc",
      signature: "gallery",
      density: "airy",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(fellBack).toEqual([]);
    expect(spec.composer).toBe("ai");
    expect(spec.hero).toEqual({ variant: "split", motion: "fade" });
    expect(spec.sections.find((s) => s.key === "team")?.include).toBe(false);
    expect(spec.signature).toBe("gallery");
  });

  it("repairs invalid fields per-field and records them", () => {
    const raw = {
      hero: { variant: "hologram", motion: "fade" },
      sections: "nope",
      motion: { intensity: "lively", reveal: "spin" },
      motif: "line",
      signature: "before-after",
      density: "compact",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(spec.composer).toBe("ai");
    expect(spec.hero.variant).toBe(fallback.hero.variant);
    expect(spec.hero.motion).toBe("fade");
    expect(spec.sections).toEqual(fallback.sections);
    expect(spec.motion.reveal).toBe(fallback.motion.reveal);
    expect(spec.motion.intensity).toBe("lively");
    expect(spec.signature).toBe(fallback.signature);
    expect(fellBack).toContain("hero.variant");
    expect(fellBack).toContain("sections");
    expect(fellBack).toContain("motion.reveal");
    expect(fellBack).toContain("signature");
  });

  it("forces services and location to stay included and fills missing sections", () => {
    const raw = {
      hero: { variant: "minimal", motion: "none" },
      sections: [
        { key: "services", variant: "grid", include: false },
        { key: "location", variant: "standard", include: false },
        { key: "services", variant: "rows", include: true },
      ],
      motion: { intensity: "calm", reveal: "fade-up" },
      motif: "none",
      signature: null,
      density: "compact",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(spec.sections.map((s) => s.key).sort()).toEqual([...DESIGN_SECTION_KEYS].sort());
    expect(spec.sections.find((s) => s.key === "services")?.include).toBe(true);
    expect(spec.sections.find((s) => s.key === "location")?.include).toBe(true);
    expect(spec.signature).toBeNull();
    expect(fellBack.some((f) => f.startsWith("sections."))).toBe(true);
  });
});

describe("parseComposer", () => {
  it("accepts only ai and seed", () => {
    expect(parseComposer("ai")).toBe("ai");
    expect(parseComposer("seed")).toBe("seed");
    expect(parseComposer("AI")).toBeUndefined();
    expect(parseComposer("")).toBeUndefined();
    expect(parseComposer(undefined)).toBeUndefined();
  });
});
