import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";
import { seedComposeDesignSpec } from "@repo/utils";
import type { SiteData } from "~/components/commercialSiteTypes";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});
vi.mock("~/components/CommercialShopChrome", async () => {
  const React = await import("react");
  return {
    CommercialShopChrome: ({ children }: { children: unknown }) =>
      React.createElement("div", null, children as never),
  };
});

import { HeroSplitSection } from "./HeroSplitSection";
import { HeroEditorialSection } from "./HeroEditorialSection";
import { HeroMinimalSection } from "./HeroMinimalSection";
import { HeroSection } from "./HeroSection";
import { FinalCtaSection } from "./FinalCtaSection";
import CommercialTemplate from "~/components/CommercialTemplate";

const ctx = makeTestCtx();

describe("hero variants", () => {
  it("split puts copy on the page surface beside the image", () => {
    const html = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="airy" motif="line" motionClass="" parallax={false} />,
    );
    expect(html).toContain("Test Shop");
    expect(html).toContain("hero.jpg");
    expect(html).not.toContain("from-black/85"); // no full-bleed scrim
    expect(html).toContain("--st-ink"); // ink tokens, not literal white
  });

  it("split falls back to a brand gradient without a hero image", () => {
    const html = renderToStaticMarkup(
      <HeroSplitSection ctx={makeTestCtx({ heroSrc: "" })} density="airy" motif="none" motionClass="" parallax={false} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("linear-gradient");
  });

  it("editorial renders the eyebrow and a wide image band below the type", () => {
    const html = renderToStaticMarkup(
      <HeroEditorialSection ctx={ctx} density="airy" motif="dot-grid" motionClass="" parallax={false} />,
    );
    expect(html).toContain("aspect-[21/9]");
    expect(html).toContain("uppercase");
    expect(html).toContain("Walk-ins welcome");
  });

  it("minimal never renders imagery", () => {
    const html = renderToStaticMarkup(
      <HeroMinimalSection ctx={ctx} density="airy" motif="arc" motionClass="st-hero-fade" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("st-hero-fade");
    expect(html).toContain("Test Shop");
  });

  it("density tightens vertical padding", () => {
    const airy = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="airy" motif="none" motionClass="" parallax={false} />,
    );
    const compact = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="compact" motif="none" motionClass="" parallax={false} />,
    );
    expect(airy).not.toBe(compact);
  });

  it("every hero variant carries the data-pp-hero marker on its root section", () => {
    const props = { ctx, density: "airy" as const, motif: "none" as const, motionClass: "" };
    const markups = [
      renderToStaticMarkup(<HeroSplitSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroEditorialSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroMinimalSection {...props} />),
    ];
    for (const markup of markups) {
      expect(markup.startsWith("<section")).toBe(true);
      expect(markup.slice(0, markup.indexOf(">"))).toContain("data-pp-hero");
    }
  });

  it("the legacy full-bleed hero carries the marker too", () => {
    const markup = renderToStaticMarkup(<HeroSection ctx={ctx} centered={false} minH="tall" />);
    expect(markup.slice(0, markup.indexOf(">"))).toContain("data-pp-hero");
  });

  it("primary booking CTAs give press feedback in every hero and the final CTA", () => {
    const props = { ctx, density: "airy" as const, motif: "none" as const, motionClass: "" };
    const pages = [
      renderToStaticMarkup(<HeroSection ctx={ctx} centered={false} minH="tall" />),
      renderToStaticMarkup(<HeroSplitSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroEditorialSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroMinimalSection {...props} />),
      renderToStaticMarkup(<FinalCtaSection ctx={ctx} glow={false} />),
    ];
    for (const html of pages) {
      // `to` precedes `className` in the JSX, so href comes first in the tag
      // and the class list follows it up to the closing ">".
      const start = html.indexOf('href="/test-shop/book"');
      expect(start).toBeGreaterThan(-1);
      const tag = html.slice(start, html.indexOf(">", start));
      expect(tag).toContain("active:scale-[0.98]");
    }
  });
});

describe("template hero dispatch gating", () => {
  const baseSite: SiteData = {
    shop_id: "hero-dispatch-shop",
    shop_name: "Dispatch Barbers",
    tagline: "Walk out sharper",
  };

  it("motion on: renders the split hero with fade animation, no full-bleed scrim", () => {
    const spec: DesignSpec = {
      ...seedComposeDesignSpec("hero-dispatch-shop"),
      hero: { variant: "split", motion: "fade" },
      motion: { intensity: "calm", reveal: "fade-up" },
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite, design_version: 3, design_spec: spec }} />,
    );
    expect(html).toContain("st-hero-fade");
    expect(html).not.toContain("from-black/85");
    expect(html).toContain("lg:grid-cols-2"); // split-unique: proves the split component actually rendered
  });

  it("motion off: the split hero renders with no fade class", () => {
    const spec: DesignSpec = {
      ...seedComposeDesignSpec("hero-dispatch-shop"),
      hero: { variant: "split", motion: "fade" },
      motion: { intensity: "off", reveal: "fade-up" },
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite, design_version: 3, design_spec: spec }} />,
    );
    expect(html).not.toContain("st-hero-fade");
    expect(html).toContain("lg:grid-cols-2"); // split-unique: proves the split component actually rendered
  });
});
