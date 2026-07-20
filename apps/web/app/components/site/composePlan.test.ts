import { describe, it, expect } from "vitest";
import { seedComposeDesignSpec, type DesignSpec } from "@repo/utils";
import { composeRenderPlan, downgradeForImages, type RenderPlan } from "./composePlan";

describe("composeRenderPlan", () => {
  const spec: DesignSpec = seedComposeDesignSpec("plan-shop");

  it("maps hero variants to the fixed align/height pairs", () => {
    const h = (variant: DesignSpec["hero"]["variant"]) =>
      composeRenderPlan({ ...spec, hero: { variant, motion: "none" } }).hero;
    expect(h("full-bleed")).toMatchObject({ centered: false, minH: "screen" });
    expect(h("split")).toMatchObject({ centered: false, minH: "screen" });
    expect(h("editorial")).toMatchObject({ centered: true, minH: "tall" });
    expect(h("minimal")).toMatchObject({ centered: true, minH: "tall" });
  });

  it("preserves section order and drops excluded sections", () => {
    const s: DesignSpec = {
      ...spec,
      signature: "gallery",
      sections: spec.sections.map((x) => (x.key === "team" ? { ...x, include: false } : x)),
    };
    const plan = composeRenderPlan(s);
    expect(plan.sections.map((p) => p.key)).toEqual(
      s.sections.filter((x) => x.include).map((x) => x.key),
    );
    expect(plan.sections.some((p) => p.key === "team")).toBe(false);
  });

  it("glow follows the motif", () => {
    expect(composeRenderPlan({ ...spec, motif: "none" }).glow).toBe(false);
    expect(composeRenderPlan({ ...spec, motif: "arc" }).glow).toBe(true);
  });

  it("motion off yields a null reveal and forces hero motion to none", () => {
    const off = composeRenderPlan({
      ...spec,
      hero: { variant: "split", motion: "parallax" },
      motion: { intensity: "off", reveal: "scale" },
    });
    expect(off.reveal).toBeNull();
    expect(off.hero.motion).toBe("none");
    const calm = composeRenderPlan({
      ...spec,
      hero: { variant: "split", motion: "parallax" },
      motion: { intensity: "calm", reveal: "scale" },
    });
    expect(calm.reveal).toEqual({ style: "scale", intensity: "calm" });
    expect(calm.hero.motion).toBe("parallax");
  });

  it("passes signature, motif and density through", () => {
    const p = composeRenderPlan({ ...spec, signature: "spotlight", motif: "arc", density: "compact" });
    expect(p.signature).toBe("spotlight");
    expect(p.motif).toBe("arc");
    expect(p.density).toBe("compact");
  });

  it("drops the middle reviews section when the signature is marquee-reviews", () => {
    const p = composeRenderPlan({ ...spec, signature: "marquee-reviews" });
    expect(p.sections.some((s) => s.key === "reviews")).toBe(false);
    const q = composeRenderPlan({ ...spec, signature: "gallery" });
    expect(q.sections.some((s) => s.key === "reviews")).toBe(true);
  });
});

describe("downgradeForImages", () => {
  const base = composeRenderPlan(seedComposeDesignSpec("dg-shop"));
  // A plan that exercises every image-hungry variant at once.
  const imageHungry: RenderPlan = {
    ...base,
    sections: [
      { key: "services", variant: "showcase" },
      { key: "about", variant: "split-image" },
      { key: "team", variant: "cards" },
    ],
    signature: "spotlight",
  };
  const svar = (p: RenderPlan, key: string) => p.sections.find((s) => s.key === key)?.variant;

  it("leaves the plan untouched when every service is imaged", () => {
    const out = downgradeForImages(imageHungry, {
      everyServiceImaged: true,
      anyServiceImaged: true,
      hasHeroImage: false,
    });
    expect(out).toEqual(imageHungry);
  });

  it("downgrades showcase to rows unless EVERY service is imaged (partial coverage still blanks cards)", () => {
    const partial = downgradeForImages(imageHungry, {
      everyServiceImaged: false,
      anyServiceImaged: true,
      hasHeroImage: false,
    });
    expect(svar(partial, "services")).toBe("rows");
    // one service image is enough for the single-photo variants — not downgraded
    expect(partial.signature).toBe("spotlight");
    expect(svar(partial, "about")).toBe("split-image");
  });

  it("drops the spotlight signature only when no service is imaged", () => {
    const anyImaged = downgradeForImages(imageHungry, {
      everyServiceImaged: false,
      anyServiceImaged: true,
      hasHeroImage: false,
    });
    expect(anyImaged.signature).toBe("spotlight");
    const noneImaged = downgradeForImages(imageHungry, {
      everyServiceImaged: false,
      anyServiceImaged: false,
      hasHeroImage: true,
    });
    expect(noneImaged.signature).toBeNull();
  });

  it("downgrades split-image to story only when there is neither a service image nor a hero image", () => {
    const withHero = downgradeForImages(imageHungry, {
      everyServiceImaged: false,
      anyServiceImaged: false,
      hasHeroImage: true,
    });
    expect(svar(withHero, "about")).toBe("split-image");
    const nothing = downgradeForImages(imageHungry, {
      everyServiceImaged: false,
      anyServiceImaged: false,
      hasHeroImage: false,
    });
    expect(svar(nothing, "about")).toBe("story");
  });

  it("leaves non-image-hungry variants alone", () => {
    const safe: RenderPlan = {
      ...base,
      sections: [
        { key: "services", variant: "grid" },
        { key: "about", variant: "story" },
      ],
      signature: "gallery",
    };
    const out = downgradeForImages(safe, {
      everyServiceImaged: false,
      anyServiceImaged: false,
      hasHeroImage: false,
    });
    expect(out).toEqual(safe);
  });
});
