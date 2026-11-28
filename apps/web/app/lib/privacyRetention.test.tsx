import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// The privacy pages promise how long data is kept. The periods are set in the
// API worker (RETENTION_POLICY, the activity log's own retention and the
// 30 days a visitor's IP address stays readable). Changing one there fails
// this test until both pages say the new period.

const sources = import.meta.glob(
  [
    "../../../worker/src/services/retention.ts",
    "../../../worker/src/audit/retention.ts",
    "../../../../packages/audit/src/recorder.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function source(end: string): string {
  const key = Object.keys(sources).find((k) => k.endsWith(end));
  if (!key) throw new Error(`source not found: ${end}`);
  return sources[key];
}

function setting(text: string, pattern: RegExp): number {
  const found = pattern.exec(text);
  if (!found) throw new Error(`setting not found: ${pattern}`);
  return Number(found[1]);
}

const policy = source("services/retention.ts");
const chatDays = setting(policy, /chatSessionsDays:\s*(\d+)/);
const waitlistDays = setting(policy, /waitlistDays:\s*(\d+)/);
const contactsMonths = setting(policy, /contactsMonths:\s*(\d+)/);
const bookingMonths = setting(policy, /bookingPiiMonths:\s*(\d+)/);
const evidenceYears = setting(policy, /refundEvidenceYears:\s*(\d+)/);
const auditDays = setting(source("audit/retention.ts"), /AUDIT_RETENTION_DAYS\s*=\s*(\d+)/);
const ipDays = setting(source("recorder.ts"), /\+\s*(\d+)\s*\*\s*DAY_MS/);

const layout = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("react-router", async (importOriginal) => {
  const React = await import("react");
  return {
    ...(await importOriginal<typeof import("react-router")>()),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string } & Record<string, unknown>) =>
      React.createElement("a", { href: to, ...rest }, children),
    useRouteLoaderData: () => layout.data,
  };
});
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import PlatformPrivacy from "~/routes/_marketing.privacy";
import ShopPrivacy from "~/routes/$shopSlug.privacy";

function text(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? "";
}

function years(n: number): string {
  return n === 1 ? "1 year" : `${n} years`;
}

const pages: Array<[string, () => string]> = [
  ["the platform privacy policy", () => text(renderToStaticMarkup(<PlatformPrivacy />))],
  [
    "the shop privacy template",
    () => {
      layout.data = { slug: "example-cuts", shop: { id: "shop-1", name: "Example Cuts" }, site: null, settings: {} };
      return text(renderToStaticMarkup(<ShopPrivacy />));
    },
  ],
];

describe("retention periods in the privacy pages", () => {
  it.each(pages)("%s states the periods the system uses", (_page, render) => {
    const body = render();
    expect(body).toContain(`${years(bookingMonths / 12)} after the appointment`);
    expect(body).toMatch(new RegExp(`chat assistant are deleted after ${chatDays} days`));
    expect(body).toMatch(new RegExp(`[Ww]aitlist entries (are deleted )?after ${years(waitlistDays / 365)}`));
    expect(body).toMatch(new RegExp(`support a refund are deleted after ${years(evidenceYears)}`));
    expect(body).toMatch(new RegExp(`is kept for ${years(Math.floor(auditDays / 365))}\\.`));
    expect(body).toContain(`removed after ${ipDays} days`);
  });

  it("the platform policy states how long enquiries are kept", () => {
    expect(pages[0][1]()).toContain(`retained for up to ${years(contactsMonths / 12)}`);
  });

  it("neither page keeps a period nothing enforces", () => {
    for (const [, render] of pages) {
      expect(render()).not.toMatch(/up to 3 years|up to 7 years|12 months after/);
    }
  });
});
