import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import PlatformCookiePolicy from "~/routes/_marketing.cookies";

// The platform Cookie Policy must name what a visitor's browser actually gets
// (measured on pivotparlor.com, 2026-11-16): Cloudflare's security cookie on
// the first page view, Turnstile on the contact form, every social sign-in
// the login page offers, and what the site keeps in browser storage.

function text(): string {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PlatformCookiePolicy />
    </MemoryRouter>,
  );
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("platform Cookie Policy", () => {
  it("names Cloudflare's security cookie and how long it lasts", () => {
    const body = text();
    expect(body).toContain("cf_clearance");
    expect(body).toMatch(/cf_clearance[^.]*Cloudflare/);
    expect(body).toMatch(/up to one year/);
  });

  it("names the Turnstile check on the contact form", () => {
    expect(text()).toMatch(/Cloudflare Turnstile[^.]*contact form/);
  });

  it("names every social sign-in the login page offers", () => {
    expect(text()).toMatch(/Social login providers \(Google, Facebook, LinkedIn\)/);
  });

  it("names what it keeps in browser storage", () => {
    const body = text();
    expect(body).toContain("pp_platform_consent");
    expect(body).toContain("pp-install-dismissed");
    expect(body).toContain("react-router-scroll-positions");
  });

  it("carries the new date", () => {
    expect(text()).toContain("Last updated: November 2026");
  });
});
