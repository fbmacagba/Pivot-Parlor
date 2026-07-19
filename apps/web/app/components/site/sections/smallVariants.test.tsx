import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "../testCtx";

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

const ctx = makeTestCtx();

describe("trust chips", () => {
  it("keeps the stats-bar id and renders each signal as a chip", () => {
    const html = renderToStaticMarkup(<TrustChipsSection ctx={ctx} density="airy" />);
    expect(html).toContain('id="stats-bar"');
    expect(html).toContain("Walk-ins welcome");
    expect(html).toContain("5-star rated");
    expect(html).toContain("4.8 from 12 reviews");
  });
  it("falls back to booking-benefit chips without signals or proof", () => {
    const html = renderToStaticMarkup(
      <TrustChipsSection ctx={makeTestCtx({ trustSignals: [], hasSocialProof: false })} density="airy" />,
    );
    expect(html).toContain("Online booking");
    expect(html).toContain("Instant confirmation");
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
    const withMap = makeTestCtx({ settings: { address: "1 High St", phone: "020 1234 5678", lat: 51.5, lng: -0.1 } });
    const html = renderToStaticMarkup(<LocationMapFirstSection ctx={withMap} density="airy" />);
    expect(html).toContain("Find us");
    expect(html.indexOf("iframe")).toBeLessThan(html.indexOf("Monday"));
  });
  it("renders nothing without an address", () => {
    expect(
      renderToStaticMarkup(<LocationMapFirstSection ctx={makeTestCtx({ hasAddress: false })} density="airy" />),
    ).toBe("");
  });
});
