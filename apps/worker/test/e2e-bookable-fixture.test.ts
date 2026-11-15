import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { E2E_BOOKABLE_ADDRESS, E2E_BOOKABLE_SLUG, ensureE2eBookableShop } from "../src/db/queries";

// The staging E2E fixture shop has an address, so its pages show the Google
// map behind the visitor's consent (tests/e2e/map-consent.spec.ts). The public
// settings endpoint reads shop_settings, so that is where the address lives.

async function fixtureAddresses(): Promise<Array<string | null>> {
  const { results } = await env.DB.prepare(
    `SELECT ss.address FROM shop_settings ss JOIN shops s ON s.id = ss.shop_id WHERE s.slug = ?`,
  )
    .bind(E2E_BOOKABLE_SLUG)
    .all<{ address: string | null }>();
  return results.map((r) => r.address);
}

describe("E2E bookable fixture shop", () => {
  it("is created with an address", async () => {
    await ensureE2eBookableShop(env.DB);
    expect(await fixtureAddresses()).toEqual([E2E_BOOKABLE_ADDRESS]);
  });

  it("gains the address when the shop was created before addresses were added", async () => {
    await ensureE2eBookableShop(env.DB);
    await env.DB.prepare(
      `DELETE FROM shop_settings WHERE shop_id = (SELECT id FROM shops WHERE slug = ?)`,
    )
      .bind(E2E_BOOKABLE_SLUG)
      .run();
    await ensureE2eBookableShop(env.DB);
    expect(await fixtureAddresses()).toEqual([E2E_BOOKABLE_ADDRESS]);
  });

  it("stays one settings row however often it is ensured", async () => {
    await ensureE2eBookableShop(env.DB);
    await ensureE2eBookableShop(env.DB);
    expect(await fixtureAddresses()).toHaveLength(1);
  });
});
