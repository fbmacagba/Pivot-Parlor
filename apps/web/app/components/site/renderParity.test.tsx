/** Renders the legacy (v2/archetype) path and the v3 composer path with a
 *  spec that mirrors the luxury-dark archetype, and asserts byte-identical
 *  HTML. This is the 2b-1 contract: the composer is new machinery, not a new
 *  look. @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";
import type { SiteData } from "~/components/commercialSiteTypes";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "parity-shop" }),
  };
});
vi.mock("~/components/CommercialShopChrome", async () => {
  const React = await import("react");
  return {
    CommercialShopChrome: ({ children }: { children: unknown }) =>
      React.createElement("div", null, children as never),
  };
});

import CommercialTemplate from "~/components/CommercialTemplate";

const baseSite: SiteData = {
  shop_id: "parity-shop-id",
  shop_name: "Parity Barbers",
  headline: "Sharp cuts",
  tagline: "Walk out sharper",
  about: "Three sentences about the shop.",
  layout_mood: "luxury-dark",
  design_version: 2,
  trust_signals: ["500+ clients", "Walk-ins welcome", "5-star rated"],
  usps: ["Master barbers", "Easy booking", "Great coffee"],
  hero_cta: "Book Your Cut",
  about_title: "Why us",
};

/** Mirrors luxury-dark exactly with motion OFF: same order, all included,
 *  legacy-matching variants, glow on (motif line), no signature. This is the
 *  2b-2 parity anchor: v3-with-motion-off === legacy, byte for byte. */
const mirrorSpec: DesignSpec = {
  composer: "ai",
  hero: { variant: "full-bleed", motion: "none" },
  sections: [
    { key: "trust", variant: "icons", include: true },
    { key: "services", variant: "grid", include: true },
    { key: "about", variant: "standard", include: true },
    { key: "team", variant: "cards", include: true },
    { key: "how", variant: "grid", include: true },
    { key: "reviews", variant: "cards", include: true },
    { key: "location", variant: "standard", include: true },
  ],
  motion: { intensity: "off", reveal: "fade-up" },
  motif: "line",
  signature: null,
  density: "airy",
};

describe("v3 composer parity", () => {
  const services = [
    { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30 },
    { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20 },
  ];

  it("renders byte-identical HTML to the legacy path for a mirroring spec", () => {
    const legacy = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite }} services={services} />,
    );
    const v3 = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: mirrorSpec }}
        services={services}
      />,
    );
    expect(v3).toBe(legacy);
  });

  it("honours exclusion and reordering for a non-mirroring spec", () => {
    const spec: DesignSpec = {
      ...mirrorSpec,
      sections: [
        { key: "trust", variant: "icons", include: true },
        { key: "services", variant: "grid", include: true },
        { key: "reviews", variant: "cards", include: true },
        { key: "about", variant: "standard", include: true },
        { key: "team", variant: "cards", include: false },
        { key: "how", variant: "grid", include: true },
        { key: "location", variant: "standard", include: true },
      ],
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: spec }}
        services={services}
        staff={[{ id: "st1", display_name: "Alex Doe" }]}
        reviews={[{ id: "r1", customer_name: "Sam", rating: 5, body: "Great cut.", created_at: "2026-01-05T10:00:00Z" }]}
      />,
    );
    expect(html).not.toContain("Meet the team");
    expect(html.indexOf("Great cut.")).toBeGreaterThan(-1);
    expect(html.indexOf("Great cut.")).toBeLessThan(html.indexOf("Why us"));
  });

  it("wraps sections in reveal wrappers when motion is on", () => {
    const calm: DesignSpec = { ...mirrorSpec, motion: { intensity: "calm", reveal: "fade-up" } };
    const html = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: calm }}
        services={services}
      />,
    );
    expect(html).toContain("st-motion-calm");
    expect(html).toContain('class="st-reveal-wrap st-reveal--fade-up"');
  });
});
