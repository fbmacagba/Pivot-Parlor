import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { seedComposeDesignSpec } from "@repo/utils";
import { makeTestCtx } from "~/components/site/testCtx";
import type { SiteData } from "~/components/commercialSiteTypes";

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

import { SignatureGallerySection } from "./SignatureGallerySection";
import { SignatureSpotlightSection } from "./SignatureSpotlightSection";
import CommercialTemplate from "~/components/CommercialTemplate";

const ctx = makeTestCtx();
const images = ["https://img.example/hero.jpg", "https://img.example/one.jpg", "https://img.example/two.jpg", "https://img.example/three.jpg"];

describe("signature gallery", () => {
  it("renders a look-book grid with tall accents from the shop's imagery", () => {
    const html = renderToStaticMarkup(<SignatureGallerySection ctx={ctx} images={images} density="airy" motif="line" />);
    expect(html).toContain("Inside Test Shop");
    expect(html).toContain("row-span-2");
    expect(html).toContain("one.jpg");
  });
  it("renders nothing with fewer than 3 images", () => {
    expect(
      renderToStaticMarkup(<SignatureGallerySection ctx={ctx} images={images.slice(0, 2)} density="airy" motif="none" />),
    ).toBe("");
  });
});

describe("signature spotlight", () => {
  it("stages the priciest photographed service with real stats and a booking CTA", () => {
    const html = renderToStaticMarkup(<SignatureSpotlightSection ctx={ctx} density="airy" motif="arc" animate={false} />);
    expect(html).toContain("Signature service");
    expect(html).toContain("Hot towel shave"); // priciest with an image
    expect(html).toContain("£35");
    expect(html).toContain("serviceId=s3");
    expect(html).toContain(">12<"); // SSR renders the final review count
  });
  it("hides social-proof stats without reviews and renders nothing without services", () => {
    const noProof = makeTestCtx({ hasSocialProof: false, reviewCount: 0 });
    const html = renderToStaticMarkup(<SignatureSpotlightSection ctx={noProof} density="airy" motif="none" animate={false} />);
    expect(html).not.toContain("Average rating");
    expect(
      renderToStaticMarkup(
        <SignatureSpotlightSection ctx={makeTestCtx({ services: [] })} density="airy" motif="none" animate={false} />,
      ),
    ).toBe("");
  });

  it("gives the booking CTA press feedback", () => {
    const html = renderToStaticMarkup(<SignatureSpotlightSection ctx={ctx} density="airy" motif="arc" animate={false} />);
    const start = html.indexOf('href="/test-shop/book?serviceId=s3"');
    expect(start).toBeGreaterThanOrEqual(0);
    const anchor = html.slice(start, html.indexOf(">", start));
    expect(anchor).toContain("bg-[color:var(--color-accent)]");
    expect(anchor).toContain("active:scale-[0.98]");
  });
});

describe("signature template placement", () => {
  const baseSite: SiteData = {
    shop_id: "some-id",
    shop_name: "Test Shop",
    tagline: "Walk out sharper",
  };
  const services = [
    { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30, image_url: "https://img.example/one.jpg" },
    { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20, image_url: "https://img.example/two.jpg" },
    { id: "s3", name: "Hot towel shave", price_gbp: 35, duration_minutes: 45, image_url: "https://img.example/three.jpg" },
  ];

  it("renders the signature before the final CTA", () => {
    const spec = {
      ...seedComposeDesignSpec("some-id"),
      signature: "spotlight" as const,
      motion: { intensity: "off" as const, reveal: "fade-up" as const },
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite, design_version: 3, design_spec: spec }} services={services} />,
    );
    expect(html).toContain("Signature service");
    expect(html.indexOf("Signature service")).toBeLessThan(html.indexOf("Ready for your best look?"));
  });

  it("renders no signature when signature is null", () => {
    const spec = {
      ...seedComposeDesignSpec("some-id"),
      signature: null,
      motion: { intensity: "off" as const, reveal: "fade-up" as const },
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite, design_version: 3, design_spec: spec }} services={services} />,
    );
    expect(html).not.toContain("Signature service");
  });
});
