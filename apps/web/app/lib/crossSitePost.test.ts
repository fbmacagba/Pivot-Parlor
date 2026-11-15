// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crossSitePostRefusal, isCrossSitePost } from "./crossSitePost";

const SITE = "https://pivotparlor.com";
const post = (pathname: string, origin?: string, method = "POST") =>
  new Request(SITE + pathname, { method, headers: origin === undefined ? {} : { Origin: origin } });

describe("isCrossSitePost", () => {
  it("is a post whose Origin names another site, is \"null\", or is not a URL", () => {
    expect(isCrossSitePost(post("/logout", "https://elsewhere.example"))).toBe(true);
    expect(isCrossSitePost(post("/logout", "null"))).toBe(true);
    expect(isCrossSitePost(post("/logout", "not a url"))).toBe(true);
    expect(isCrossSitePost(post("/logout", ""))).toBe(true);
    // Another scheme, port or subdomain is another origin, as React Router 7 counts it.
    expect(isCrossSitePost(post("/logout", "http://pivotparlor.com"))).toBe(true);
    expect(isCrossSitePost(post("/logout", "https://pivotparlor.com:8443"))).toBe(true);
    expect(isCrossSitePost(post("/logout", "https://api.pivotparlor.com"))).toBe(true);
  });

  it("covers every method that changes something", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isCrossSitePost(post("/api/me/profile", "https://elsewhere.example", method))).toBe(true);
    }
  });

  it("is not a same-site post, a post with no Origin, or a read", () => {
    expect(isCrossSitePost(post("/logout", SITE))).toBe(false);
    expect(isCrossSitePost(post("/logout.data", SITE))).toBe(false);
    expect(isCrossSitePost(post("/logout"))).toBe(false);
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossSitePost(new Request(`${SITE}/logout`, { method, headers: { Origin: "https://elsewhere.example" } }))).toBe(false);
    }
  });

  it("compares with the request's own origin, so a preview deployment is its own site", () => {
    const preview = "https://0ded1d68.pivot-parlor-web.pages.dev";
    const req = new Request(`${preview}/logout`, { method: "POST", headers: { Origin: preview } });
    expect(isCrossSitePost(req)).toBe(false);
  });
});

describe("crossSitePostRefusal", () => {
  it("is a plain 403 that no cache keeps", async () => {
    const res = crossSitePostRefusal();
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toMatch(/[–—]/);
  });
});

describe("wiring", () => {
  it("the Pages middleware refuses a cross-site post after the browser error reports and before the router", () => {
    const src = readFileSync(path.resolve(process.cwd(), "functions/_middleware.ts"), "utf8");
    const reports = src.indexOf("handleClientErrors(context.request");
    const refusal = src.search(/if \(isCrossSitePost\(context\.request\)\) return withSecurityHeaders\(crossSitePostRefusal\(\)\);/);
    const router = src.indexOf("handleRequest(context)");
    expect(reports).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(reports);
    expect(router).toBeGreaterThan(refusal);
  });
});
