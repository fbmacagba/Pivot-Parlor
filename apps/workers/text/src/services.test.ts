import { describe, it, expect } from "vitest";
import { fallbackFromResearch, servicesFromSource } from "./index";

const source = [
  { name: "Skin fade", price_gbp: 24, duration_min: 40 },
  { name: "Beard sculpt & line-up", price_gbp: 15, duration_min: 20 },
  { name: "Kids' cut (under 12)", price_gbp: 16, duration_min: 30 },
];

const spec = { image_prompts: { catalog: ["fade prompt", "beard prompt"] } };

describe("servicesFromSource", () => {
  it("publishes exactly the source menu, in order, with source prices and durations", () => {
    const out = servicesFromSource(
      { services: source, spec },
      [
        // The model tries to rename, reprice and add services: all ignored.
        { name: "Kids cut under 12", price_gbp: 99, duration_minutes: 5, description: "Patient cuts for younger clients." },
        { name: "Skin fade", price_gbp: 1, description: "Taken down to the skin." },
        { name: "Executive package", price_gbp: 80, description: "Invented." },
      ],
    );
    expect(out.map((s) => [s.name, s.price_gbp, s.duration_minutes])).toEqual([
      ["Skin fade", 24, 40],
      ["Beard sculpt & line-up", 15, 20],
      ["Kids' cut (under 12)", 16, 30],
    ]);
    expect(out[0]!.description).toBe("Taken down to the skin.");
    expect(out[2]!.description).toBe("Patient cuts for younger clients.");
  });

  it("falls back to research copy, then to an empty description, never invented text", () => {
    const out = servicesFromSource(
      { services: source, spec, service_copy: { "beard sculpt and line up": "Clipper shape, razor finish." } },
      undefined,
    );
    expect(out.map((s) => s.description)).toEqual(["", "Clipper shape, razor finish.", ""]);
  });

  it("aligns catalog image prompts by position", () => {
    const out = servicesFromSource({ services: source, spec }, []);
    expect(out.map((s) => s.image_prompt)).toEqual(["fade prompt", "beard prompt", ""]);
  });

  it("allows an empty menu instead of padding with placeholder services", () => {
    expect(servicesFromSource({ services: [], spec }, [{ name: "Default service 1", description: "x" }])).toEqual([]);
  });
});

describe("fallbackFromResearch", () => {
  it("builds publishable copy from research alone, with the real menu", () => {
    const out = fallbackFromResearch({
      spec: { content: { headline: "Precise fades in Deptford" } },
      services: source,
      jobId: "j",
      shopId: "s",
      shopSlug: "ferdyms",
      shopName: "FerdyM's Barber Shop",
      shopType: "barber_shop",
      hasLogoFile: false,
      template: "classic",
    });
    expect(out.headline).toBe("Precise fades in Deptford");
    expect(out.seo_title).toBe("FerdyM's Barber Shop | Book online");
    expect(out.services).toHaveLength(3);
    expect(JSON.stringify(out)).not.toMatch(/Default service|—/);
  });
});
