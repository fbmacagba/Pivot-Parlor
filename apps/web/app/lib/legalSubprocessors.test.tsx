import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// The chat assistants (the marketing site's and each shop's) and the site
// builder send people's messages and shop details to AI model vendors through
// @repo/llm. Every vendor it can call must be named where people read who
// gets their data: the DPA's sub-processor list (Annex 2), the platform's
// privacy policy, and the shop privacy template. Adding an adapter to
// packages/llm/src/adapters fails this test until the legal text names it.

const VENDOR_BY_ADAPTER: Record<string, string> = {
  "anthropic.ts": "Anthropic Ireland, Limited",
  "openai.ts": "OpenAI OpCo, LLC",
  "openrouter.ts": "OpenRouter, Inc.",
};

const adapters = Object.keys(import.meta.glob("../../../../packages/llm/src/adapters/*.ts")).map((p) => p.split("/").pop()!);

const layout = vi.hoisted(() => ({ data: undefined as unknown }));

// The real module's server helpers with the screen parts stubbed on top.
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

import Dpa from "~/routes/_marketing.dpa";
import PlatformPrivacy from "~/routes/_marketing.privacy";
import ShopPrivacy from "~/routes/$shopSlug.privacy";

function text(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("AI vendors in the legal pages", () => {
  it("knows every adapter @repo/llm ships", () => {
    expect(adapters.sort()).toEqual(Object.keys(VENDOR_BY_ADAPTER).sort());
  });

  const pages: Array<[string, () => string]> = [
    ["the DPA's Annex 2", () => {
      const all = text(renderToStaticMarkup(<Dpa />));
      const start = all.indexOf("Annex 2: Authorised Sub-processors");
      const end = all.indexOf("Annex 3: Technical");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return all.slice(start, end);
    }],
    ["the platform privacy policy", () => text(renderToStaticMarkup(<PlatformPrivacy />))],
    ["the shop privacy template", () => {
      layout.data = {
        slug: "example-cuts",
        shop: { id: "shop-1", name: "Example Cuts" },
        site: null,
        settings: {},
      };
      return text(renderToStaticMarkup(<ShopPrivacy />));
    }],
  ];

  it.each(pages)("%s names every AI vendor", (_page, render) => {
    const body = render();
    expect(body.length).toBeGreaterThan(200);
    for (const vendor of Object.values(VENDOR_BY_ADAPTER)) expect(body, vendor).toContain(vendor);
  });

  it("the platform privacy policy says what the chat assistant collects", () => {
    expect(text(renderToStaticMarkup(<PlatformPrivacy />))).toMatch(/chat assistant/i);
  });

  // A changed sub-processor list is a changed document: the pages say when,
  // and a shop accepting the DPA from now on is recorded against the new
  // version (apps/worker/src/lib/legal.ts keeps the same number).
  it("the changed pages carry the new date and the DPA the new version", () => {
    expect(pages[1][1]()).toContain("Last updated: November 2026");
    expect(pages[2][1]()).toContain("Last updated: November 2026");
    expect(text(renderToStaticMarkup(<Dpa />))).toContain("Version 1.1");
  });
});
