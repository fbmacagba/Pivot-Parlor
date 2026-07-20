import { describe, it, expect } from "vitest";
import { googleMapsEmbedUrl, googleMapsUrl } from "@repo/utils";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { LocationSection } from "./LocationSection";
import { LocationMapFirstSection } from "./LocationMapFirstSection";

describe("googleMapsEmbedUrl", () => {
  it("builds the output=embed URL with the query encoded", () => {
    expect(googleMapsEmbedUrl("138 Moselle Avenue, N22 6ET, London")).toBe(
      "https://www.google.com/maps?q=138%20Moselle%20Avenue%2C%20N22%206ET%2C%20London&output=embed",
    );
  });
  it("pairs with googleMapsUrl for the matching directions link", () => {
    expect(googleMapsUrl("138 Moselle Avenue, N22 6ET, London")).toBe(
      "https://www.google.com/maps/search/?api=1&query=138%20Moselle%20Avenue%2C%20N22%206ET%2C%20London",
    );
  });
});

// renderToStaticMarkup escapes & as &amp; inside attributes.
const ADDRESS_EMBED = "https://www.google.com/maps?q=1%20High%20St%2C%20London&amp;output=embed";
const DIRECTIONS = "https://www.google.com/maps/search/?api=1&amp;query=1%20High%20St%2C%20London";
const COORDS_EMBED = "https://www.google.com/maps?q=51.5%2C-0.1&amp;z=15&amp;output=embed";

describe("LocationSection maps", () => {
  it("embeds the address when no coordinates are set and links directions", () => {
    const html = renderToStaticMarkup(<LocationSection ctx={makeTestCtx()} />);
    expect(html).toContain(ADDRESS_EMBED);
    expect(html).toContain(DIRECTIONS);
    expect(html).toContain("Get directions");
    expect(html).toContain('target="_blank"');
  });
  it("prefers coordinates when both are set", () => {
    const ctx = makeTestCtx({ settings: { address: "1 High St, London", lat: 51.5, lng: -0.1 } });
    const html = renderToStaticMarkup(<LocationSection ctx={ctx} />);
    expect(html).toContain(COORDS_EMBED);
    expect(html).not.toContain(ADDRESS_EMBED);
  });
  it("renders nothing without an address", () => {
    expect(renderToStaticMarkup(<LocationSection ctx={makeTestCtx({ hasAddress: false })} />)).toBe("");
  });
});

describe("LocationMapFirstSection maps", () => {
  it("embeds the address when no coordinates are set and links directions", () => {
    const html = renderToStaticMarkup(<LocationMapFirstSection ctx={makeTestCtx()} density="airy" />);
    expect(html).toContain(ADDRESS_EMBED);
    expect(html).toContain(DIRECTIONS);
    expect(html).toContain("Get directions");
  });
  it("prefers coordinates when both are set", () => {
    const ctx = makeTestCtx({ settings: { address: "1 High St, London", lat: 51.5, lng: -0.1 } });
    const html = renderToStaticMarkup(<LocationMapFirstSection ctx={ctx} density="airy" />);
    expect(html).toContain(COORDS_EMBED);
  });
});
