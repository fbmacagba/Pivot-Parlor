import { describe, it, expect } from "vitest";
import { seedComposeDesignSpec, type DesignSpec } from "@repo/utils";
import { composeRenderPlan } from "./composePlan";

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
