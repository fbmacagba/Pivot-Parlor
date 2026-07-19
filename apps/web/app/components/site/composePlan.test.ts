import { describe, it, expect } from "vitest";
import { seedComposeDesignSpec, type DesignSpec } from "@repo/utils";
import { composeRenderPlan } from "./composePlan";

describe("composeRenderPlan", () => {
  const spec: DesignSpec = seedComposeDesignSpec("plan-shop");

  it("maps hero variants to the fixed align/height pairs", () => {
    expect(composeRenderPlan({ ...spec, hero: { variant: "full-bleed", motion: "none" } }).hero)
      .toEqual({ centered: false, minH: "screen" });
    expect(composeRenderPlan({ ...spec, hero: { variant: "editorial", motion: "none" } }).hero)
      .toEqual({ centered: true, minH: "tall" });
  });

  it("preserves section order and drops excluded sections", () => {
    const s: DesignSpec = {
      ...spec,
      sections: spec.sections.map((x) =>
        x.key === "team" ? { ...x, include: false } : x,
      ),
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
});
