/** Renders the legacy (v2/archetype) path and the v3 composer path with a
 *  spec that mirrors the luxury-dark archetype, and asserts byte-identical
 *  HTML. This is the 2b-1 contract: the composer is new machinery, not a new
 *  look. @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";

vi.mock("@remix-run/react", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("a", { href: String(to), ...rest }, children as never);
  },
  useParams: () => ({ shopSlug: "parity-shop" }),
}));
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: ({ children }: { children: unknown }) => {
    const React = require("react");
    return React.createElement("div", null, children as never);
  },
}));

import CommercialTemplate from "~/components/CommercialTemplate";

const baseSite = {
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

/** Mirrors luxury-dark exactly: same order, all included, glow on. */
const mirrorSpec: DesignSpec = {
  composer: "ai",
  hero: { variant: "full-bleed", motion: "none" },
  sections: (["trust", "services", "about", "team", "how", "reviews", "location"] as const).map(
    (key) => ({ key, variant: "any", include: true }),
  ),
  motion: { intensity: "calm", reveal: "fade-up" },
  motif: "line",
  signature: null,
  density: "airy",
};

describe("v3 composer parity", () => {
  it("renders byte-identical HTML to the legacy path for a mirroring spec", () => {
    const services = [
      { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30 },
      { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20 },
    ];
    const legacy = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite }} services={services} />,
    );
    const v3 = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: mirrorSpec } as never}
        services={services}
      />,
    );
    expect(v3).toBe(legacy);
  });
});
