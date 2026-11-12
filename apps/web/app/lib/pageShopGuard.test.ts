import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every admin page decides "which shop is this page for" through one helper,
// pageShopId (app/lib/pageShop.ts): the admin's own shop, or the developer's
// ?shopId=. Pages that read the session's shop_id themselves gave a developer
// an empty page (analytics returned no data, settings said "No shop is
// assigned") because a developer session has no shop of its own. The POS
// helper (app/lib/pos.ts) serves /admin/pos and /staff/pos and follows the
// same rule.
//
// vitest runs with cwd at the app root (apps/web); the "discovers" assertion
// fails loudly if that stops holding.
const appDir = path.resolve(process.cwd(), "app");
const routesDir = path.join(appDir, "routes");

/** Ways of reading the session's own shop instead of asking pageShopId. */
const OWN_SHOP_READS: Array<[RegExp, string]> = [
  [/\buser\??\.shop_id\b/, "reads user.shop_id"],
  [/\{[^}]*\bshop_id\b[^}]*\}\s*=\s*user\b/, "destructures shop_id from user"],
  [/searchParams\.get\(\s*["']shopId["']\s*\)/, "reads ?shopId= itself"],
];

/** What is wrong with a file's source, or [] when it follows the rule. */
export function shopReadProblems(src: string): string[] {
  return OWN_SHOP_READS.filter(([re]) => re.test(src)).map(([, why]) => why);
}

// The admin pages, the shop-scoped API proxies their client code calls
// (api.shops.$shopId.*), and the POS helper.
const files = [
  ...readdirSync(routesDir)
    .filter((f) => /^(admin(\.|$)|api\.shops\.\$shopId\.)/.test(f) && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => path.join("routes", f)),
  path.join("lib", "pos.ts"),
];

describe("admin pages ask pageShopId which shop they are for", () => {
  it("discovers the admin pages", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain(path.join("routes", "admin.analytics.tsx"));
    expect(files).toContain(path.join("routes", "api.shops.$shopId.walkin-poll.tsx"));
  });

  it("flags each way of reading the session's shop (control)", () => {
    expect(shopReadProblems("const shopId = user.shop_id;")).toEqual(["reads user.shop_id"]);
    expect(shopReadProblems("if (!user?.shop_id) return;")).toEqual(["reads user.shop_id"]);
    expect(shopReadProblems("const { role, shop_id } = user;")).toEqual(["destructures shop_id from user"]);
    expect(shopReadProblems('const q = url.searchParams.get("shopId");')).toEqual(["reads ?shopId= itself"]);
  });

  it("passes a page that uses the helper (control)", () => {
    expect(shopReadProblems("const shopId = pageShopId(request, user);\nrow.shop_id;")).toEqual([]);
  });

  it("no admin page or the POS helper reads the shop any other way", () => {
    const failing = files.flatMap((f) =>
      shopReadProblems(readFileSync(path.join(appDir, f), "utf8")).map((p) => `${f}: ${p}`),
    );
    expect(failing).toEqual([]);
  });
});
