import { readFileSync } from "node:fs";
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

// Dashboard actions that turn an API conflict (409: a booking clash, a refund
// or void race, a stock take in progress) into their own 400/502. Under React
// Router 7 those pages would keep showing data that just changed, so they
// reload after any failed submission, exactly as they do under Remix 2.
const RELAY_API_CONFLICTS = [
  "admin.bookings.tsx",
  "staff.bookings.tsx",
  "admin.sales.tsx",
  "admin.pos.tsx",
  "staff.pos.tsx",
  "admin.inventory.tsx",
];

describe("pages that surface an API conflict reload after a failed submission", () => {
  it.each(RELAY_API_CONFLICTS)("%s", (file) => {
    const src = readFileSync(resolve(process.cwd(), "app/routes", file), "utf8");
    expect(src).toMatch(/export const shouldRevalidate = revalidateAfterFailedSubmission;/);
  });
});
