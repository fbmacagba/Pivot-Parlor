/** End-to-end: a v3 spec that selects the image-hungry variants (services
 *  "showcase" + "spotlight" signature + about "split-image") must not render
 *  blank gradient panels on a shop that lacks the photos, and must keep them
 *  when the photos exist. Renders the full template through the real dispatch
 *  and Reveal path. @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";
import type { SiteData } from "~/components/commercialSiteTypes";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "img-shop" }),
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

// Motion "calm" so sections render through the Reveal wrappers, exercising the
// same dispatch/index path a live v3 shop uses.
const spec: DesignSpec = {
  composer: "ai",
  hero: { variant: "full-bleed", motion: "fade" },
  sections: [
    { key: "trust", variant: "icons", include: true },
    { key: "services", variant: "showcase", include: true },
    { key: "about", variant: "split-image", include: true },
    { key: "team", variant: "cards", include: true },
    { key: "how", variant: "row", include: true },
    { key: "reviews", variant: "spotlight", include: true },
    { key: "location", variant: "standard", include: true },
  ],
  motion: { intensity: "calm", reveal: "fade-up" },
  motif: "line",
  signature: "spotlight",
  density: "airy",
};

const base: SiteData = {
  shop_id: "img-shop-id",
  shop_name: "Image Shop",
  headline: "Sharp cuts",
  tagline: "Walk out sharper",
  design_version: 3,
  design_spec: spec,
};

// Markers proven unique to a single component:
//   PLACEHOLDER — the gradient panel used only by showcase / spotlight /
//                 split-image / grid image fallbacks (none render post-downgrade here)
//   ROWS        — the price-list dotted leader, only in ServicesRowsSection
//   SPOTLIGHT   — the spotlight-signature heading, only in SignatureSpotlightSection
const PLACEHOLDER = "from-[color:var(--st-accent-25)]";
const ROWS = "border-dotted";
const SPOTLIGHT = "Signature service";

const svc = (id: string, image_url?: string) => ({
  id,
  name: `Service ${id}`,
  price_gbp: 25,
  duration_minutes: 30,
  ...(image_url ? { image_url } : {}),
});

function render(site: Partial<SiteData>, services: ReturnType<typeof svc>[]) {
  return renderToStaticMarkup(<CommercialTemplate site={{ ...base, ...site }} services={services} />);
}

describe("image-aware v3 variants (end-to-end)", () => {
  it("no service images and no hero: showcase→rows, spotlight dropped, no blank panel", () => {
    const html = render({ hero_image_url: "" }, [svc("a"), svc("b"), svc("c")]);
    expect(html).toContain(ROWS); // services rendered as the price list
    expect(html).not.toContain(SPOTLIGHT); // spotlight signature dropped
    expect(html).not.toContain(PLACEHOLDER); // no gradient placeholder anywhere
    expect(html).toContain('id="services"'); // still bookable
    expect(html).toContain("/img-shop/book");
  });

  it("partial coverage still downgrades showcase but keeps the single-photo spotlight", () => {
    // One of three services has a photo: showcase would blank two cards, so it
    // downgrades to rows; the spotlight signature can feature the one photo.
    const html = render({ hero_image_url: "" }, [
      svc("a", "https://img.example/a.jpg"),
      svc("b"),
      svc("c"),
    ]);
    expect(html).toContain(ROWS); // showcase downgraded despite one image
    expect(html).toContain(SPOTLIGHT); // spotlight kept (one photo is enough)
  });

  it("every service imaged: showcase and spotlight are kept", () => {
    const html = render({ hero_image_url: "https://img.example/hero.jpg" }, [
      svc("a", "https://img.example/a.jpg"),
      svc("b", "https://img.example/b.jpg"),
      svc("c", "https://img.example/c.jpg"),
    ]);
    expect(html).not.toContain(ROWS); // stayed showcase, not rows
    expect(html).toContain(SPOTLIGHT); // spotlight kept
  });
});
