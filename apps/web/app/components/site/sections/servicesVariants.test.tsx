import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { ServicesRowsSection } from "./ServicesRowsSection";
import { ServicesShowcaseSection } from "./ServicesShowcaseSection";
import { ServicesSection } from "./ServicesSection";

const ctx = makeTestCtx();

describe("services rows", () => {
  it("renders the price list with leaders, prices and per-row booking", () => {
    const html = renderToStaticMarkup(<ServicesRowsSection ctx={ctx} density="airy" glow />);
    expect(html).toContain('id="services"');
    expect(html).toContain("border-dotted");
    expect(html).toContain("£25");
    expect(html).toContain("serviceId=s1");
  });
  it("shows skeleton rows when there are no services", () => {
    const html = renderToStaticMarkup(
      <ServicesRowsSection ctx={makeTestCtx({ services: [], filteredServices: [], categories: ["All"] })} density="airy" glow={false} />,
    );
    expect(html).toContain("animate-pulse");
  });
});

describe("services showcase", () => {
  it("alternates image direction and keeps the services id", () => {
    const html = renderToStaticMarkup(<ServicesShowcaseSection ctx={ctx} density="airy" glow />);
    expect(html).toContain('id="services"');
    expect(html).toContain("md:order-2");
    expect(html).toContain("Hot towel shave");
    expect(html).toContain("£35");
  });
  it("falls back to an accent band without an image", () => {
    const noImages = makeTestCtx();
    noImages.filteredServices = noImages.filteredServices.map((s) => ({ ...s, image_url: undefined }));
    const html = renderToStaticMarkup(<ServicesShowcaseSection ctx={noImages} density="airy" glow={false} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("bg-gradient-to-br");
  });
});

describe("per-service booking CTAs", () => {
  // The Link stub emits href before className, so each chunk runs from the href to the tag's closing ">".
  const bookThis = (html: string) =>
    html
      .split('href="/test-shop/book?serviceId=')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf(">")));
  it("give press feedback in the services grid and the showcase", () => {
    const grid = bookThis(renderToStaticMarkup(<ServicesSection ctx={ctx} cols={3} glow />));
    const showcase = bookThis(renderToStaticMarkup(<ServicesShowcaseSection ctx={ctx} density="airy" glow />));
    expect(grid.length).toBe(3);
    expect(showcase.length).toBe(3);
    for (const anchor of [...grid, ...showcase]) {
      expect(anchor).toContain("bg-[color:var(--color-accent)]");
      expect(anchor).toContain("active:scale-[0.98]");
    }
  });
});
