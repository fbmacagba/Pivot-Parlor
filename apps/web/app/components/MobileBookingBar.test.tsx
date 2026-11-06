import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});

import { MobileBookingBar } from "./MobileBookingBar";

describe("MobileBookingBar", () => {
  it("links to the booking page and is hidden, untabbable and aria-hidden until visible", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible={false} />,
    );
    expect(html).toContain('href="/test-shop/book"');
    expect(html).toContain("Book now");
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("md:hidden");
  });

  it("is visible, tabbable and exposed once past the hero", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible />,
    );
    expect(html).toContain('data-visible="true"');
    // The bar and its link are exposed; only the decorative arrow is hidden.
    expect(html).toMatch(/^<div class="pp-bottom-bar md:hidden" data-visible="true">/);
    expect(html).not.toMatch(/<a [^>]*aria-hidden/);
    expect(html).toContain('<span aria-hidden="true">');
    expect(html).not.toContain("tabindex");
  });

  it("carries the shop's own booking label", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible bookLabel="Book your cut" />,
    );
    expect(html).toContain("Book your cut");
    expect(html).not.toContain("Book now");
  });

  it("offers the services anchor when booking is disabled", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled={false} visible />,
    );
    expect(html).toContain('href="/test-shop#services"');
    expect(html).toContain("View services");
    expect(html).not.toContain("Book now");
  });

  it("uses theme tokens and a 48px target with press feedback", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible />,
    );
    expect(html).toContain("min-h-12");
    expect(html).toContain("bg-[color:var(--color-accent)]");
    expect(html).toContain("text-[color:var(--st-on-accent)]");
    expect(html).toContain("active:scale-[0.98]");
  });
});
