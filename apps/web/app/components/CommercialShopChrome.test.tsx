/** CommercialShopChrome SSR contract for the native-feel surfaces. Rendering
 *  with renderToStaticMarkup runs no effects, which is exactly the no-JS /
 *  pre-hydration markup real visitors get first. */
import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { MessageCircle: Icon, X: Icon, Download: Icon };
});

import { CommercialShopChrome } from "./CommercialShopChrome";

const site = { shop_id: "shop-1", shop_name: "Test Shop", tagline: "", design_version: 3 };

function render(props: Partial<ComponentProps<typeof CommercialShopChrome>> = {}) {
  return renderToStaticMarkup(
    <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop" {...props}>
      <main>content</main>
    </CommercialShopChrome>,
  );
}

describe("CommercialShopChrome: mobile booking bar", () => {
  it("renders the bar hidden by default, plus the first-viewport sentinel", () => {
    const html = render();
    expect(html).toContain('class="pp-bottom-bar md:hidden"');
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('href="/test-shop/book"');
    expect(html).toContain("pp-bar-sentinel");
    expect(html).not.toContain("pp-bar-shown");
  });

  it("omits the bar entirely when bookingBar is false", () => {
    const html = render({ bookingBar: false });
    expect(html).not.toContain("pp-bottom-bar");
    expect(html).not.toContain("pp-bar-sentinel");
  });

  it("points the bar at services when booking is disabled", () => {
    const html = render({ settings: { booking_enabled: false } });
    expect(html).toContain("View services");
    expect(html).toContain('href="/test-shop#services"');
  });
});
