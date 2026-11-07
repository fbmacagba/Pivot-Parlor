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

import { TrustChipsSection } from "./TrustChipsSection";
import { TeamStripSection } from "./TeamStripSection";
import { LocationMapFirstSection } from "./LocationMapFirstSection";
import { SignatureGallerySection } from "./SignatureGallerySection";

const ctx = makeTestCtx();

describe("signature gallery wall", () => {
  const tiles = (n: number) =>
    (
      renderToStaticMarkup(
        <SignatureGallerySection
          ctx={ctx}
          images={Array.from({ length: n }, (_, i) => `https://img.example/w${i}.jpg`)}
          density="airy"
          motif="none"
        />,
      ).match(/<img/g) ?? []
    ).length;
  it("only uses tile counts that fill its grid, so the wall never ends ragged", () => {
    expect(tiles(2)).toBe(0);
    expect(tiles(3)).toBe(3);
    expect(tiles(5)).toBe(3);
    expect(tiles(6)).toBe(6);
    expect(tiles(8)).toBe(6);
  });
});

describe("trust chips", () => {
  it("keeps the stats-bar id and renders each signal as a chip", () => {
    const html = renderToStaticMarkup(<TrustChipsSection ctx={ctx} density="airy" />);
    expect(html).toContain('id="stats-bar"');
    expect(html).toContain("Walk-ins welcome");
    expect(html).toContain("5-star rated");
    expect(html).toContain("4.8★ from 12 reviews");
  });
  it("falls back only to lines true of every shop, never to service promises", () => {
    const html = renderToStaticMarkup(
      <TrustChipsSection ctx={makeTestCtx({ trustSignals: [], hasSocialProof: false })} density="airy" />,
    );
    expect(html).toContain("Book online, any time");
    expect(html).toContain("No account needed to book");
    expect(html).not.toMatch(/Instant confirmation|Same-day|★/);
  });
});

describe("team strip", () => {
  it("renders a snap-scroll rail with a book link per member", () => {
    const html = renderToStaticMarkup(<TeamStripSection ctx={ctx} density="airy" />);
    expect(html).toContain("snap-x");
    expect(html).toContain("Book with Alex");
    expect(html).toContain("staffId=st1");
  });
  it("renders nothing without staff", () => {
    expect(renderToStaticMarkup(<TeamStripSection ctx={makeTestCtx({ staff: [] })} density="airy" />)).toBe("");
  });
});

describe("location map-first", () => {
  it("leads with the map and shows hours beneath", () => {
    const withMap = makeTestCtx({
      settings: { address: "1 High St", phone: "020 1234 5678", lat: 51.5, lng: -0.1, hours_json: '{"mon":"09:00-17:00"}' },
    });
    const html = renderToStaticMarkup(<LocationMapFirstSection ctx={withMap} density="airy" />);
    expect(html).toContain("Find us");
    expect(html.indexOf("iframe")).toBeLessThan(html.indexOf("Monday"));
  });
  it("renders nothing without an address, hours or phone", () => {
    expect(
      renderToStaticMarkup(
        <LocationMapFirstSection ctx={makeTestCtx({ hasAddress: false, hasVisitInfo: false, settings: {} })} density="airy" />,
      ),
    ).toBe("");
  });
  it("shows hours and phone without an address, and no map", () => {
    const html = renderToStaticMarkup(
      <LocationMapFirstSection
        ctx={makeTestCtx({
          hasAddress: false,
          hasVisitInfo: true,
          settings: { phone: "020 7946 0123", hours_json: '{"tue":"09:00-18:00"}' },
        })}
        density="airy"
      />,
    );
    expect(html).toContain("09:00 to 18:00");
    expect(html).toContain("020 7946 0123");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("Get directions");
  });
  it("labels a demo's contact details illustrative and never maps them", () => {
    const html = renderToStaticMarkup(
      <LocationMapFirstSection
        ctx={makeTestCtx({
          illustrativeContact: true,
          settings: { address: "Deptford High Street, London", phone: "020 7946 0123", lat: 51.5, lng: -0.1 },
        })}
        density="airy"
      />,
    );
    expect(html).toContain("Illustrative");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("google.com/maps");
  });
});
