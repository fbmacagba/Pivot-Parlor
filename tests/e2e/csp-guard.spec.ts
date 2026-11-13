import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, oursOnly, test } from "./fixtures";

// The CSP collector (fixtures.ts) must be on for every spec, must actually
// fire, and must see the public pages no other spec visits. This file is in
// both the SMOKE and FULL tiers (.github/workflows/e2e.yml).

test.describe("CSP collector wiring", () => {
  test("every spec imports test and expect from ./fixtures", () => {
    const dir = __dirname;
    const specs = readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    expect(specs.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of specs) {
      const src = readFileSync(path.join(dir, file), "utf8");
      // A value import from @playwright/test would give the spec a `test`
      // without the collector; type-only imports are harmless.
      const valueImport = /import\s+(?!type\b)[^;]*from\s+["']@playwright\/test["']/.test(src);
      const usesFixtures = /from\s+["']\.\/fixtures["']/.test(src);
      if (valueImport || !usesFixtures) offenders.push(file);
    }
    expect(offenders, "specs that bypass the CSP collector").toEqual([]);
  });

  test("counts only our policy on our site", () => {
    const base = { blockedURI: "https://x.test/a.js", effectiveDirective: "script-src-elem", disposition: "report", sourceFile: "", line: 0 };
    const ours = { ...base, documentURI: "https://site.test/book", originalPolicy: "default-src 'self'; script-src 'self'" };
    const turnstileFrame = { ...base, documentURI: "https://challenges.cloudflare.com/x", originalPolicy: "default-src 'self'; frame-src x" };
    const cloudflareMonitor = { ...base, documentURI: "https://site.test/", originalPolicy: "script-src 'none'; connect-src 'none'" };
    expect(oursOnly([ours, turnstileFrame, cloudflareMonitor], "https://site.test")).toEqual([ours]);
  });
});

test.describe("CSP collector control", () => {
  test.use({ cspExpectViolations: true });

  test("reports an off-list script on our page under our policy", async ({ page, baseURL, cspReports }) => {
    const res = await page.goto("/");
    const headers = res?.headers() ?? {};
    const enforced = Boolean(headers["content-security-policy"]);
    expect(enforced, "the policy is enforced (apps/web/app/lib/securityHeaders.ts CSP_HEADER)").toBe(true);
    expect(headers["content-security-policy-report-only"], "no second, report-only policy").toBeUndefined();

    await page.evaluate(() => {
      const s = document.createElement("script");
      s.src = "https://example.com/pp-csp-control.js";
      document.head.appendChild(s);
    });

    const siteOrigin = baseURL ? new URL(baseURL).origin : null;
    await expect
      .poll(() => oursOnly(cspReports, siteOrigin).filter((r) => r.blockedURI.includes("example.com")).length)
      .toBeGreaterThan(0);
    const report = oursOnly(cspReports, siteOrigin).find((r) => r.blockedURI.includes("example.com"))!;
    expect(report.effectiveDirective).toBe("script-src-elem");
    // "report" while the header is report-only, "enforce" once it is enforced.
    expect(report.disposition).toBe(enforced ? "enforce" : "report");
  });
});

// Inline scripts run only when they carry the nonce the response header names
// (apps/web/app/lib/securityHeaders.ts, made per request in
// functions/_middleware.ts). Remix's own three (scroll restoration, the
// context and the module loader) carry it; an injected one does not.
const nonceIn = (csp: string | undefined): string | null => csp?.match(/'nonce-([A-Za-z0-9+/]+={0,2})'/)?.[1] ?? null;
const scriptSrcOf = (csp: string | undefined): string =>
  (csp ?? "").split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";

test.describe("Inline scripts need the page's nonce", () => {
  test.describe("control", () => {
    test.use({ cspExpectViolations: true });

    test("an injected inline script is blocked and reported", async ({ page, baseURL, cspReports }) => {
      await page.goto("/");
      const ran = await page.evaluate(async () => {
        const s = document.createElement("script");
        s.textContent = "window.__ppInjectedRan = true;";
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 100));
        return (window as unknown as { __ppInjectedRan?: boolean }).__ppInjectedRan === true;
      });
      expect(ran, "an injected inline script must not run").toBe(false);

      const siteOrigin = baseURL ? new URL(baseURL).origin : null;
      const inlineReports = () => oursOnly(cspReports, siteOrigin).filter((r) => r.blockedURI === "inline");
      await expect.poll(() => inlineReports().length).toBeGreaterThan(0);
      expect(inlineReports()[0].effectiveDirective).toBe("script-src-elem");
      expect(inlineReports()[0].disposition).toBe("enforce");
    });
  });

  const PAGES: Array<[string, number]> = [["/", 200], ["/login", 200], ["/pricing", 200], ["/no-such-page-e2e-csp", 404]];
  for (const [p, status] of PAGES) {
    test(`every inline script on ${p} carries the header's nonce`, async ({ page }) => {
      const browserErrors: string[] = [];
      page.on("request", (req) => {
        if (req.method() === "POST" && new URL(req.url()).pathname === "/client-errors") browserErrors.push(req.postData() ?? "");
      });

      const res = await page.goto(p, { waitUntil: "load" });
      expect(res?.status()).toBe(status);
      const csp = res?.headers()["content-security-policy"];
      expect(scriptSrcOf(csp)).not.toContain("'unsafe-inline'");
      const nonce = nonceIn(csp);
      expect(nonce, "script-src names a nonce").toBeTruthy();

      // The nonce property, not the attribute: browsers blank the attribute.
      const nonces = await page.$$eval("script:not([src])", (els) => els.map((e) => (e as HTMLScriptElement).nonce));
      expect(nonces.length, "Remix's inline scripts").toBeGreaterThanOrEqual(3);
      expect(nonces.filter((n) => n !== nonce), "inline scripts without the page's nonce").toEqual([]);

      // Hydration ran with the nonce in place: no browser error was reported.
      await page.waitForTimeout(1500);
      expect(browserErrors, "browser error reports (hydration included)").toEqual([]);
    });
  }

  test("each response gets a new nonce", async ({ request }) => {
    const first = nonceIn((await request.get("/login")).headers()["content-security-policy"]);
    const second = nonceIn((await request.get("/login")).headers()["content-security-policy"]);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

// Public pages that no other spec opens. Load and scroll only: the contact
// form is never filled or submitted and the bot check is never touched.
const PUBLIC_PAGES = ["/", "/pricing", "/about", "/contact", "/privacy", "/terms", "/cookies", "/dpa", "/login"];

test.describe("CSP on public pages", () => {
  for (const p of PUBLIC_PAGES) {
    test(`no violations on ${p}`, async ({ page }) => {
      const res = await page.goto(p, { waitUntil: "load" });
      expect(res?.status()).toBe(200);
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 100));
        }
      });
      // Late loaders (fonts, the bot check's script) report after load.
      await page.waitForTimeout(1500);
    });
  }
});
