/** Whole-page guarantees for a generated shop site: nothing the shop's
 *  records cannot back, and every complete-shop block when the data exists.
 *  @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";
import type { SiteData } from "~/components/commercialSiteTypes";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "complete-shop" }),
  };
});
vi.mock("~/components/CommercialShopChrome", async () => {
  const React = await import("react");
  return {
    CommercialShopChrome: ({ children }: { children: unknown }) => React.createElement("div", null, children as never),
  };
});

import CommercialTemplate from "~/components/CommercialTemplate";

const spec = (signature: DesignSpec["signature"]): DesignSpec => ({
  composer: "ai",
  hero: { variant: "split", motion: "none" },
  sections: [
    { key: "trust", variant: "chips", include: true },
    { key: "services", variant: "rows", include: true },
    { key: "about", variant: "story", include: true },
    { key: "team", variant: "cards", include: true },
    { key: "how", variant: "row", include: true },
    { key: "reviews", variant: "cards", include: true },
    { key: "location", variant: "standard", include: true },
  ],
  motion: { intensity: "off", reveal: "fade-up" },
  motif: "none",
  signature,
  density: "airy",
});

const site = (signature: DesignSpec["signature"]): SiteData => ({
  shop_id: "complete-shop-id",
  shop_name: "Linden & Lark",
  headline: "Colour, cut and calm",
  tagline: "A daylight studio in Clifton.",
  about: "Isla opened the studio for unhurried colour work.",
  design_version: 3,
  design_spec: spec(signature),
  trust_signals: ["Open Tuesday to Saturday", "Choose from 3 stylists"],
  hero_image_url: "https://img.example/hero.jpg",
  gallery_images: ["https://img.example/g1.jpg", "https://img.example/g2.jpg", "https://img.example/g3.jpg"],
});

const services = [
  { id: "s1", name: "Balayage", price_gbp: 165, duration_minutes: 180, category: "Colour", description: "Hand-painted colour." },
  { id: "s2", name: "Blow-dry", price_gbp: 34, duration_minutes: 45, category: "Styling" },
];
const staff = [{ id: "t1", display_name: "Isla Brennan", speciality: "Colour and balayage", avatar_url: "https://img.example/isla.jpg" }];

describe("a generated shop with no reviews", () => {
  const html = renderToStaticMarkup(
    <CommercialTemplate site={site("spotlight")} services={services} staff={staff} reviews={[]} settings={{ hours_json: '{"tue":"09:00-18:00"}' }} />,
  );

  it("shows no rating, review count or stock promise", () => {
    expect(html).not.toMatch(/★|happy clients|5\.0|Guaranteed|Instant confirmation|No card required|Cancel anytime|Same-day/);
  });

  it("states the shop's own facts", () => {
    expect(html).toContain("Open Tuesday to Saturday");
    expect(html).toContain("Choose from 3 stylists");
  });

  it("shows the team's portraits and specialities", () => {
    expect(html).toContain("https://img.example/isla.jpg");
    expect(html).toContain("Colour and balayage");
  });

  it("shows the generated gallery after the about section when it is not the signature", () => {
    expect(html).toContain("https://img.example/g1.jpg");
    expect(html.indexOf("unhurried colour work")).toBeLessThan(html.indexOf("https://img.example/g1.jpg"));
  });

  it("shows opening hours even without an address", () => {
    expect(html).toContain("Opening hours");
    expect(html).toContain("09:00 to 18:00");
  });
});

describe("a generated shop whose signature is the gallery", () => {
  it("renders the gallery photos once, as the signature, led by the space set", () => {
    const html = renderToStaticMarkup(<CommercialTemplate site={site("gallery")} services={services} staff={staff} reviews={[]} />);
    expect(html.split("https://img.example/g1.jpg").length - 1).toBe(1);
    expect(html.indexOf("https://img.example/g1.jpg")).toBeLessThan(html.indexOf("Book online in a few steps"));
  });

  it("does not repeat the hero or service photos inside the gallery", () => {
    const withPhotos = services.map((s, i) => ({ ...s, image_url: `https://img.example/svc-${i}.jpg` }));
    const html = renderToStaticMarkup(<CommercialTemplate site={site("gallery")} services={withPhotos} staff={staff} reviews={[]} />);
    const gallery = html.slice(html.indexOf("Inside Linden"));
    const galleryEnd = gallery.indexOf("</section>");
    const wall = gallery.slice(0, galleryEnd);
    expect(wall).toContain("https://img.example/g3.jpg");
    expect(wall).not.toContain("hero.jpg");
    expect(wall).not.toContain("svc-0.jpg");
  });
});

describe("the price list rows", () => {
  it("shows each description on its own line at every width, apart from the category", () => {
    const html = renderToStaticMarkup(<CommercialTemplate site={site(null)} services={services} staff={staff} reviews={[]} />);
    expect(html).toContain(">Hand-painted colour.</p>");
    expect(html).not.toContain("hidden md:inline");
    expect(html).not.toMatch(/Colour · Hand-painted/);
  });
});

describe("the final call to action", () => {
  it("carries a single subline", () => {
    const html = renderToStaticMarkup(<CommercialTemplate site={site(null)} services={services} staff={staff} reviews={[]} />);
    const cta = html.slice(html.lastIndexOf("<h2"));
    expect(cta.split("No account needed").length - 1).toBe(1);
  });
});

describe("a shop with real reviews", () => {
  it("shows the real average, never a default", () => {
    const reviews = [
      { id: "r1", customer_name: "Sam", rating: 4, body: "Lovely colour.", created_at: "2026-01-05T10:00:00Z" },
      { id: "r2", customer_name: "Ash", rating: 5, body: "Great cut.", created_at: "2026-01-04T10:00:00Z" },
    ];
    const html = renderToStaticMarkup(<CommercialTemplate site={site(null)} services={services} staff={staff} reviews={reviews} />);
    expect(html).toContain("4.5★");
    expect(html).not.toContain("5.0");
  });
});
