/** Audit trail Plan 2, Task 4: products, variants, categories and suppliers
 *  record their entry in the same batch as the change (Pattern B). */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop } from "./helpers";
import { adminToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

async function setup() {
  const shopId = await seedShop("Audit Products Shop");
  const { token } = await adminToken(shopId);
  return { shopId, headers: authHeaders(token) };
}

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

async function fullRow(id: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM audit_log WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1")
    .bind(id)
    .first<Record<string, unknown>>();
  return row!;
}

async function makeProduct(shopId: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await dispatch("POST", `/api/shops/${shopId}/products`, { headers, body });
  expect(res.status, await res.clone().text()).toBe(201);
  return { id: ((await res.json()) as { data: { id: string } }).data.id, res };
}

describe("products", () => {
  it("product create records its pence fields", async () => {
    const { shopId, headers } = await setup();
    const { id, res } = await makeProduct(shopId, headers, {
      name: "Matte Clay",
      retail_price_pence: 1200,
      sku: "CLAY-1",
      description: "Blended by Fenella",
    });
    const [entry] = await entriesFor({ action: "product.create", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("product");
    const changes = JSON.parse(entry!.changes_json as string);
    expect(changes.retail_price_pence).toEqual([null, 1200]);
    expect(changes.sku).toEqual([null, "CLAY-1"]);
    expectNoPersonalData(await fullRow(id), ["Blended by Fenella", "Fenella"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("product price change records pence before and after", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Pomade", retail_price_pence: 1200 });
    const res = await dispatch("PUT", `/api/shops/${shopId}/products/${id}`, {
      headers,
      body: { retail_price_pence: 1500, not_a_column: "x" },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("product");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ retail_price_pence: [1200, 1500] });
    // A body key that is not a column never appears.
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["retail_price_pence"] });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("product description change records the field name only", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Beard Oil" });
    const description = "Hand blended with cedarwood by Ludovic";
    const res = await dispatch("PUT", `/api/shops/${shopId}/products/${id}`, { headers, body: { description } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.update", shopId, entityId: id });
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["description"] });
    expectNoPersonalData(await fullRow(id), [description, "Ludovic"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a product update that changes nothing still records its entry", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Wax", retail_price_pence: 900 });
    const res = await dispatch("PUT", `/api/shops/${shopId}/products/${id}`, { headers, body: { retail_price_pence: 900 } });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.changes_json).toBeNull();
    expect(entry!.details_json).toBeNull();
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("duplicate SKU still answers 409 and writes no entry and no gap", async () => {
    const { shopId, headers } = await setup();
    await makeProduct(shopId, headers, { name: "First", sku: "DUP-1" });
    const before = (await entriesFor({ action: "product.create", shopId })).length;
    const res = await dispatch("POST", `/api/shops/${shopId}/products`, { headers, body: { name: "Second", sku: "DUP-1" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "SKU already in use in this shop" });
    expect((await entriesFor({ action: "product.create", shopId })).length).toBe(before);
    const forRequest = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE request_id = ?")
      .bind(rid(res))
      .first<{ n: number }>();
    expect(forRequest!.n).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("duplicate SKU on update answers 409 and leaves the product unchanged", async () => {
    const { shopId, headers } = await setup();
    await makeProduct(shopId, headers, { name: "A", sku: "SKU-A" });
    const { id } = await makeProduct(shopId, headers, { name: "B", sku: "SKU-B" });
    const res = await dispatch("PUT", `/api/shops/${shopId}/products/${id}`, { headers, body: { sku: "SKU-A" } });
    expect(res.status).toBe(409);
    expect((await entriesFor({ action: "product.update", shopId, entityId: id })).length).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("product create changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/products`, { headers, body: { name: "Ghost Product" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("product update changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Stays", retail_price_pence: 100 });
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/products/${id}`, { headers, body: { retail_price_pence: 999 } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT retail_price_pence FROM products WHERE id = ?").bind(id).first<{ retail_price_pence: number }>();
    expect(row!.retail_price_pence).toBe(100);
  });

  it("product delete records is_active 1 to 0", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Doomed" });
    const res = await dispatch("DELETE", `/api/shops/${shopId}/products/${id}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.delete", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("product");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [1, 0] });
    const row = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(id).first<{ is_active: number }>();
    expect(row!.is_active).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("deleting an already inactive product records no change", async () => {
    const { shopId, headers } = await setup();
    const { id } = await makeProduct(shopId, headers, { name: "Already gone" });
    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(id).run();
    const res = await dispatch("DELETE", `/api/shops/${shopId}/products/${id}`, { headers });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.delete", shopId, entityId: id });
    expect(entry!.changes_json).toBeNull();
  });
});

describe("variants", () => {
  it("variant create records its product", async () => {
    const { shopId, headers } = await setup();
    const { id: productId } = await makeProduct(shopId, headers, { name: "Shampoo", retail_price_pence: 800 });
    const res = await dispatch("POST", `/api/shops/${shopId}/products/${productId}/variants`, {
      headers,
      body: { name: "500ml bottle", sku: "SH-500" },
    });
    expect(res.status).toBe(201);
    const variantId = ((await res.json()) as { data: { id: string } }).data.id;
    const [entry] = await entriesFor({ action: "product.create", shopId, entityId: variantId });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("product_variant");
    expect(JSON.parse(entry!.details_json as string)).toEqual({ product_id: productId });
    expect(JSON.parse(entry!.changes_json as string).retail_price_pence).toEqual([null, 800]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("variant update, duplicate SKU and delete", async () => {
    const { shopId, headers } = await setup();
    const { id: productId } = await makeProduct(shopId, headers, { name: "Gel" });
    const base = `/api/shops/${shopId}/products/${productId}/variants`;
    const mk = async (name: string, sku: string) =>
      ((await (await dispatch("POST", base, { headers, body: { name, sku, retail_price_pence: 500 } })).json()) as {
        data: { id: string };
      }).data.id;
    const v1 = await mk("Small", "G-S");
    await mk("Large", "G-L");

    const up = await dispatch("PUT", `${base}/${v1}`, { headers, body: { retail_price_pence: 650, junk: 1 } });
    expect(up.status).toBe(200);
    const [upd] = await entriesFor({ action: "product.update", shopId, entityId: v1 });
    expect(upd!.entity_type).toBe("product_variant");
    expect(upd!.phase).toBe("done");
    expect(JSON.parse(upd!.changes_json as string)).toEqual({ retail_price_pence: [500, 650] });
    expect(JSON.parse(upd!.details_json as string)).toEqual({ fields: ["retail_price_pence"] });
    expect(await gapRowsFor(rid(up))).toBe(0);

    const dup = await dispatch("PUT", `${base}/${v1}`, { headers, body: { sku: "G-L" } });
    expect(dup.status).toBe(409);
    expect(await gapRowsFor(rid(dup))).toBe(0);
    expect((await entriesFor({ action: "product.update", shopId, entityId: v1 })).length).toBe(1);

    const del = await dispatch("DELETE", `${base}/${v1}`, { headers });
    expect(del.status).toBe(200);
    const [d] = await entriesFor({ action: "product.delete", shopId, entityId: v1 });
    expect(d!.entity_type).toBe("product_variant");
    expect(JSON.parse(d!.changes_json as string)).toEqual({ is_active: [1, 0] });
    expect(await gapRowsFor(rid(del))).toBe(0);
  });

  it("variant create changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id: productId } = await makeProduct(shopId, headers, { name: "Spray" });
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/products/${productId}/variants`, { headers, body: { name: "Ghost variant" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?").bind(productId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("categories", () => {
  it("category create and rename record name", async () => {
    const { shopId, headers } = await setup();
    const created = await dispatch("POST", `/api/shops/${shopId}/products/categories`, { headers, body: { name: "Hair care" } });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const [c] = await entriesFor({ action: "product.create", shopId, entityId: id });
    expect(c!.entity_type).toBe("product_category");
    expect(c!.phase).toBe("done");
    expect(JSON.parse(c!.changes_json as string)).toEqual({ name: [null, "Hair care"], sort_order: [null, 0] });
    expect(await gapRowsFor(rid(created))).toBe(0);

    const res = await dispatch("PUT", `/api/shops/${shopId}/products/categories/${id}`, {
      headers,
      body: { name: "Styling", stray: true },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "product.update", shopId, entityId: id });
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("product_category");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ name: ["Hair care", "Styling"] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["name"] });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("category rename changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const created = await dispatch("POST", `/api/shops/${shopId}/products/categories`, { headers, body: { name: "Keep" } });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/products/categories/${id}`, { headers, body: { name: "Lost" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT name FROM product_categories WHERE id = ?").bind(id).first<{ name: string }>();
    expect(row!.name).toBe("Keep");
  });
});

describe("suppliers", () => {
  it("supplier create records no name, email or phone", async () => {
    const { shopId, headers } = await setup();
    const name = "Bartholomew Supplies Ltd";
    const email = `orders-${crypto.randomUUID()}@bartholomew.test`;
    const phone = "07700 900123";
    const notes = "Ask for Gwendolyn";
    const res = await dispatch("POST", `/api/shops/${shopId}/suppliers`, { headers, body: { name, email, phone, notes } });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const [entry] = await entriesFor({ action: "inventory.supplier.create", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("supplier");
    expect(entry!.changes_json).toBeNull();
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["email", "name", "notes", "phone"] });
    expectNoPersonalData(await fullRow(id), [name, email, phone, notes, "Gwendolyn"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("supplier update records field names, and is_active as a change", async () => {
    const { shopId, headers } = await setup();
    const created = await dispatch("POST", `/api/shops/${shopId}/suppliers`, { headers, body: { name: "Old Name Co" } });
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await dispatch("PUT", `/api/shops/${shopId}/suppliers/${id}`, {
      headers,
      body: { name: "Newer Name Co", is_active: 0 },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "inventory.supplier.update", shopId, entityId: id });
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("supplier");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ is_active: [1, 0] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ fields: ["is_active", "name"] });
    expectNoPersonalData(await fullRow(id), ["Old Name Co", "Newer Name Co"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("supplier create changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/suppliers`, { headers, body: { name: "Ghost Supplier" } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM suppliers WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});
