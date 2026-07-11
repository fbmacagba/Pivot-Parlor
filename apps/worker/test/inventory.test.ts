/**
 * WS-3 Phase 0: catalogue + stock foundation.
 *
 * The suite setup replays the full migration chain, so these tests also prove
 * migration 034 stays replayable. Acceptance (audit §D / handover WS-3 P0):
 * CRUD a product/variant with SKU, adjust stock via movements, low-stock view.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, seedStaff, tokenFor, authHeaders } from "./helpers";

type Body<T> = { success: boolean; data: T; error?: string };

async function adminFor(shopId: string): Promise<Record<string, string>> {
  const userId = await seedUser("admin", shopId);
  return authHeaders(await tokenFor(userId, "admin", shopId));
}

async function staffHeadersFor(shopId: string): Promise<Record<string, string>> {
  const staffId = await seedStaff(shopId);
  const row = await env.DB.prepare("SELECT user_id FROM staff WHERE id = ?")
    .bind(staffId)
    .first<{ user_id: string }>();
  return authHeaders(await tokenFor(row!.user_id, "staff", shopId));
}

async function createProduct(
  shopId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<Response> {
  return dispatch("POST", `/api/shops/${shopId}/products`, { headers, body });
}

describe("product catalogue", () => {
  it("admin can create, read, update and soft-delete a product with a SKU", async () => {
    const shopId = await seedShop("Catalogue Shop");
    const headers = await adminFor(shopId);

    const created = await createProduct(shopId, headers, {
      name: "Sea Salt Spray",
      sku: "SSS-250",
      brand: "Coastal",
      cost_price_pence: 450,
      retail_price_pence: 1200,
      tax_rate_bps: 2000,
    });
    expect(created.status).toBe(201);
    const product = ((await created.json()) as Body<{ id: string; sku: string; retail_price_pence: number }>).data;
    expect(product.sku).toBe("SSS-250");
    expect(product.retail_price_pence).toBe(1200);

    const updated = await dispatch("PUT", `/api/shops/${shopId}/products/${product.id}`, {
      headers,
      body: { retail_price_pence: 1350 },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as Body<{ retail_price_pence: number }>).data.retail_price_pence).toBe(1350);

    const deleted = await dispatch("DELETE", `/api/shops/${shopId}/products/${product.id}`, { headers });
    expect(deleted.status).toBe(200);

    const list = await dispatch("GET", `/api/shops/${shopId}/products`, { headers });
    const rows = ((await list.json()) as Body<Array<{ id: string }>>).data;
    expect(rows.find((r) => r.id === product.id)).toBeUndefined();
  });

  it("rejects a missing name and non-integer money", async () => {
    const shopId = await seedShop("Validation Shop");
    const headers = await adminFor(shopId);

    expect((await createProduct(shopId, headers, { sku: "X" })).status).toBe(400);
    expect(
      (await createProduct(shopId, headers, { name: "Oil", retail_price_pence: 12.5 })).status
    ).toBe(400);
    expect(
      (await createProduct(shopId, headers, { name: "Oil", tax_rate_bps: 20000 })).status
    ).toBe(400);
  });

  it("SKU is unique per shop but reusable across shops", async () => {
    const shopA = await seedShop("Sku Shop A");
    const shopB = await seedShop("Sku Shop B");
    const headersA = await adminFor(shopA);
    const headersB = await adminFor(shopB);

    expect((await createProduct(shopA, headersA, { name: "Wax", sku: "WAX-01" })).status).toBe(201);
    const dup = await createProduct(shopA, headersA, { name: "Other Wax", sku: "WAX-01" });
    expect(dup.status).toBe(409);
    expect((await createProduct(shopB, headersB, { name: "Wax", sku: "WAX-01" })).status).toBe(201);
  });

  it("supports variants with their own SKU and pricing", async () => {
    const shopId = await seedShop("Variant Shop");
    const headers = await adminFor(shopId);
    const product = (
      (await (await createProduct(shopId, headers, { name: "Shampoo", retail_price_pence: 900 })).json()) as Body<{ id: string }>
    ).data;

    const created = await dispatch("POST", `/api/shops/${shopId}/products/${product.id}/variants`, {
      headers,
      body: { name: "500ml", sku: "SHAM-500", retail_price_pence: 1500 },
    });
    expect(created.status).toBe(201);
    const variant = ((await created.json()) as Body<{ id: string; retail_price_pence: number }>).data;
    expect(variant.retail_price_pence).toBe(1500);

    // Variant with no explicit price inherits the product's pricing.
    const inherited = await dispatch("POST", `/api/shops/${shopId}/products/${product.id}/variants`, {
      headers,
      body: { name: "250ml" },
    });
    expect(((await inherited.json()) as Body<{ retail_price_pence: number }>).data.retail_price_pence).toBe(900);

    const detail = await dispatch("GET", `/api/shops/${shopId}/products/${product.id}`, { headers });
    const withVariants = ((await detail.json()) as Body<{ variants: unknown[] }>).data;
    expect(withVariants.variants).toHaveLength(2);
  });

  it("scopes categories to the shop that owns them", async () => {
    const shopA = await seedShop("Cat Shop A");
    const shopB = await seedShop("Cat Shop B");
    const headersA = await adminFor(shopA);
    const headersB = await adminFor(shopB);

    const cat = await dispatch("POST", `/api/shops/${shopA}/products/categories`, {
      headers: headersA,
      body: { name: "Styling" },
    });
    expect(cat.status).toBe(201);
    const categoryId = ((await cat.json()) as Body<{ id: string }>).data.id;

    // Shop B cannot hang a product on shop A's category.
    const cross = await createProduct(shopB, headersB, { name: "Gel", category_id: categoryId });
    expect(cross.status).toBe(400);
  });
});

describe("stock movements", () => {
  it("receive then adjust updates the level and records the trail", async () => {
    const shopId = await seedShop("Stock Shop");
    const headers = await adminFor(shopId);
    const product = (
      (await (await createProduct(shopId, headers, { name: "Pomade", sku: "POM-1" })).json()) as Body<{ id: string }>
    ).data;

    const receive = await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, type: "receive", quantity_delta: 10, unit_cost_pence: 300 },
    });
    expect(receive.status).toBe(201);

    const adjust = await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, type: "adjustment", quantity_delta: -4, note: "stock take" },
    });
    expect(adjust.status).toBe(201);

    const detail = await dispatch("GET", `/api/shops/${shopId}/products/${product.id}`, { headers });
    const stock = ((await detail.json()) as Body<{ stock: Array<{ quantity: number }> }>).data.stock;
    expect(stock).toHaveLength(1);
    expect(stock[0]!.quantity).toBe(6);

    const history = await dispatch(
      "GET",
      `/api/shops/${shopId}/inventory/movements?product_id=${product.id}`,
      { headers }
    );
    const movements = ((await history.json()) as Body<Array<{ type: string; quantity_delta: number }>>).data;
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.type).sort()).toEqual(["adjustment", "receive"]);
  });

  it("tracks variant stock separately and sums it in the product list", async () => {
    const shopId = await seedShop("Variant Stock Shop");
    const headers = await adminFor(shopId);
    const product = (
      (await (await createProduct(shopId, headers, { name: "Conditioner" })).json()) as Body<{ id: string }>
    ).data;
    const variant = (
      (await (
        await dispatch("POST", `/api/shops/${shopId}/products/${product.id}/variants`, {
          headers,
          body: { name: "1L" },
        })
      ).json()) as Body<{ id: string }>
    ).data;

    await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, type: "receive", quantity_delta: 5 },
    });
    await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, variant_id: variant.id, type: "receive", quantity_delta: 7 },
    });

    const detail = await dispatch("GET", `/api/shops/${shopId}/products/${product.id}`, { headers });
    const stock = ((await detail.json()) as Body<{ stock: Array<{ variant_id: string | null; quantity: number }> }>).data.stock;
    expect(stock).toHaveLength(2);
    expect(stock.find((s) => s.variant_id === null)?.quantity).toBe(5);
    expect(stock.find((s) => s.variant_id === variant.id)?.quantity).toBe(7);

    const list = await dispatch("GET", `/api/shops/${shopId}/products`, { headers });
    const row = ((await list.json()) as Body<Array<{ id: string; total_quantity: number }>>).data.find(
      (r) => r.id === product.id
    );
    expect(row?.total_quantity).toBe(12);
  });

  it("refuses reserved movement types, zero deltas and cross-shop products", async () => {
    const shopA = await seedShop("Move Shop A");
    const shopB = await seedShop("Move Shop B");
    const headersA = await adminFor(shopA);
    const headersB = await adminFor(shopB);
    const product = (
      (await (await createProduct(shopA, headersA, { name: "Tonic" })).json()) as Body<{ id: string }>
    ).data;

    // 'sale' is written by the POS flow (Phase 1), never manually.
    const sale = await dispatch("POST", `/api/shops/${shopA}/inventory/movements`, {
      headers: headersA,
      body: { product_id: product.id, type: "sale", quantity_delta: -1 },
    });
    expect(sale.status).toBe(400);

    const zero = await dispatch("POST", `/api/shops/${shopA}/inventory/movements`, {
      headers: headersA,
      body: { product_id: product.id, type: "adjustment", quantity_delta: 0 },
    });
    expect(zero.status).toBe(400);

    // Shop B's admin is Forbidden on shop A's inventory outright…
    const forbidden = await dispatch("POST", `/api/shops/${shopA}/inventory/movements`, {
      headers: headersB,
      body: { product_id: product.id, type: "receive", quantity_delta: 1 },
    });
    expect(forbidden.status).toBe(403);

    // …and cannot smuggle shop A's product id into their own shop's endpoint.
    const smuggled = await dispatch("POST", `/api/shops/${shopB}/inventory/movements`, {
      headers: headersB,
      body: { product_id: product.id, type: "receive", quantity_delta: 1 },
    });
    expect(smuggled.status).toBe(404);
  });
});

describe("low stock", () => {
  it("flags out-of-stock and at-reorder-point rows, and clears once restocked", async () => {
    const shopId = await seedShop("Low Stock Shop");
    const headers = await adminFor(shopId);
    const product = (
      (await (await createProduct(shopId, headers, { name: "Beard Oil", sku: "BO-1" })).json()) as Body<{ id: string }>
    ).data;

    await dispatch("PUT", `/api/shops/${shopId}/inventory/reorder`, {
      headers,
      body: { product_id: product.id, reorder_point: 5, reorder_qty: 20 },
    });

    // quantity 0 (reorder row starts at 0) → out of stock.
    let low = await dispatch("GET", `/api/shops/${shopId}/inventory/low-stock`, { headers });
    let rows = ((await low.json()) as Body<Array<{ product_id: string; quantity: number }>>).data;
    expect(rows.some((r) => r.product_id === product.id)).toBe(true);

    // Restock above the reorder point → clears.
    await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, type: "receive", quantity_delta: 8 },
    });
    low = await dispatch("GET", `/api/shops/${shopId}/inventory/low-stock`, { headers });
    rows = ((await low.json()) as Body<Array<{ product_id: string }>>).data;
    expect(rows.some((r) => r.product_id === product.id)).toBe(false);

    // Drop to the reorder point exactly → flagged again.
    await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: product.id, type: "waste", quantity_delta: -3 },
    });
    low = await dispatch("GET", `/api/shops/${shopId}/inventory/low-stock`, { headers });
    rows = ((await low.json()) as Body<Array<{ product_id: string; quantity: number }>>).data;
    const flagged = rows.find((r) => r.product_id === product.id);
    expect(flagged?.quantity).toBe(5);
  });
});

describe("access control", () => {
  it("staff can read but not mutate; anonymous is rejected", async () => {
    const shopId = await seedShop("RBAC Shop");
    const admin = await adminFor(shopId);
    const staff = await staffHeadersFor(shopId);
    const product = (
      (await (await createProduct(shopId, admin, { name: "Clay" })).json()) as Body<{ id: string }>
    ).data;

    const staffList = await dispatch("GET", `/api/shops/${shopId}/products`, { headers: staff });
    expect(staffList.status).toBe(200);
    expect(
      ((await staffList.json()) as Body<Array<{ id: string }>>).data.some((r) => r.id === product.id)
    ).toBe(true);

    expect((await createProduct(shopId, staff, { name: "Nope" })).status).toBe(403);
    const anon = await dispatch("GET", `/api/shops/${shopId}/products`);
    expect(anon.status).toBe(401);
  });

  it("a developer can manage any shop's catalogue", async () => {
    const shopId = await seedShop("Dev Access Shop");
    const devId = await seedUser("developer", null);
    const dev = authHeaders(await tokenFor(devId, "developer", null));

    expect((await createProduct(shopId, dev, { name: "Dev Product" })).status).toBe(201);
    expect((await dispatch("GET", `/api/shops/${shopId}/inventory/low-stock`, { headers: dev })).status).toBe(200);
  });
});

describe("migration 034", () => {
  it("gives shops a GBP currency default", async () => {
    const shopId = await seedShop("Currency Shop");
    const row = await env.DB.prepare("SELECT currency FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ currency: string }>();
    expect(row?.currency).toBe("GBP");
  });
});
