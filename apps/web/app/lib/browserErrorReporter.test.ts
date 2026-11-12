import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ERRORS_PATH, MAX_REPORTS_PER_PAGE, type BrowserErrorPayload } from "./browserErrors";
import { installBrowserErrorReporter, reportBrowserError } from "./browserErrorReporter";

// The browser half of the browser-error alert (app/lib/browserErrors.ts):
// uncaught errors and unhandled rejections are caught here, hydration and
// render errors are handed in by entry.client.tsx and ErrorScreen.

const ORIGIN = "https://pp.test";

function ownError(message: string, name = "TypeError"): Error {
  const error = new Error(message);
  error.name = name;
  Object.defineProperty(error, "stack", {
    value: `${name}: ${message}\n    at onClick (https://pp.test/assets/contact-AbC123.js:1:2345)`,
    configurable: true,
  });
  return error;
}

function errorEvent(error: unknown): Event {
  const event = new Event("error");
  Object.defineProperty(event, "error", { value: error });
  return event;
}

function rejection(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", { value: reason });
  return event;
}

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.unstubAllGlobals();
});

/** null: Remix's router is not there yet. */
function install(route: string | null = "routes/contact") {
  const target = new EventTarget();
  const sent: BrowserErrorPayload[] = [];
  uninstall = installBrowserErrorReporter({ target, origin: ORIGIN, routeId: () => route ?? undefined, send: (p) => sent.push(p) });
  return { target, sent };
}

describe("installBrowserErrorReporter", () => {
  it("reports an uncaught error from our own code", () => {
    const { target, sent } = install();
    target.dispatchEvent(errorEvent(ownError("Cannot read properties of null (reading 'focus')")));
    expect(sent).toEqual([
      {
        kind: "script",
        route: "routes/contact",
        name: "TypeError",
        message: "Cannot read properties of null (reading 'focus')",
        frames: ["at onClick (/assets/contact-AbC123.js:1:2345)"],
      },
    ]);
  });

  it("reports an unhandled rejection as a promise error", () => {
    const { target, sent } = install();
    target.dispatchEvent(rejection(ownError("price missing")));
    expect(sent.map((p) => p.kind)).toEqual(["promise"]);
  });

  it("skips an error event with no error object (Script error., ResizeObserver)", () => {
    const { target, sent } = install();
    target.dispatchEvent(errorEvent(null));
    target.dispatchEvent(rejection(undefined));
    expect(sent).toEqual([]);
  });

  it("reports each distinct error once", () => {
    const { target, sent } = install();
    target.dispatchEvent(errorEvent(ownError("same")));
    target.dispatchEvent(errorEvent(ownError("same")));
    target.dispatchEvent(rejection(ownError("same")));
    expect(sent).toHaveLength(1);
  });

  it("reports at most a few errors per page load", () => {
    const { target, sent } = install();
    for (let i = 0; i < MAX_REPORTS_PER_PAGE + 3; i++) target.dispatchEvent(errorEvent(ownError(`bug ${i}`)));
    expect(sent).toHaveLength(MAX_REPORTS_PER_PAGE);
  });

  it("says unknown before the app knows its route", () => {
    const { target, sent } = install(null);
    target.dispatchEvent(errorEvent(ownError("early")));
    expect(sent[0]?.route).toBe("unknown");
  });

  it("never throws out of its listener, even when sending fails", () => {
    const target = new EventTarget();
    uninstall = installBrowserErrorReporter({
      target,
      origin: ORIGIN,
      routeId: () => "root",
      send: () => {
        throw new Error("send failed");
      },
    });
    expect(() => target.dispatchEvent(errorEvent(ownError("x")))).not.toThrow();
  });

  it("stops listening when uninstalled", () => {
    const { target, sent } = install();
    uninstall?.();
    target.dispatchEvent(errorEvent(ownError("after")));
    expect(sent).toEqual([]);
  });

  it("posts to our own website without cookies, surviving a page change", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const target = new EventTarget();
    uninstall = installBrowserErrorReporter({ target, origin: ORIGIN, routeId: () => "root" });
    target.dispatchEvent(errorEvent(ownError("posted")));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CLIENT_ERRORS_PATH);
    expect(init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: "script", route: "root", message: "posted" });
  });

  it("swallows a failed post", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const target = new EventTarget();
    uninstall = installBrowserErrorReporter({ target, origin: ORIGIN, routeId: () => "root" });
    expect(() => target.dispatchEvent(errorEvent(ownError("offline")))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("reportBrowserError", () => {
  it("reports a hydration or render error handed in by the app", () => {
    const { sent } = install("routes/$shopSlug.book");
    reportBrowserError(ownError("Hydration failed"), "hydration");
    reportBrowserError(ownError("render broke"), "render");
    expect(sent.map((p) => [p.kind, p.route])).toEqual([
      ["hydration", "routes/$shopSlug.book"],
      ["render", "routes/$shopSlug.book"],
    ]);
  });

  it("does nothing before the reporter is installed", () => {
    expect(() => reportBrowserError(ownError("too early"), "render")).not.toThrow();
  });

  it("shares the page's cap and dedupe with the listeners", () => {
    const { target, sent } = install();
    target.dispatchEvent(errorEvent(ownError("once")));
    reportBrowserError(ownError("once"), "render");
    expect(sent).toHaveLength(1);
  });
});
