import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// Lighthouse found no <main> landmark on the public booking page, so a
// screen reader's "skip to main content" had nowhere to go. The page must
// have exactly one, with or without the shop's own site chrome around it.

const layout = vi.hoisted(() => ({ data: undefined as unknown }));

// The real module's server helpers (data, redirect) with the screen parts stubbed on top.
vi.mock("react-router", async (importOriginal) => {
  const React = await import("react");
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Form: ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
      React.createElement("form", rest, children as never),
    useRouteLoaderData: () => layout.data,
    useLoaderData: () => ({
      slug: "example-cuts",
      services: [],
      staff: [],
      slots: [],
      shopTimezone: "Europe/London",
      deposit: null,
      paymentCancelled: false,
      closedDay: false,
      today: "2026-11-16",
      preselectServiceId: "",
      preselectStaffId: "",
      preselectDay: "",
      preselectStep: 0,
    }),
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
    useFetcher: () => ({ data: undefined, load: () => {}, state: "idle" }),
    useSearchParams: () => [new URLSearchParams(), () => {}],
  };
});

// The chrome is tested on its own; here it only wraps the page, as on a live site.
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: ({ children }: { children?: ReactNode }) => (
    <div data-chrome="">
      <header>shop header</header>
      {children}
      <footer>shop footer</footer>
    </div>
  ),
}));

import BookingRoute from "~/routes/$shopSlug.book";

function mains(html: string): number {
  return new DOMParser().parseFromString(html, "text/html").querySelectorAll("main").length;
}

afterEach(() => {
  layout.data = undefined;
});

describe("booking page landmarks", () => {
  it("has one <main> inside the shop's site chrome", () => {
    layout.data = {
      slug: "example-cuts",
      shop: { id: "shop-1", name: "Example Cuts" },
      site: { template: "classic", headline: "", tagline: "", about: "", services: [] },
      settings: {},
      commercialServices: [],
      staff: [],
    };
    const html = renderToStaticMarkup(<BookingRoute />);
    expect(html).toContain("data-chrome");
    expect(mains(html)).toBe(1);
  });

  it("has one <main> without a site (the platform fallback)", () => {
    const html = renderToStaticMarkup(<BookingRoute />);
    expect(html).not.toContain("data-chrome");
    expect(mains(html)).toBe(1);
  });
});
