import { writeFileSync } from "node:fs";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * Every E2E spec imports `test` and `expect` from here, never from
 * @playwright/test (csp-guard.spec.ts fails on a spec that does).
 *
 * The auto fixture below listens for Content-Security-Policy violations in
 * every page of the test's browser context and fails the test on any
 * violation of OUR policy. While the header is report-only that shows what
 * enforcing it would break, page by page, on the journeys the suite drives
 * (logged-in dashboards included); once it is enforced it catches a change
 * that the policy blocks.
 *
 * Only our pages under our policy count. Reports raised inside Turnstile's
 * or Stripe's frames, or under Cloudflare's own report-only script monitor,
 * are counted in the record but never fail a test.
 */

/** Our policy's first directive (apps/web/app/lib/securityHeaders.ts). */
export const OUR_POLICY_PREFIX = "default-src 'self'";

export type CspReport = {
  documentURI: string;
  blockedURI: string;
  effectiveDirective: string;
  disposition: string;
  originalPolicy: string;
  sourceFile: string;
  line: number;
};

type CspFixtures = {
  /** Set true (test.use) only in a test that provokes a violation on purpose. */
  cspExpectViolations: boolean;
  /** Every report raised in the test's context so far, ours and foreign. */
  cspReports: CspReport[];
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Reports under our policy, raised by a document on the site under test. */
export function oursOnly(reports: readonly CspReport[], siteOrigin: string | null): CspReport[] {
  return reports.filter(
    (r) =>
      typeof r.originalPolicy === "string" &&
      r.originalPolicy.startsWith(OUR_POLICY_PREFIX) &&
      (siteOrigin === null || originOf(r.documentURI) === siteOrigin),
  );
}

export const test = base.extend<CspFixtures>({
  cspExpectViolations: [false, { option: true }],

  cspReports: [
    async ({ context, baseURL, cspExpectViolations }, use, testInfo) => {
      const reports: CspReport[] = [];
      const visited = new Set<string>();

      // A binding plus an init script survive every navigation in the
      // context, out to Stripe and back included.
      await context.exposeBinding("__ppCspReport", (_source, report: CspReport) => {
        reports.push(report);
      });
      await context.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          const send = (window as unknown as { __ppCspReport?: (r: unknown) => void }).__ppCspReport;
          send?.({
            documentURI: e.documentURI,
            blockedURI: e.blockedURI,
            effectiveDirective: e.effectiveDirective,
            disposition: e.disposition,
            originalPolicy: e.originalPolicy,
            sourceFile: e.sourceFile,
            line: e.lineNumber,
          });
        });
      });

      const track = (page: Page) =>
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            const url = originOf(frame.url()) ? new URL(frame.url()) : null;
            if (url) visited.add(`${url.origin}${url.pathname}`);
          }
        });
      context.pages().forEach(track);
      context.on("page", track);

      await use(reports);

      const siteOrigin = baseURL ? originOf(baseURL) : null;
      const ours = oursOnly(reports, siteOrigin);
      const record = {
        test: testInfo.titlePath.join(" > "),
        visited: [...visited],
        ours,
        foreign: reports.length - ours.length,
      };
      const body = JSON.stringify(record, null, 2);
      writeFileSync(testInfo.outputPath("csp.json"), body);
      await testInfo.attach("csp.json", { body, contentType: "application/json" });

      if (!cspExpectViolations) {
        const lines = ours.map(
          (r) => `${r.effectiveDirective} (${r.disposition}) blocked ${r.blockedURI || "(inline)"} on ${r.documentURI}`,
        );
        expect(ours, `Content-Security-Policy violations of our policy:\n${lines.join("\n")}`).toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
