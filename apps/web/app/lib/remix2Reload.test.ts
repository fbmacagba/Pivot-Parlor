// @vitest-environment node
/** A tab still running the Remix 2 client, after React Router 7 deploys.
 *
 *  Remix 2 asks for page data with `?_data=<route id>`. React Router 7 never
 *  sends `_data` and reads such a request as a document request, so an old
 *  tab's form post would run the action and get an HTML page back, which the
 *  old client shows as an error. On the till that records a sale and then
 *  invites a second one. The middleware answers those requests with Remix 2's
 *  own "reload this page" redirect instead, before anything runs. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { remix2ReloadResponse } from "./remix2Reload";

const PAGE_ROUTES: ReadonlySet<string> = new Set(["root", "routes/admin.pos", "routes/_marketing.pricing", "routes/logout"]);
const SITE = "https://pivotparlor.com";

function request(path: string, init: { method?: string; referer?: string; mode?: string } = {}): Request {
  const headers = new Headers();
  if (init.referer) headers.set("Referer", init.referer);
  if (init.mode) headers.set("Sec-Fetch-Mode", init.mode);
  return new Request(SITE + path, { method: init.method ?? "GET", headers, body: init.method === "POST" ? "" : undefined });
}

describe("remix2ReloadResponse", () => {
  it("an old tab's form post to a page action reloads the page it is on, and runs nothing", () => {
    const res = remix2ReloadResponse(
      request("/admin/pos?index&_data=routes%2Fadmin.pos", { method: "POST", referer: `${SITE}/admin/pos?shopId=s1`, mode: "cors" }),
      PAGE_ROUTES
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(204);
    expect(res?.headers.get("X-Remix-Redirect")).toBe("/admin/pos?shopId=s1");
    expect(res?.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(res?.headers.get("X-Remix-Replace")).toBe("true");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("an old tab's page data request (a link click) reloads too", () => {
    const res = remix2ReloadResponse(request("/pricing?_data=routes%2F_marketing.pricing", { referer: `${SITE}/` }), PAGE_ROUTES);
    expect(res?.status).toBe(204);
    expect(res?.headers.get("X-Remix-Redirect")).toBe("/");
  });

  it("the root route's data request counts as a page request", () => {
    expect(remix2ReloadResponse(request("/about?_data=root"), PAGE_ROUTES)?.status).toBe(204);
  });

  it("without a same-site Referer it reloads the requested page, without `_data`", () => {
    const res = remix2ReloadResponse(request("/pricing?plan=a&_data=routes%2F_marketing.pricing", { referer: "https://evil.example/x" }), PAGE_ROUTES);
    expect(res?.headers.get("X-Remix-Redirect")).toBe("/pricing?plan=a");
    const bare = remix2ReloadResponse(request("/pricing?_data=routes%2F_marketing.pricing"), PAGE_ROUTES);
    expect(bare?.headers.get("X-Remix-Redirect")).toBe("/pricing");
  });

  it("a resource route's request passes through: it ignores `_data` and answers JSON, as it always did", () => {
    expect(remix2ReloadResponse(request("/api/jobs/j1/status?_data=routes%2Fapi.jobs.%24jobId.status"), PAGE_ROUTES)).toBeNull();
  });

  it("requests without `_data`, or naming no route, pass through", () => {
    expect(remix2ReloadResponse(request("/pricing"), PAGE_ROUTES)).toBeNull();
    expect(remix2ReloadResponse(request("/pricing?_data=routes%2Fno-such-route"), PAGE_ROUTES)).toBeNull();
  });

  it("a document navigation that happens to carry `_data` passes through, so it never answers a page with nothing", () => {
    expect(remix2ReloadResponse(request("/pricing?_data=routes%2F_marketing.pricing", { mode: "navigate" }), PAGE_ROUTES)).toBeNull();
  });

  it("the middleware asks before the router runs", () => {
    const src = readFileSync(resolve(process.cwd(), "functions/_middleware.ts"), "utf8");
    const shim = src.indexOf("remix2ReloadResponse(context.request, PAGE_ROUTES)");
    expect(shim, "functions/_middleware.ts calls remix2ReloadResponse").toBeGreaterThan(-1);
    expect(shim).toBeLessThan(src.indexOf("handleRequest(context)"));
  });
});
