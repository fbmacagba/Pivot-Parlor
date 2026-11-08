/** Final review I2: requireShopRole lets developers through without checking
 *  the shop, so a developer's `:shopId` is caller text. It must never reach an
 *  entry's shop_id or entity_id; an unresolved param records shopId null and
 *  details.shop_param "unresolved". Responses are unchanged. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop } from "./helpers";
import { adminToken, devToken, expectNoPersonalData } from "./audit-helpers";

/** Caller-supplied URL text that must never reach shop_id or entity_id. */
const SENTINEL = "John-Smith-07700900123";

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

async function rowsForRequest(requestId: string): Promise<Record<string, unknown>[]> {
  expect(requestId, "rowsForRequest needs the response's X-Request-Id").toMatch(/.+/);
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY rowid").bind(requestId).all<Record<string, unknown>>();
  return r.results ?? [];
}

async function devHeaders(): Promise<Record<string, string>> {
  return authHeaders((await devToken()).token);
}

describe("schedule update with a developer's unknown shop id", () => {
  it("answers as before and records no raw shop param", async () => {
    // Entries with no staff_id validate nothing, so today the request commits.
    const res = await dispatch("PUT", `/api/shops/${SENTINEL}/schedule`, {
      headers: await devHeaders(),
      body: { entries: [{ day_of_week: 1, start_time: "09:00", end_time: "17:00" }] },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: [] });
    const rows = await rowsForRequest(rid(res));
    expect(rows.map((r) => r.action)).toEqual(["schedule.update"]);
    expect(rows[0]!.shop_id).toBeNull();
    expect(rows[0]!.entity_id).toBeNull();
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({
      entries: 0,
      staff_ids: [],
      days_off: 0,
      shop_param: "unresolved",
    });
    expectNoPersonalData(rows[0]!, [SENTINEL]);
  });

  it("a resolved shop records its id and no shop_param", async () => {
    const shopId = await seedShop("Audit Resolved Schedule");
    const res = await dispatch("PUT", `/api/shops/${shopId}/schedule`, {
      headers: authHeaders((await adminToken(shopId)).token),
      body: { entries: [{ day_of_week: 1, start_time: "09:00", end_time: "17:00" }] },
    });
    expect(res.status).toBe(200);
    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shop_id).toBe(shopId);
    expect(rows[0]!.entity_id).toBe(shopId);
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ entries: 0, staff_ids: [], days_off: 0 });
  });
});

describe("creates with a developer's unknown shop id", () => {
  // The FK on shop_id refuses each create in this schema, so the request
  // fails as it always has; the only entry is the gap guard's failed row,
  // which resolves the param itself. These guard the response and the
  // hashed columns; the route-level resolution is defence in depth for a
  // table without the FK (prod's pre-chain tables).
  const CASES = [
    { name: "service create", path: "services", body: { name: "Skin fade", duration_min: 30, price_pence: 2500 } },
    { name: "staff create", path: "staff", body: { display_name: "Staff Person", email: `sp-${crypto.randomUUID()}@quill.test` } },
    { name: "product category create", path: "products/categories", body: { name: "Shampoo" } },
    { name: "supplier create", path: "suppliers", body: { name: "Acme Wholesale" } },
    { name: "stock take open", path: "stock-takes", body: {} },
  ] as const;

  for (const { name, path, body } of CASES) {
    it(`${name}: no row for the request carries the raw shop param`, async () => {
      const res = await dispatch("POST", `/api/shops/${SENTINEL}/${path}`, { headers: await devHeaders(), body });
      expect(res.status, await res.clone().text()).toBe(500);
      const rows = await rowsForRequest(rid(res));
      expect(rows.length, "the gap guard's failed row should exist, so the check below is not vacuous").toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.shop_id).toBeNull();
        expectNoPersonalData(row, [SENTINEL]);
      }
    });
  }
});
