import { describe, expect, it } from "vitest";
import { isAdminHref, pageShopId, withShopId } from "./pageShop";

const req = (query = "") => new Request(`https://pivotparlor.com/admin/settings${query}`);
const admin = { role: "admin" as const, shop_id: "shop-own" };
const staff = { role: "staff" as const, shop_id: "shop-own" };
const developer = { role: "developer" as const };

describe("pageShopId: which shop a dashboard page is for", () => {
  it("an admin always gets their own shop, whatever the URL or form says", () => {
    expect(pageShopId(req("?shopId=shop-other"), admin)).toBe("shop-own");
    expect(pageShopId(req("?shopId=shop-other"), admin, "shop-form")).toBe("shop-own");
  });

  it("staff get their own shop too", () => {
    expect(pageShopId(req("?shopId=shop-other"), staff)).toBe("shop-own");
  });

  it("an admin with no shop gets none, never the URL's", () => {
    expect(pageShopId(req("?shopId=shop-other"), { role: "admin" })).toBeNull();
    expect(pageShopId(req(), { role: "admin", shop_id: "  " })).toBeNull();
  });

  it("a developer gets the URL's shopId", () => {
    expect(pageShopId(req("?shopId=0f6c2c1e-1b7a-4d2e-9a51-3c2d1e0f9a8b"), developer)).toBe(
      "0f6c2c1e-1b7a-4d2e-9a51-3c2d1e0f9a8b",
    );
  });

  it("a developer's form value beats the URL", () => {
    expect(pageShopId(req("?shopId=shop-url"), developer, "shop-form")).toBe("shop-form");
    expect(pageShopId(req("?shopId=shop-url"), developer, "  ")).toBe("shop-url");
  });

  it("a developer with no shopId gets none", () => {
    expect(pageShopId(req(), developer)).toBeNull();
    expect(pageShopId(req("?shopId="), developer)).toBeNull();
  });

  it("refuses a shopId that is not a plain id (it is put into API paths)", () => {
    for (const bad of ["../dev/stats", "a/b", "shop id", "shop?x=1", "%2e%2e", "x".repeat(101)]) {
      expect(pageShopId(req(`?shopId=${encodeURIComponent(bad)}`), developer), bad).toBeNull();
      expect(pageShopId(req(), developer, bad), `form ${bad}`).toBeNull();
    }
  });
});

describe("withShopId: links keep the developer's shop", () => {
  it("adds shopId to a bare path", () => {
    expect(withShopId("/admin/staff", "shop-1")).toBe("/admin/staff?shopId=shop-1");
  });

  it("keeps an existing query and hash", () => {
    expect(withShopId("/admin/revenue?year=2026&month=7#top", "shop-1")).toBe(
      "/admin/revenue?year=2026&month=7&shopId=shop-1#top",
    );
  });

  it("replaces a shopId already on the link", () => {
    expect(withShopId("/admin?shopId=old", "shop-1")).toBe("/admin?shopId=shop-1");
  });

  it("only admin destinations take it", () => {
    expect(isAdminHref("/admin")).toBe(true);
    expect(isAdminHref("/admin/staff")).toBe(true);
    expect(isAdminHref("/admin?x=1")).toBe(true);
    expect(isAdminHref("/administrator")).toBe(false);
    expect(isAdminHref("/setup/stripe")).toBe(false);
    expect(isAdminHref("/dev/shops")).toBe(false);
  });

  it("leaves the link alone with no shop, or a malformed one", () => {
    expect(withShopId("/admin/staff", null)).toBe("/admin/staff");
    expect(withShopId("/admin/staff", undefined)).toBe("/admin/staff");
    expect(withShopId("/admin/staff", "../x")).toBe("/admin/staff");
  });
});
