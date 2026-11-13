import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CSP_HEADER,
  CSP_REPORT_PATH,
  SECURITY_HEADERS,
  contentSecurityPolicy,
  newCspNonce,
  withSecurityHeaders,
} from "./securityHeaders";

// Cloudflare Pages applies public/_headers to STATIC ASSET responses only.
// Every Remix page is a Pages Functions response, so until this helper ran
// in functions/_middleware.ts, /login, the dashboards and every shop page
// went out with no HSTS, no framing protection and no CSP (measured live on
// 2026-11-10: /favicon.svg carried all six headers, every HTML page none).

const directive = (csp: string, name: string): string[] => {
  const found = csp.split(";").map((d) => d.trim()).find((d) => d.split(/\s+/)[0] === name);
  return found ? found.split(/\s+/).slice(1) : [];
};

describe("withSecurityHeaders", () => {
  it("adds every security header to a page response and keeps its status and body", async () => {
    const res = withSecurityHeaders(new Response("<p>hi</p>", { status: 201, headers: { "Content-Type": "text/html" } }));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("<p>hi</p>");
    expect(res.headers.get("Content-Type")).toBe("text/html");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get(CSP_HEADER)).toBe(contentSecurityPolicy());
  });

  it("keeps a route's own report-only policy and adds no second policy", () => {
    const own = "default-src 'self'; report-uri /x";
    const res = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy-Report-Only": own } }));
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBe(own);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("works on a response whose headers are immutable (a redirect)", () => {
    // Response.redirect() and upstream fetch() responses (the api.* proxies
    // return them as-is) have immutable headers; setting on them throws.
    const res = withSecurityHeaders(Response.redirect("https://pivotparlor.com/login", 302));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://pivotparlor.com/login");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("never overrides a header the route set itself", () => {
    // dev.activity.export sends its own, stricter, ENFORCED policy.
    const own = "default-src 'none'; style-src 'unsafe-inline'";
    const res = withSecurityHeaders(
      new Response("x", { headers: { "Content-Security-Policy": own, "Referrer-Policy": "no-referrer" } }),
    );
    expect(res.headers.get("Content-Security-Policy")).toBe(own);
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("allows the deployment's own API origin, once", () => {
    const staging = withSecurityHeaders(new Response("x"), { apiOrigin: "https://api-staging.example.dev" });
    expect(directive(staging.headers.get(CSP_HEADER)!, "connect-src")).toContain("https://api-staging.example.dev");
    const prod = withSecurityHeaders(new Response("x"), { apiOrigin: "https://api.pivotparlor.com" });
    const connect = directive(prod.headers.get(CSP_HEADER)!, "connect-src");
    expect(connect.filter((s) => s === "https://api.pivotparlor.com")).toHaveLength(1);
    expect(withSecurityHeaders(new Response("x"), { apiOrigin: "" }).headers.get(CSP_HEADER)).toBe(contentSecurityPolicy());
  });
});

describe("violation reports", () => {
  // The API logs each report so Workers Issues emails the owner
  // (apps/worker/src/routes/csp-report.ts). Each deployment reports to its
  // OWN API: staging pages to the staging API, whose Issues is off, so the
  // E2E collector's deliberate violation never emails anyone.
  it("go to the deployment's own API, through report-to and report-uri", () => {
    const res = withSecurityHeaders(new Response("x"), { apiOrigin: "https://api.pivotparlor.com" });
    const csp = res.headers.get(CSP_HEADER)!;
    expect(directive(csp, "report-uri")).toEqual(["https://api.pivotparlor.com/csp-report"]);
    expect(directive(csp, "report-to")).toEqual(["csp-endpoint"]);
    expect(res.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="https://api.pivotparlor.com/csp-report"');

    const staging = withSecurityHeaders(new Response("x"), { apiOrigin: "https://api-staging.example.dev" });
    expect(directive(staging.headers.get(CSP_HEADER)!, "report-uri")).toEqual(["https://api-staging.example.dev/csp-report"]);
    expect(staging.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="https://api-staging.example.dev/csp-report"');
  });

  it("are not asked for without an API origin, so the static copy in _headers is unchanged", () => {
    const res = withSecurityHeaders(new Response("x"));
    expect(directive(res.headers.get(CSP_HEADER)!, "report-uri")).toEqual([]);
    expect(directive(res.headers.get(CSP_HEADER)!, "report-to")).toEqual([]);
    expect(res.headers.get("Reporting-Endpoints")).toBeNull();
    expect(contentSecurityPolicy()).not.toMatch(/report-(uri|to)/);
  });

  it("are not added to a route's own policy", () => {
    const own = "default-src 'none'";
    const res = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": own } }), {
      apiOrigin: "https://api.pivotparlor.com",
    });
    expect(res.headers.get("Content-Security-Policy")).toBe(own);
    expect(res.headers.get("Reporting-Endpoints")).toBeNull();
  });

  it("use the path the API answers", () => {
    const route = readFileSync(path.resolve(process.cwd(), "../worker/src/routes/csp-report.ts"), "utf8");
    expect(route).toContain(`export const CSP_REPORT_PATH = "${CSP_REPORT_PATH}";`);
    expect(CSP_REPORT_PATH).toBe("/csp-report");
  });
});

describe("the content security policy", () => {
  const csp = contentSecurityPolicy();

  it("is enforced", () => {
    // Report-only from #139 until the E2E collector (tests/e2e/fixtures.ts)
    // and a production sweep showed no violations.
    expect(CSP_HEADER).toBe("Content-Security-Policy");
  });

  it("allows what the pages really load", () => {
    // Shop maps: VisitDetails / LocationSection iframes embed google.com/maps.
    expect(directive(csp, "frame-src")).toContain("https://www.google.com");
    // Staff photo preview: URL.createObjectURL (admin.staff.tsx).
    expect(directive(csp, "img-src")).toContain("blob:");
    // Production API_URL (wrangler.toml), polled from the confirmation page,
    // and the workers.dev host that stored image URLs still point at.
    expect(directive(csp, "connect-src")).toEqual(
      expect.arrayContaining(["'self'", "https://api.pivotparlor.com", "https://pivot-parlor-api.bmorris0565.workers.dev"]),
    );
  });

  it("lets a form submission end at Stripe and nowhere else", () => {
    // Chrome applies form-action to the redirect that follows a native form
    // submission. The booking form's action redirects to the Stripe Checkout
    // session URL and the payments form's to a Connect account link; a
    // submit before hydration is native, and would be refused without these.
    expect(directive(csp, "form-action")).toEqual(["'self'", "https://checkout.stripe.com", "https://connect.stripe.com"]);
  });

  it("forbids framing our pages", () => {
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});

describe("inline scripts", () => {
  // 'unsafe-inline' let any inline script run, an injected one included. Each
  // page now gets a fresh nonce: the header names it, and Remix's own inline
  // scripts carry it (functions/_middleware.ts, entry.server.tsx, root.tsx).
  const NONCE = "q1w2e3r4t5y6u7i8o9p0Aa==";

  it("run only when they carry the page's nonce", () => {
    expect(directive(contentSecurityPolicy([], { nonce: NONCE }), "script-src")).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "https://js.stripe.com",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("never run without one: no policy allows 'unsafe-inline' scripts", () => {
    expect(directive(contentSecurityPolicy(), "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(contentSecurityPolicy([], { nonce: NONCE }), "script-src")).not.toContain("'unsafe-inline'");
    // The static copy for assets has no inline scripts to allow.
    expect(directive(contentSecurityPolicy(), "script-src")).toEqual([
      "'self'",
      "https://js.stripe.com",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("keeps our policy's first directive, which the E2E collector keys on", () => {
    expect(contentSecurityPolicy([], { nonce: NONCE }).startsWith("default-src 'self';")).toBe(true);
  });

  it("names the request's nonce in the response header", () => {
    const res = withSecurityHeaders(new Response("x"), { apiOrigin: "https://api.pivotparlor.com", nonce: NONCE });
    const csp = res.headers.get(CSP_HEADER)!;
    expect(directive(csp, "script-src")).toContain(`'nonce-${NONCE}'`);
    expect(directive(csp, "report-uri")).toEqual(["https://api.pivotparlor.com/csp-report"]);
  });

  it("refuses a nonce that could change the policy", () => {
    for (const bad of ["abc; script-src *", "abc 'unsafe-inline'", "abc'", "", "short"]) {
      expect(() => contentSecurityPolicy([], { nonce: bad }), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("newCspNonce", () => {
  it("is 16 random bytes, base64", () => {
    const nonce = newCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(atob(nonce)).toHaveLength(16);
  });

  it("is new every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newCspNonce()));
    expect(seen.size).toBe(200);
  });

  it("is accepted by the policy", () => {
    const nonce = newCspNonce();
    expect(directive(contentSecurityPolicy([], { nonce }), "script-src")).toContain(`'nonce-${nonce}'`);
  });
});

describe("public/_headers stays in step with the helper", () => {
  // vitest runs with cwd at apps/web.
  const file = readFileSync(path.resolve(process.cwd(), "public/_headers"), "utf8");
  const blocks = file.split(/\r?\n(?=\S)/).map((b) => b.split(/\r?\n/));
  const headersOf = (pattern: string) => {
    const block = blocks.find((b) => b[0].trim() === pattern);
    if (!block) throw new Error(`no _headers block for ${pattern}`);
    return Object.fromEntries(
      block.slice(1).filter((l) => l.trim()).map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
  };

  it("sends the same security headers to static assets", () => {
    expect(headersOf("/*")).toEqual(SECURITY_HEADERS);
  });

  it.each(["https://pivotparlor.com/*", "https://pivot-parlor-web.pages.dev/*"])("%s carries the same policy (enforced on static assets)", (pattern) => {
    expect(headersOf(pattern)).toEqual({ "Content-Security-Policy": contentSecurityPolicy() });
  });
});

describe("functions/_middleware.ts", () => {
  const src = readFileSync(path.resolve(process.cwd(), "functions/_middleware.ts"), "utf8");

  it("sends every response through withSecurityHeaders", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bwithSecurityHeaders\b[^}]*\}\s*from\s*["']\.\.\/app\/lib\/securityHeaders["']/);
    expect(src).toMatch(/withSecurityHeaders\(\s*await\s+apiRoute\.run\(/);
  });

  // The header and the page must name the same nonce, made once per request.
  // The E2E (tests/e2e/csp-guard.spec.ts) proves it on a served page; this
  // keeps the wiring visible here.
  it("makes one nonce per request and gives the same one to the header and the render", () => {
    expect(src).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*newCspNonce\(/m); // never module scope
    expect(src).toMatch(/const\s+nonce\s*=\s*newCspNonce\(\)/);
    expect(src).toMatch(/cspNonce:\s*context\.data\.cspNonce/);
    expect(src).toMatch(/context\.data\.cspNonce\s*=\s*nonce/);
    expect(src).toMatch(/\{\s*apiOrigin:\s*originOf\(context\.env\.API_URL\),\s*nonce\s*\}/);
  });
});
