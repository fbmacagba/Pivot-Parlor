import { describe, expect, it } from "vitest";
import { CLIENT_ERRORS_PATH } from "./browserErrors";
import { handleClientErrors, MAX_BODY_BYTES, pageRouteIds, type BrowserErrorReport } from "./clientErrorsEndpoint";

// The website half of the browser-error alert (app/lib/browserErrors.ts):
// anyone can post here, so only a same-origin report from a real browser,
// about a real page and our own code, goes on to the API. The answer is
// always 204, so a sender learns nothing from it.

const ORIGIN = "https://pp.test";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// Measured 2026-11-12: Playwright's headless Chromium. isbot flags it, so the
// E2E presses the browser alert with a desktop Chrome user agent instead.
const HEADLESS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const PAGE_ROUTES = new Set(["root", "routes/contact", "routes/dev._index"]);

const payload = (over: Record<string, unknown> = {}) => ({
  kind: "script",
  route: "routes/contact",
  name: "TypeError",
  message: "Cannot read properties of null (reading 'focus')",
  frames: ["at onClick (/assets/contact-AbC123.js:1:2345)", "at x (<other>)"],
  ...over,
});

function post(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${CLIENT_ERRORS_PATH}`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "User-Agent": DESKTOP_UA,
      "CF-Connecting-IP": "203.0.113.9",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

async function run(request: Request, reportBrowser?: (r: BrowserErrorReport) => unknown) {
  const calls: BrowserErrorReport[] = [];
  const pending: Promise<unknown>[] = [];
  const res = await handleClientErrors(request, {
    pageRoutes: PAGE_ROUTES,
    binding: {
      reportBrowser: (r) => {
        calls.push(r);
        return reportBrowser ? reportBrowser(r) : { logged: true };
      },
    },
    waitUntil: (p) => pending.push(p),
  });
  await Promise.all(pending);
  return { res, calls };
}

describe("handleClientErrors", () => {
  it("passes a real browser's report on to the API, with the visitor's IP for the limit only", async () => {
    const { res, calls } = await run(post(payload()));
    expect(res.status).toBe(204);
    expect(calls).toEqual([
      {
        kind: "script",
        route: "routes/contact",
        name: "TypeError",
        message: "Cannot read properties of null (reading 'focus')",
        frames: ["at onClick (/assets/contact-AbC123.js:1:2345)", "at x (<other>)"],
        ip: "203.0.113.9",
      },
    ]);
  });

  it("masks the message again, in case the browser missed one", async () => {
    const { calls } = await run(post(payload({ message: "no booking for jane.doe@example.com" })));
    expect(calls[0]?.message).toBe("no booking for <email>");
  });

  it("accepts an error raised before the app knew its route", async () => {
    const { calls } = await run(post(payload({ route: "unknown" })));
    expect(calls[0]?.route).toBe("unknown");
  });

  it("drops a report that did not come from our own pages", async () => {
    const cases: Request[] = [
      post(payload(), { Origin: "" }),
      post(payload(), { Origin: "https://evil.test" }),
      post(payload(), { "Sec-Fetch-Site": "cross-site" }),
      post(payload(), { "Content-Type": "text/plain" }),
      new Request(`${ORIGIN}${CLIENT_ERRORS_PATH}`, { method: "GET", headers: { Origin: ORIGIN } }),
    ];
    for (const request of cases) {
      const { res, calls } = await run(request);
      expect(res.status).toBe(204);
      expect(calls).toEqual([]);
    }
  });

  it("drops reports from bots, the E2E's headless browser included", async () => {
    for (const ua of [HEADLESS_UA, GOOGLEBOT_UA]) {
      const { res, calls } = await run(post(payload(), { "User-Agent": ua }));
      expect(res.status).toBe(204);
      expect(calls, ua).toEqual([]);
    }
  });

  it("drops an oversized body, whether or not its length is declared", async () => {
    // Declared too big: dropped without reading (the body itself is a valid report).
    const declared = post(payload(), { "Content-Length": String(MAX_BODY_BYTES + 1) });
    expect(declared.headers.get("Content-Length")).toBe(String(MAX_BODY_BYTES + 1));
    expect((await run(declared)).calls).toEqual([]);
    // Too big when read.
    const big = JSON.stringify(payload({ message: "x".repeat(MAX_BODY_BYTES) }));
    expect((await run(post(big))).calls).toEqual([]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const undeclared = post(payload(), {}, { body: stream, duplex: "half" } as RequestInit);
    expect(undeclared.headers.get("Content-Length")).toBeNull();
    expect((await run(undeclared)).calls).toEqual([]);
  });

  it("drops anything that is not a report", async () => {
    for (const body of ["not json", "[]", "null", "7"]) {
      expect((await run(post(body))).calls, body).toEqual([]);
    }
    for (const over of [{ kind: "evil" }, { kind: undefined }, { frames: "not a list" }, { route: 7 }]) {
      expect((await run(post(payload(over)))).calls, JSON.stringify(over)).toEqual([]);
    }
  });

  it("drops a route that is not one of the site's pages (an API route, a made-up id)", async () => {
    for (const route of ["routes/api.dev.alert-test", "routes/evil", "routes/contact\nInjected", ""]) {
      expect((await run(post(payload({ route })))).calls, route).toEqual([]);
    }
  });

  it("drops a report whose frames are an extension's, or not our code at all", async () => {
    for (const frames of [
      ["at onClick (/assets/contact-AbC123.js:1:2345)", "at e (chrome-extension://abc/content.js:1:2)"],
      ["at x (<other>)", "at y (<other>)"],
      [],
    ]) {
      expect((await run(post(payload({ frames })))).calls, frames.join(" | ")).toEqual([]);
    }
  });

  it("keeps an unexpected error type as plain Error; the API decides what it shows", async () => {
    const { calls } = await run(post(payload({ name: "<img src=x>" })));
    expect(calls[0]?.name).toBe("Error");
  });

  it("answers 204 and never throws, whatever the API does", async () => {
    const rejected = await run(post(payload()), () => Promise.reject(new Error("API down")));
    expect(rejected.res.status).toBe(204);
    const thrown = await run(post(payload()), () => {
      throw new Error("binding broke");
    });
    expect(thrown.res.status).toBe(204);
    const none = await handleClientErrors(post(payload()), { pageRoutes: PAGE_ROUTES });
    expect(none.status).toBe(204);
  });
});

describe("pageRouteIds", () => {
  it("keeps only routes that render a page: a resource route has no component", () => {
    const Page = () => null;
    const ids = pageRouteIds({
      root: { module: { default: Page } },
      "routes/contact": { module: { default: Page } },
      "routes/api.dev.alert-test": { module: {} },
    });
    expect([...ids].sort()).toEqual(["root", "routes/contact"]);
  });
});
