import { beforeEach, describe, expect, it, vi } from "vitest";

// In Remix every match carries the URL's FULL params, the root included, but
// only routes/$shopSlug loads the shop. Taking the first match with a
// shopSlug param read the root's data, so the name fell back to the slug:
// live on 2026-11-10, an iPhone's Add to Home Screen title and the install
// invitation both said "ferdyms-barber-shop-014".
const matches = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock("@remix-run/react", () => ({ useMatches: () => matches.current }));

import { useShopMatch } from "./shop-match";

const params = { shopSlug: "ferdyms-barber-shop-014" };

describe("useShopMatch", () => {
  beforeEach(() => {
    matches.current = [];
  });

  it("names the shop from the route that loaded it, not the root", () => {
    matches.current = [
      { id: "root", params, data: { user: null } },
      { id: "routes/$shopSlug", params, data: { shop: { name: "FerdyM's Barber Shop" } } },
      { id: "routes/$shopSlug._index", params, data: { services: [] } },
    ];
    expect(useShopMatch()).toEqual({ slug: "ferdyms-barber-shop-014", name: "FerdyM's Barber Shop" });
  });

  it("falls back to the slug when no match has the shop (an error boundary render)", () => {
    matches.current = [
      { id: "root", params, data: undefined },
      { id: "routes/$shopSlug", params, data: undefined },
    ];
    expect(useShopMatch()).toEqual({ slug: "ferdyms-barber-shop-014", name: "ferdyms-barber-shop-014" });
  });

  it("is null off the shop routes", () => {
    matches.current = [{ id: "root", params: {}, data: {} }, { id: "routes/login", params: {}, data: {} }];
    expect(useShopMatch()).toBeNull();
  });
});
