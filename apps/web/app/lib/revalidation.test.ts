import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { revalidateAfterConflict, revalidateAfterFailedSubmission } from "./revalidation";

// React Router 7 (and Remix with single fetch) no longer reloads a page's data
// after a submission answered 4xx/5xx. A 409 means the data moved underneath
// the page (a slot just taken), so those pages reload anyway.

const run = (extra: Record<string, unknown>) =>
  revalidateAfterConflict({
    currentUrl: new URL("https://web.test/a"),
    nextUrl: new URL("https://web.test/a"),
    ...extra,
  } as never);

describe("revalidateAfterConflict", () => {
  it("reloads after a 409, even when the router would not", () => {
    expect(run({ formMethod: "POST", actionStatus: 409, defaultShouldRevalidate: false })).toBe(true);
  });

  it("leaves any other failed submission to the router", () => {
    expect(run({ formMethod: "POST", actionStatus: 400, defaultShouldRevalidate: false })).toBe(false);
  });

  it("leaves navigations without a submission to the router", () => {
    expect(run({ defaultShouldRevalidate: true })).toBe(true);
    expect(run({ defaultShouldRevalidate: false })).toBe(false);
  });
});

describe("revalidateAfterFailedSubmission", () => {
  const go = (extra: Record<string, unknown>) =>
    revalidateAfterFailedSubmission({
      currentUrl: new URL("https://web.test/a"),
      nextUrl: new URL("https://web.test/a"),
      ...extra,
    } as never);

  it("reloads after any failed submission, as Remix 2 did", () => {
    expect(go({ formMethod: "POST", actionStatus: 400, defaultShouldRevalidate: false })).toBe(true);
    expect(go({ formMethod: "POST", actionStatus: 502, defaultShouldRevalidate: false })).toBe(true);
  });

  it("leaves successful submissions and navigations to the router", () => {
    expect(go({ formMethod: "POST", actionStatus: 200, defaultShouldRevalidate: false })).toBe(false);
    expect(go({ defaultShouldRevalidate: false })).toBe(false);
  });
});

// Every page action calls the API and answers its refusals with a status of its
// own: a row deleted by someone else (404) or a clash (409) becomes the page's
// 400 or 502, so the status cannot say whether the data changed underneath.
// Under React Router 7 such a page would keep showing data that just changed,
// so every page with an action reloads its own data after a failed submission,
// as each page does under Remix 2. The list is found, not written: a new page
// with an action fails here until it decides.
const ROUTES = resolve(process.cwd(), "app/routes");

// Pages that decide differently, and why.
const OWN_RULE: Record<string, string> = {
  // Reloads after a 409 only (the time picked was just taken); see bookingUrl.ts.
  "$shopSlug.book.tsx": "skipRevalidationForWizardParams",
};
const NO_LOADER = new Set([
  // Nothing of its own to reload.
  "_marketing.contact.tsx",
]);

const exportsFn = (src: string, name: string) =>
  new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`).test(src);

const pagesWithActions = readdirSync(ROUTES)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
  .map((file) => ({ file, src: readFileSync(resolve(ROUTES, file), "utf8") }))
  .filter(({ src }) => /export\s+default\b/.test(src) && exportsFn(src, "action"));

describe("every page with an action reloads after a failed submission", () => {
  it("finds the pages (a broken scan would pass everything)", () => {
    expect(pagesWithActions.length).toBeGreaterThanOrEqual(20);
    expect(pagesWithActions.map((p) => p.file)).toContain("admin.bookings.tsx");
  });

  it.each(pagesWithActions.map((p) => [p.file, p.src]))("%s", (file, src) => {
    if (NO_LOADER.has(file)) {
      expect(exportsFn(src, "loader")).toBe(false);
      return;
    }
    const rule = OWN_RULE[file] ?? "revalidateAfterFailedSubmission";
    expect(src).toMatch(new RegExp(`export const shouldRevalidate = ${rule};`));
  });
});
