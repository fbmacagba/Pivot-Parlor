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
