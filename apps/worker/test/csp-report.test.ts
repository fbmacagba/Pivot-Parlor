/**
 * CSP violation reports (POST /csp-report). Browsers send one when the site's
 * Content-Security-Policy blocks something; the endpoint logs it with
 * console.error so Workers Issues opens an issue and the owner gets an email
 * (docs/runbooks/production-alerting.md). Junk must not reach the log, the
 * audit trail or the inbox.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CSP_REPORT_PATH, cspKind } from "../src/routes/csp-report";

let ipSeq = 0;
/** A fresh client IP per test, so the shared rate limiter never bleeds between tests. */
const freshIp = () => `198.51.100.${++ipSeq}`;

async function send(
  method: string,
  opts: { body?: string; type?: string; ip?: string; origin?: string; environment?: string; path?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.ip ?? freshIp() };
  if (opts.type) headers["Content-Type"] = opts.type;
  if (opts.origin) headers["Origin"] = opts.origin;
  const request = new Request(`https://worker.test${opts.path ?? CSP_REPORT_PATH}`, { method, headers, body: opts.body });
  const ctx = createExecutionContext();
  const bindings = opts.environment ? { ...env, ENVIRONMENT: opts.environment } : env;
  const res = await worker.fetch(request as never, bindings as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return res as unknown as Response;
}

/** What `report-uri` sends (application/csp-report). */
function legacyReport(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "csp-report": {
      "document-uri": "https://pivotparlor.com/book?token=secret-token",
      referrer: "",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "original-policy": "default-src 'self'",
      disposition: "enforce",
      "blocked-uri": "https://evil.example/x.js?u=someone@example.com",
      "line-number": 12,
      "source-file": "https://pivotparlor.com/assets/app.js?v=2",
      "status-code": 200,
      "script-sample": "",
      ...over,
    },
  });
}

/** What `report-to` sends (application/reports+json): a batch of reports. */
function reportingBatch(bodies: Record<string, unknown>[], type = "csp-violation"): string {
  return JSON.stringify(
    bodies.map((body) => ({
      type,
      age: 10,
      url: String(body.documentURL ?? "https://pivotparlor.com/"),
      user_agent: "Mozilla/5.0",
      body: { originalPolicy: "default-src 'self'", disposition: "enforce", statusCode: 200, ...body },
    })),
  );
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

const cspLines = () => errors.mock.calls.filter((c) => String(c[0]).startsWith("[csp]"));

describe("POST /csp-report", () => {
  it("logs a report-uri violation once, with the query strings stripped", async () => {
    const res = await send("POST", { body: legacyReport(), type: "application/csp-report", environment: "production" });
    expect(res.status).toBe(204);
    expect(cspLines()).toEqual([
      [
        "[csp] blocked a script",
        {
          directive: "script-src-elem",
          blocked: "https://evil.example/x.js",
          page: "https://pivotparlor.com/book",
          source: "https://pivotparlor.com/assets/app.js",
          line: "12",
          disposition: "enforce",
        },
      ],
    ]);
  });

  it("logs each csp-violation in a report-to batch under its own kind, and ignores other report types", async () => {
    const batch = JSON.parse(
      reportingBatch([
        { documentURL: "https://pivotparlor.com/dash?x=1", blockedURL: "https://tracker.example/collect", effectiveDirective: "connect-src", sourceFile: null, lineNumber: null },
        { documentURL: "https://www.pivotparlor.com/visit", blockedURL: "https://maps.example/embed", effectiveDirective: "frame-src", sourceFile: "https://www.pivotparlor.com/assets/v.js", lineNumber: 3 },
      ]),
    ) as unknown[];
    batch.push(...(JSON.parse(reportingBatch([{ id: "x", message: "deprecated API" }], "deprecation")) as unknown[]));
    const res = await send("POST", { body: JSON.stringify(batch), type: "application/reports+json", environment: "production" });
    expect(res.status).toBe(204);
    expect(cspLines()).toEqual([
      [
        "[csp] blocked a connection",
        { directive: "connect-src", blocked: "https://tracker.example/collect", page: "https://pivotparlor.com/dash", source: "none", line: "none", disposition: "enforce" },
      ],
      [
        "[csp] blocked a frame",
        { directive: "frame-src", blocked: "https://maps.example/embed", page: "https://www.pivotparlor.com/visit", source: "https://www.pivotparlor.com/assets/v.js", line: "3", disposition: "enforce" },
      ],
    ]);
  });

  it("gives every logged value as a non-empty string, so one kind is always one issue", async () => {
    // Workers Issues groups by the message with values masked: a number, a
    // null or a missing key would fingerprint as a different issue.
    await send("POST", {
      body: reportingBatch([{ documentURL: "https://pivotparlor.com/", blockedURL: "inline", effectiveDirective: "style-src-attr" }]),
      type: "application/reports+json",
      environment: "production",
    });
    const [[message, details]] = cspLines();
    expect(message).toBe("[csp] blocked a style");
    expect(Object.keys(details as object)).toEqual(["directive", "blocked", "page", "source", "line", "disposition"]);
    for (const v of Object.values(details as Record<string, unknown>)) {
      expect(typeof v).toBe("string");
      expect((v as string).length).toBeGreaterThan(0);
    }
    expect(details).toMatchObject({ blocked: "inline", source: "none", line: "none" });
  });

  it("keeps only the scheme of a data: or blob: URL", async () => {
    await send("POST", {
      body: legacyReport({ "effective-directive": "img-src", "blocked-uri": "data:image/png;base64,AAAA" }),
      type: "application/csp-report",
      environment: "production",
    });
    expect(cspLines()[0]?.[1]).toMatchObject({ blocked: "data" });
  });

  it("drops a report caused by a browser extension", async () => {
    for (const over of [
      { "blocked-uri": "chrome-extension://abcdef/inject.js" },
      { "source-file": "moz-extension://1234/content.js" },
      { "blocked-uri": "safari-web-extension://x/y.js" },
    ]) {
      const res = await send("POST", { body: legacyReport(over), type: "application/csp-report", environment: "production" });
      expect(res.status).toBe(204);
    }
    expect(cspLines()).toEqual([]);
  });

  it("drops an extension report that names only the scheme, as Chrome's report-to does", async () => {
    // Production 2026-11-12: an extension's eval on /login and /dev arrived
    // with sourceFile "chrome-extension" (no colon, no path), slipped past the
    // filter and emailed the owner twice. Both report formats, each scheme.
    const bare = ["chrome-extension", "moz-extension", "safari-web-extension", "webkit-masked-url"];
    const res = await send("POST", {
      body: reportingBatch(
        bare.map((sourceFile) => ({ documentURL: "https://pivotparlor.com/dev", blockedURL: "eval", effectiveDirective: "script-src", sourceFile, lineNumber: 3 })),
      ),
      type: "application/reports+json",
      environment: "production",
    });
    expect(res.status).toBe(204);
    for (const scheme of bare) {
      await send("POST", { body: legacyReport({ "blocked-uri": "eval", "source-file": scheme }), type: "application/csp-report", environment: "production" });
      await send("POST", { body: legacyReport({ "blocked-uri": scheme }), type: "application/csp-report", environment: "production" });
    }
    expect(cspLines()).toEqual([]);

    // Control: the same eval from our own script is still reported.
    await send("POST", {
      body: reportingBatch([{ documentURL: "https://pivotparlor.com/dev", blockedURL: "eval", effectiveDirective: "script-src", sourceFile: "https://pivotparlor.com/assets/app.js", lineNumber: 3 }]),
      type: "application/reports+json",
      environment: "production",
    });
    expect(cspLines()).toEqual([
      [
        "[csp] blocked a script",
        { directive: "script-src", blocked: "eval", page: "https://pivotparlor.com/dev", source: "https://pivotparlor.com/assets/app.js", line: "3", disposition: "enforce" },
      ],
    ]);
  });

  it("drops a report about a page that is not ours", async () => {
    const res = await send("POST", {
      body: legacyReport({ "document-uri": "https://evil.example/page" }),
      type: "application/csp-report",
      environment: "production",
    });
    expect(res.status).toBe(204);
    expect(cspLines()).toEqual([]);
  });

  it("in production, drops reports from staging and preview pages", async () => {
    for (const page of ["https://staging.pivot-parlor-web.pages.dev/", "http://localhost:3000/"]) {
      await send("POST", { body: legacyReport({ "document-uri": page }), type: "application/csp-report", environment: "production" });
    }
    expect(cspLines()).toEqual([]);
    // Control: the same staging page is logged by the staging API.
    await send("POST", {
      body: legacyReport({ "document-uri": "https://staging.pivot-parlor-web.pages.dev/" }),
      type: "application/csp-report",
      environment: "staging",
    });
    expect(cspLines()).toHaveLength(1);
  });

  it("refuses a body over 16 KB without logging", async () => {
    const big = legacyReport({ "script-sample": "x".repeat(17_000) });
    const res = await send("POST", { body: big, type: "application/csp-report", environment: "production" });
    expect(res.status).toBe(413);
    expect(cspLines()).toEqual([]);
  });

  it("refuses a body that is not JSON without logging", async () => {
    const res = await send("POST", { body: "not json", type: "application/csp-report", environment: "production" });
    expect(res.status).toBe(400);
    expect(cspLines()).toEqual([]);
  });

  it("rate-limits by client IP: past the limit it answers 429 and logs nothing", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await send("POST", { body: legacyReport(), type: "application/csp-report", ip, environment: "production" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(cspLines()).toHaveLength(20);
    // Another client is unaffected.
    const other = await send("POST", { body: legacyReport(), type: "application/csp-report", environment: "production" });
    expect(other.status).toBe(204);
  });

  it("writes nothing to the audit trail", async () => {
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n;
    const before = await count();
    await send("POST", { body: legacyReport(), type: "application/csp-report", environment: "production" });
    await send("POST", { body: "not json", type: "application/csp-report", environment: "production" });
    expect(await count()).toBe(before);
  });

  it("answers any origin without credentials, and sets no cookie", async () => {
    const res = await send("POST", { body: legacyReport(), type: "application/csp-report", origin: "null", environment: "production" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("OPTIONS /csp-report (the Reporting API's preflight)", () => {
  it.each(["https://pivotparlor.com", "null", "https://anything.example"])("allows a POST with a JSON body from %s", async (origin) => {
    const res = await send("OPTIONS", { origin, path: `${CSP_REPORT_PATH}/` });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("content-type");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("control: other paths still get the main app's credentialed CORS", async () => {
    const res = await send("OPTIONS", { origin: "https://pivotparlor.com", path: "/auth/me" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://pivotparlor.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});

describe("cspKind", () => {
  it.each([
    ["script-src", "script"],
    ["script-src-elem", "script"],
    ["script-src-attr", "script"],
    ["worker-src", "script"],
    ["style-src-elem", "style"],
    ["connect-src", "connection"],
    ["frame-src", "frame"],
    ["child-src", "frame"],
    ["img-src", "image"],
    ["font-src", "font"],
    ["form-action", "form"],
    ["frame-ancestors", "other"],
    ["base-uri", "other"],
    ["", "other"],
  ])("%s is %s", (directive, kind) => {
    expect(cspKind(directive)).toBe(kind);
  });
});
