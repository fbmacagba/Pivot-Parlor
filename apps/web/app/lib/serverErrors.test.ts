import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dataRequestPath,
  describeServerError,
  handleError,
  reportServerError,
  routePattern,
  whereOf,
  type WebErrorReport,
} from "./serverErrors";

// Pages Functions have no Workers Issues, so the website hands each server
// error to the API's WebErrors entrypoint (apps/worker/src/web-errors.ts) over
// the WEB_ERRORS binding, and the API's log line emails the owner.

const req = (url: string, init?: RequestInit) => new Request(url, init);

function errorWithStack(message: string, name = "TypeError"): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = [
    `${name}: ${message}`,
    "    at loader (file:///C:/build/server/index.js:1200:15)",
    "    at callRouteLoader (https://pivotparlor.com/build/server/assets/chunk-ABC.js:88:9)",
    "    at async Promise.all (index 0)",
    "    at f4 (/srv/app/index.js:1:1)",
    "    at f5 (/srv/app/index.js:2:2)",
    "    at f6 (/srv/app/index.js:3:3)",
    "    at f7 (/srv/app/index.js:4:4)",
  ].join("\n");
  return e;
}

function fakeBinding() {
  const reports: WebErrorReport[] = [];
  return { reports, binding: { report: vi.fn(async (r: WebErrorReport) => void reports.push(r)) } };
}

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe("routePattern", () => {
  it("replaces each route parameter's value with its name", () => {
    expect(routePattern("/book/ferdym", { shopSlug: "ferdym" })).toBe("/book/:shopSlug");
    expect(routePattern("/dev/shops/abc-123/preview", { shopId: "abc-123" })).toBe("/dev/shops/:shopId/preview");
    expect(routePattern("/s/caf%C3%A9", { shopSlug: "café" })).toBe("/s/:shopSlug");
    expect(routePattern("/invite/tok123/accept", { token: "tok123" })).toBe("/invite/:token/accept");
  });

  it("collapses a splat to *", () => {
    expect(routePattern("/docs/a/b", { "*": "a/b" })).toBe("/docs/*");
  });

  it("hides id-like segments when there are no parameters (the middleware)", () => {
    expect(routePattern("/x/123456/3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c/edit")).toBe("/x/:id/:id/edit");
    expect(routePattern("/login")).toBe("/login");
  });
});

describe("whereOf", () => {
  it("tells a page load, a data request and a form post apart", () => {
    expect(whereOf(req("https://pivotparlor.com/book/x"))).toBe("page");
    expect(whereOf(req("https://pivotparlor.com/book/x?_data=routes%2F%24shopSlug.book"))).toBe("data");
    expect(whereOf(req("https://pivotparlor.com/book/x", { method: "POST" }))).toBe("action");
  });

  it("tells React Router 7's data requests (/path.data) apart too", () => {
    expect(whereOf(req("https://pivotparlor.com/book/x.data?_routes=routes%2F%24shopSlug.book"))).toBe("data");
    expect(whereOf(req("https://pivotparlor.com/_root.data"))).toBe("data");
    expect(whereOf(req("https://pivotparlor.com/book/x.data", { method: "POST" }))).toBe("action");
    expect(whereOf(req("https://pivotparlor.com/a.data/b"))).toBe("page");
  });
});

describe("dataRequestPath", () => {
  it("is the page a data request belongs to", () => {
    expect(dataRequestPath("/_root.data")).toBe("/");
    expect(dataRequestPath("/book/x.data")).toBe("/book/x");
    expect(dataRequestPath("/book/x")).toBe("/book/x");
  });
});

describe("describeServerError", () => {
  it("keeps the type, a masked message, the route pattern and the top stack lines without paths", () => {
    const d = describeServerError(
      errorWithStack("No booking for jane@example.com"),
      req("https://pivotparlor.com/book/ferdym?ref=secret"),
      { shopSlug: "ferdym" },
    );
    expect(d).toEqual({
      where: "page",
      method: "GET",
      route: "/book/:shopSlug",
      name: "TypeError",
      message: "No booking for <email>",
      frames: [
        "at loader (index.js:1200:15)",
        "at callRouteLoader (chunk-ABC.js:88:9)",
        "at async Promise.all (index 0)",
        "at f4 (index.js:1:1)",
        "at f5 (index.js:2:2)",
      ],
    });
    expect(JSON.stringify(d)).not.toMatch(/ferdym|secret|jane/);
  });

  it("describes something thrown that is not an Error", () => {
    const d = describeServerError("plain string", req("https://pivotparlor.com/x", { method: "POST" }));
    expect(d).toMatchObject({ name: "NonError", message: "plain string", where: "action", frames: [] });
  });
});

describe("reportServerError", () => {
  it("sends one report over the binding, after the response, and still logs it locally", async () => {
    const { reports, binding } = fakeBinding();
    const waits: Promise<unknown>[] = [];
    const err = errorWithStack("boom");
    reportServerError(err, {
      request: req("https://pivotparlor.com/book/ferdym"),
      params: { shopSlug: "ferdym" },
      env: { WEB_ERRORS: binding },
      waitUntil: (p) => void waits.push(p),
    });
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(reports).toEqual([expect.objectContaining({ name: "TypeError", route: "/book/:shopSlug", message: "boom" })]);
    expect(logged).toHaveBeenCalledWith(err);
  });

  it("a failing .data request reports the route pattern, never the value or the suffix", async () => {
    const { reports, binding } = fakeBinding();
    const waits: Promise<unknown>[] = [];
    reportServerError(errorWithStack("from a data request"), {
      request: req("https://pivotparlor.com/book/ferdym.data?_routes=routes%2F%24shopSlug.book"),
      params: { shopSlug: "ferdym" },
      env: { WEB_ERRORS: binding },
      waitUntil: (p) => void waits.push(p),
    });
    await Promise.all(waits);
    expect(reports).toEqual([expect.objectContaining({ where: "data", route: "/book/:shopSlug" })]);
    expect(JSON.stringify(reports)).not.toMatch(/ferdym|\.data/);
  });

  it("reports the same error once, even if two hooks see it", async () => {
    const { reports, binding } = fakeBinding();
    const err = errorWithStack("twice");
    const opts = { request: req("https://pivotparlor.com/a"), env: { WEB_ERRORS: binding } };
    reportServerError(err, opts);
    reportServerError(err, { ...opts, where: "render" as const });
    await Promise.resolve();
    expect(binding.report).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
  });

  it("skips a visitor who left, a thrown Response and a not-found", () => {
    const { binding } = fakeBinding();
    const gone = new AbortController();
    gone.abort();
    reportServerError(errorWithStack("aborted"), { request: req("https://pivotparlor.com/a", { signal: gone.signal }), env: { WEB_ERRORS: binding } });
    reportServerError(new Response("nope", { status: 404 }), { request: req("https://pivotparlor.com/a"), env: { WEB_ERRORS: binding } });
    // What React Router throws for an unmatched route.
    const notFound = { status: 404, statusText: "Not Found", internal: true, data: "No route matches URL" };
    reportServerError(notFound, { request: req("https://pivotparlor.com/a"), env: { WEB_ERRORS: binding } });
    expect(binding.report).not.toHaveBeenCalled();
  });

  describe("React Router 7's refusal of a post from another site", () => {
    const DOCUMENT_REFUSAL =
      "The `request.url` origin does not match `origin` header from a forwarded action request. Aborting the action.";
    const BAD_ORIGIN_REFUSAL = "`origin` header is not a valid URL. Aborting the action.";
    const DATA_REFUSAL = "Bad Request";
    const post = (url: string, origin?: string, method = "POST") =>
      req(url, { method, headers: origin === undefined ? {} : { Origin: origin } });

    it("is not reported: the post names another site, \"null\" or no valid URL", () => {
      const { binding } = fakeBinding();
      const cases: [string, Request][] = [
        [DOCUMENT_REFUSAL, post("https://pivotparlor.com/login", "https://elsewhere.example")],
        [DOCUMENT_REFUSAL, post("https://pivotparlor.com/login", "null")],
        [DOCUMENT_REFUSAL, post("https://pivotparlor.com/login", "http://pivotparlor.com")],
        [BAD_ORIGIN_REFUSAL, post("https://pivotparlor.com/login", "not a url")],
        [DATA_REFUSAL, post("https://pivotparlor.com/login.data", "https://elsewhere.example")],
        [DATA_REFUSAL, post("https://pivotparlor.com/admin/pos.data?shopId=s1", "null", "PUT")],
      ];
      for (const [message, request] of cases) {
        reportServerError(new Error(message), { request, env: { WEB_ERRORS: binding } });
      }
      expect(binding.report).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
    });

    it("the same message is still reported from a same-site post, a post with no Origin, or a GET", () => {
      const { reports, binding } = fakeBinding();
      reportServerError(new Error(DATA_REFUSAL), { request: post("https://pivotparlor.com/login.data", "https://pivotparlor.com"), env: { WEB_ERRORS: binding } });
      reportServerError(new Error(DATA_REFUSAL), { request: post("https://pivotparlor.com/login.data"), env: { WEB_ERRORS: binding } });
      reportServerError(new Error(DOCUMENT_REFUSAL), { request: req("https://pivotparlor.com/login", { headers: { Origin: "https://elsewhere.example" } }), env: { WEB_ERRORS: binding } });
      expect(reports.map((r) => r.message)).toEqual([DATA_REFUSAL, DATA_REFUSAL, DOCUMENT_REFUSAL]);
    });

    it("any other error on a post from another site is still reported", () => {
      const { reports, binding } = fakeBinding();
      reportServerError(errorWithStack("the action broke"), { request: post("https://pivotparlor.com/logout", "https://elsewhere.example"), env: { WEB_ERRORS: binding } });
      reportServerError({ status: 400, message: DATA_REFUSAL }, { request: post("https://pivotparlor.com/x.data", "null"), env: { WEB_ERRORS: binding } });
      expect(reports).toHaveLength(2);
    });

    it("the messages are the ones the installed React Router throws", () => {
      // The ES module build, the one the server bundle takes: its entry only
      // re-exports chunk files that sit beside it.
      const dist = path.dirname(createRequire(path.resolve(process.cwd(), "package.json")).resolve("react-router"));
      const source = readdirSync(dist)
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => readFileSync(path.join(dist, f), "utf8"))
        .join("\n")
        // One message is a template literal there, so its backticks are escaped.
        .replaceAll("\\`", "`");
      expect(source).toContain(DOCUMENT_REFUSAL);
      expect(source).toContain(BAD_ORIGIN_REFUSAL);
      expect(source).toMatch(/handleQueryError\(new Error\("Bad Request"\), 400\)/);
      // Its rule for "another site", which ours mirrors: no allowedActionOrigins.
      expect(source).toContain("originUrl.origin === requestUrl.origin");
      expect(readFileSync(path.resolve(process.cwd(), "react-router.config.ts"), "utf8")).not.toMatch(/allowedActionOrigins/);
    });
  });

  it("never throws: no binding (local dev), or a binding that fails", async () => {
    expect(() => reportServerError(errorWithStack("a"), { request: req("https://pivotparlor.com/a") })).not.toThrow();
    const failing = { report: vi.fn(async () => Promise.reject(new Error("binding down"))) };
    const waits: Promise<unknown>[] = [];
    reportServerError(errorWithStack("b"), { request: req("https://pivotparlor.com/b"), env: { WEB_ERRORS: failing }, waitUntil: (p) => void waits.push(p) });
    await expect(Promise.all(waits)).resolves.toBeDefined();
    const throwing = { report: vi.fn(() => { throw new Error("sync"); }) };
    expect(() => reportServerError(errorWithStack("c"), { request: req("https://pivotparlor.com/c"), env: { WEB_ERRORS: throwing } })).not.toThrow();
  });
});

describe("handleError (React Router's server error hook)", () => {
  it("reports with the load context's env and waitUntil", async () => {
    const { reports, binding } = fakeBinding();
    const waits: Promise<unknown>[] = [];
    handleError(errorWithStack("from a loader"), {
      request: req("https://pivotparlor.com/dev/shops/s1?_data=routes%2Fdev.shops.%24shopId"),
      params: { shopId: "s1" },
      context: { env: { WEB_ERRORS: binding }, waitUntil: (p: Promise<unknown>) => void waits.push(p) },
    } as never);
    await Promise.all(waits);
    expect(reports).toEqual([expect.objectContaining({ where: "data", route: "/dev/shops/:shopId" })]);
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf8");

  it("entry.server exports handleError and reports streaming render errors", () => {
    const src = read("app/entry.server.tsx");
    expect(src).toMatch(/export\s*\{\s*handleError\s*\}\s*from\s*["']\.\/lib\/serverErrors["']/);
    expect(src).toMatch(/onError\([^)]*\)\s*\{[\s\S]*?reportServerError\(/);
  });

  it("the Pages middleware passes waitUntil to React Router and reports what escapes it", () => {
    const src = read("functions/_middleware.ts");
    expect(src).toMatch(/waitUntil:\s*\(?[^\n]*context\.waitUntil/);
    expect(src).toMatch(/catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?reportServerError\([\s\S]*?where:\s*"middleware"[\s\S]*?throw\s+\w+/);
  });
});
