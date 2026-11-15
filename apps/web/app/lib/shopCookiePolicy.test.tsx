import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// A shop page's Google map is optional and loads only with the visitor's
// consent; the shop Cookie Policy must say so, and say how to change it.

const layout = vi.hoisted(() => ({
  data: { slug: "example-cuts", shop: { id: "shop-1", name: "Example Cuts" }, site: null, settings: {} } as unknown,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRouteLoaderData: () => layout.data,
}));
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import ShopCookiePolicy from "~/routes/$shopSlug.cookies";
import ShopPrivacyPolicy from "~/routes/$shopSlug.privacy";

function text(): string {
  const html = renderToStaticMarkup(<ShopCookiePolicy />);
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("shop Cookie Policy and the Google map", () => {
  it("names Google Maps as optional, consent-only cookies", () => {
    const body = text();
    expect(body).toContain("Google Maps");
    expect(body).toMatch(/only after you choose Allow map or Show map/);
  });

  it("explains how to give and withdraw that consent", () => {
    const body = text();
    expect(body).toContain("Essential only");
    expect(body).toContain("Manage cookie preferences");
  });

  it("no longer claims there is nothing optional to accept or reject", () => {
    const body = text();
    expect(body).not.toMatch(/there are no optional cookies/i);
    expect(body).not.toMatch(/as this site does not currently use any/i);
  });

  it("carries the new date", () => {
    expect(text()).toContain("Last updated: November 2026");
  });

  it("the shop privacy policy names Google as the map's provider", () => {
    const html = renderToStaticMarkup(<ShopPrivacyPolicy />);
    const body = new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(body).toMatch(/Google Maps receives your IP address/);
  });
});
