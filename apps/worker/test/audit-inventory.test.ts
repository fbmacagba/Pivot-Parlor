/** Audit trail Plan 2, Task 5: stock movements, reorder levels, purchase orders
 *  and stock takes. Unconditional writes record in the same batch (Pattern B);
 *  conditional status transitions use a started/outcome pair (Pattern G). */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop } from "./helpers";
import { adminToken, devToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

async function setup() {
  const shopId = await seedShop("Audit Inventory Shop");
  const { token } = await adminToken(shopId);
  return { shopId, headers: authHeaders(token) };
}

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

async function fullRow(id: string, action: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = ? ORDER BY rowid DESC LIMIT 1")
    .bind(id, action)
    .first<Record<string, unknown>>();
  return row!;
}

async function makeProduct(shopId: string, headers: Record<string, string>, name = "Stock Item") {
  const res = await dispatch("POST", `/api/shops/${shopId}/products`, {
    headers,
    body: { name, cost_price_pence: 300, retail_price_pence: 900 },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function quantity(shopId: string, productId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shopId, productId)
    .first<{ quantity: number }>();
  return row ? row.quantity : null;
}

async function makePo(shopId: string, headers: Record<string, string>, productId: string, qty = 5) {
  const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders`, {
    headers,
    body: { items: [{ product_id: productId, quantity: qty, unit_cost_pence: 250 }] },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { id: ((await res.json()) as { data: { id: string } }).data.id, res };
}

function phasesAndOutcomes(rows: Record<string, unknown>[]) {
  return rows.map((r) => [r.phase, r.outcome ?? null]);
}

/** Every audit row one request wrote, oldest first. */
async function rowsForRequest(requestId: string): Promise<Record<string, unknown>[]> {
  expect(requestId, "rowsForRequest needs the response's X-Request-Id").toMatch(/.+/);
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? ORDER BY rowid").bind(requestId).all<Record<string, unknown>>();
  return r.results ?? [];
}

/** Fails if any audit row at all carries `value` in a hashed column. The
 *  caller must have written at least one row first, so this is never vacuous. */
async function expectNoRowCarries(value: string): Promise<void> {
  const all = await env.DB.prepare("SELECT * FROM audit_log").all<Record<string, unknown>>();
  expect(all.results.length, "expectNoRowCarries needs at least one audit row to inspect").toBeGreaterThan(0);
  for (const row of all.results) expectNoPersonalData(row, [value]);
}

/** Caller-supplied URL text that must never reach entity_id or shop_id. */
const SENTINEL = "John-Smith-07700900123";

describe("stock movements and reorder levels", () => {
  it("a manual movement records type and delta with the stock change", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const res = await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: productId, type: "receive", quantity_delta: 12, unit_cost_pence: 250, note: "Delivered by Hortensia" },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const [entry] = await entriesFor({ action: "inventory.movement", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("stock_movement");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({
      product_id: [null, productId],
      type: [null, "receive"],
      quantity_delta: [null, 12],
      unit_cost_pence: [null, 250],
    });
    expectNoPersonalData(await fullRow(id, "inventory.movement"), ["Delivered by Hortensia", "Hortensia"]);
    expect(await quantity(shopId, productId)).toBe(12);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("movement changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
        headers,
        body: { product_id: productId, type: "receive", quantity_delta: 7 },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect(await quantity(shopId, productId)).toBeNull();
  });

  it("reorder records before and after", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const url = `/api/shops/${shopId}/inventory/reorder`;
    const first = await dispatch("PUT", url, { headers, body: { product_id: productId, reorder_point: 3, reorder_qty: 10 } });
    expect(first.status).toBe(200);
    const second = await dispatch("PUT", url, { headers, body: { product_id: productId, reorder_point: 5, reorder_qty: 10 } });
    expect(second.status).toBe(200);
    const entries = await entriesFor({ action: "inventory.reorder", shopId, entityId: productId });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.entity_type).toBe("stock_level");
    expect(entries[0]!.outcome).toBe("succeeded");
    expect(entries[0]!.phase).toBe("done");
    expect(JSON.parse(entries[0]!.changes_json as string)).toEqual({ reorder_point: [null, 3], reorder_qty: [null, 10] });
    expect(JSON.parse(entries[1]!.changes_json as string)).toEqual({ reorder_point: [3, 5] });
    expect(await gapRowsFor(rid(first))).toBe(0);
    expect(await gapRowsFor(rid(second))).toBe(0);
  });

  it("reorder for a variant is keyed by the variant id", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const v = await dispatch("POST", `/api/shops/${shopId}/products/${productId}/variants`, { headers, body: { name: "Big" } });
    const variantId = ((await v.json()) as { data: { id: string } }).data.id;
    const res = await dispatch("PUT", `/api/shops/${shopId}/inventory/reorder`, {
      headers,
      body: { product_id: productId, variant_id: variantId, reorder_point: 2, reorder_qty: 4 },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "inventory.reorder", shopId, entityId: variantId });
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ reorder_point: [null, 2], reorder_qty: [null, 4] });
  });

  it("reorder changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const res = await withAuditOff(() =>
      dispatch("PUT", `/api/shops/${shopId}/inventory/reorder`, {
        headers,
        body: { product_id: productId, reorder_point: 1, reorder_qty: 1 },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_levels WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("purchase orders", () => {
  it("PO create records item count", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const supplier = await dispatch("POST", `/api/shops/${shopId}/suppliers`, { headers, body: { name: "Acme Wholesale" } });
    const supplierId = ((await supplier.json()) as { data: { id: string } }).data.id;
    const note = "Please deliver to Ottoline";
    const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders`, {
      headers,
      body: {
        supplier_id: supplierId,
        notes: note,
        items: [
          { product_id: productId, quantity: 3 },
          { product_id: productId, quantity: 4 },
        ],
      },
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    const [entry] = await entriesFor({ action: "inventory.po.create", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("purchase_order");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: [null, "draft"] });
    expect(JSON.parse(entry!.details_json as string)).toEqual({ items: 2, supplier_id: supplierId });
    expectNoPersonalData(await fullRow(id, "inventory.po.create"), [note, "Ottoline"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("PO create changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/purchase-orders`, { headers, body: { items: [{ product_id: productId, quantity: 1 }] } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("PO update records item count and field names only", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    const note = "Leave with Bartolome";
    const res = await dispatch("PUT", `/api/shops/${shopId}/purchase-orders/${id}`, {
      headers,
      body: { notes: note, items: [{ product_id: productId, quantity: 9 }] },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "inventory.po.update", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("purchase_order");
    expect(JSON.parse(entry!.details_json as string)).toEqual({ items: 1, fields: ["notes"] });
    expectNoPersonalData(await fullRow(id, "inventory.po.update"), [note, "Bartolome"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("PO order records draft to ordered", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "inventory.po.order", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.entity_type).toBe("purchase_order");
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["draft", "ordered"] });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("PO order on a non-draft stays 400 and records refused", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "Only draft purchase orders can be marked as ordered" });
    const rows = await entriesFor({ action: "inventory.po.order", shopId, entityId: id });
    expect(rows.filter((r) => r.phase === "outcome").map((r) => r.outcome)).toEqual(["succeeded", "refused"]);
  });

  it("a second PO cancel records refused", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    const url = `/api/shops/${shopId}/purchase-orders/${id}/cancel`;
    const first = await dispatch("POST", url, { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });
    const second = await dispatch("POST", url, { headers });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ success: false, error: "Only draft or ordered purchase orders can be cancelled" });
    const rows = await entriesFor({ action: "inventory.po.cancel", shopId, entityId: id });
    const outcomes = rows.filter((r) => r.phase === "outcome");
    expect(outcomes.map((r) => r.outcome)).toEqual(["succeeded", "refused"]);
    expect(outcomes[0]!.reason).toBeNull();
    expect(outcomes[1]!.reason).toBe("HTTP 400");
    expect(JSON.parse(outcomes[0]!.changes_json as string)).toEqual({ status: ["draft", "cancelled"] });
    expect(outcomes[1]!.changes_json).toBeNull();
    expect(rows.filter((r) => r.phase === "started")).toHaveLength(2);
    expect(await gapRowsFor(rid(first))).toBe(0);
    expect(await gapRowsFor(rid(second))).toBe(0);
  });

  it("PO cancel of an ordered PO records ordered to cancelled", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/cancel`, { headers });
    expect(res.status).toBe(200);
    const rows = await entriesFor({ action: "inventory.po.cancel", shopId, entityId: id });
    expect(JSON.parse(rows[1]!.changes_json as string)).toEqual({ status: ["ordered", "cancelled"] });
  });

  it("PO order refuses before changing when the started entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const productId = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, productId);
    const res = await withAuditOff(() => dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers }));
    expect(res.status).toBe(503);
    const row = await env.DB.prepare("SELECT status FROM purchase_orders WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row!.status).toBe("draft");
  });

  it("PO receive records lines and units with the stock movements", async () => {
    const { shopId, headers } = await setup();
    const p1 = await makeProduct(shopId, headers, "Item One");
    const p2 = await makeProduct(shopId, headers, "Item Two");
    const create = await dispatch("POST", `/api/shops/${shopId}/purchase-orders`, {
      headers,
      body: { items: [{ product_id: p1, quantity: 5 }, { product_id: p2, quantity: 8 }] },
    });
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    const items = await env.DB.prepare("SELECT id, product_id FROM purchase_order_items WHERE po_id = ?").bind(id).all<{ id: string; product_id: string }>();
    const itemOf = (pid: string) => items.results.find((i) => i.product_id === pid)!.id;
    const res = await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/receive`, {
      headers,
      body: { lines: [{ item_id: itemOf(p1), quantity: 5 }, { item_id: itemOf(p2), quantity: 2 }] },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [entry] = await entriesFor({ action: "inventory.po.receive", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("purchase_order");
    expect(JSON.parse(entry!.details_json as string)).toEqual({ lines: 2, units: 7 });
    expect(await quantity(shopId, p1)).toBe(5);
    expect(await quantity(shopId, p2)).toBe(2);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("PO receive changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const p1 = await makeProduct(shopId, headers);
    const { id } = await makePo(shopId, headers, p1, 5);
    await dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/order`, { headers });
    const item = await env.DB.prepare("SELECT id FROM purchase_order_items WHERE po_id = ?").bind(id).first<{ id: string }>();
    const res = await withAuditOff(() =>
      dispatch("POST", `/api/shops/${shopId}/purchase-orders/${id}/receive`, {
        headers,
        body: { lines: [{ item_id: item!.id, quantity: 5 }] },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await quantity(shopId, p1)).toBeNull();
    const po = await env.DB.prepare("SELECT status FROM purchase_orders WHERE id = ?").bind(id).first<{ status: string }>();
    expect(po!.status).toBe("ordered");
  });
});

describe("stock takes", () => {
  async function openTake(shopId: string, headers: Record<string, string>) {
    const res = await dispatch("POST", `/api/shops/${shopId}/stock-takes`, { headers, body: { notes: "Counted by Wilhelmina" } });
    expect(res.status, await res.clone().text()).toBe(201);
    return { id: ((await res.json()) as { data: { id: string } }).data.id, res };
  }

  it("stock take open records status", async () => {
    const { shopId, headers } = await setup();
    const { id, res } = await openTake(shopId, headers);
    const [entry] = await entriesFor({ action: "inventory.stock_take.open", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("stock_take");
    expect(JSON.parse(entry!.changes_json as string)).toEqual({ status: [null, "open"] });
    expectNoPersonalData(await fullRow(id, "inventory.stock_take.open"), ["Counted by Wilhelmina", "Wilhelmina"]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("stock take open changes nothing when the entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const res = await withAuditOff(() => dispatch("POST", `/api/shops/${shopId}/stock-takes`, { headers, body: {} }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_takes WHERE shop_id = ?").bind(shopId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("stock take count records the item count", async () => {
    const { shopId, headers } = await setup();
    const p1 = await makeProduct(shopId, headers, "Count A");
    const p2 = await makeProduct(shopId, headers, "Count B");
    const { id } = await openTake(shopId, headers);
    const res = await dispatch("PUT", `/api/shops/${shopId}/stock-takes/${id}/items`, {
      headers,
      body: { items: [{ product_id: p1, counted_qty: 4 }, { product_id: p2, counted_qty: 6 }] },
    });
    expect(res.status).toBe(200);
    const [entry] = await entriesFor({ action: "inventory.stock_take.count", shopId, entityId: id });
    expect(entry).toBeDefined();
    expect(entry!.outcome).toBe("succeeded");
    expect(entry!.phase).toBe("done");
    expect(entry!.entity_type).toBe("stock_take");
    expect(JSON.parse(entry!.details_json as string)).toEqual({ items: 2 });
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("stock take complete records counted and adjusted", async () => {
    const { shopId, headers } = await setup();
    const p1 = await makeProduct(shopId, headers, "Done A");
    const p2 = await makeProduct(shopId, headers, "Done B");
    const { id } = await openTake(shopId, headers);
    // p1 has 3 in stock; counting 3 needs no adjustment. p2 has none; counting 6 adjusts.
    await dispatch("POST", `/api/shops/${shopId}/inventory/movements`, {
      headers,
      body: { product_id: p1, type: "receive", quantity_delta: 3 },
    });
    await dispatch("PUT", `/api/shops/${shopId}/stock-takes/${id}/items`, {
      headers,
      body: { items: [{ product_id: p1, counted_qty: 3 }, { product_id: p2, counted_qty: 6 }] },
    });
    const res = await dispatch("POST", `/api/shops/${shopId}/stock-takes/${id}/complete`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ items_counted: 2, items_adjusted: 1 });
    const rows = await entriesFor({ action: "inventory.stock_take.complete", shopId, entityId: id });
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    expect(rows[1]!.entity_type).toBe("stock_take");
    expect(rows[1]!.parent_id).toBe(rows[0]!.id);
    expect(rows[1]!.changes_json).toBeNull();
    expect(JSON.parse(rows[1]!.details_json as string)).toEqual({ items_counted: 2, items_adjusted: 1 });
    expect(await quantity(shopId, p2)).toBe(6);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a second stock take complete records refused and adjusts nothing twice", async () => {
    const { shopId, headers } = await setup();
    const p1 = await makeProduct(shopId, headers);
    const { id } = await openTake(shopId, headers);
    await dispatch("PUT", `/api/shops/${shopId}/stock-takes/${id}/items`, { headers, body: { items: [{ product_id: p1, counted_qty: 5 }] } });
    const url = `/api/shops/${shopId}/stock-takes/${id}/complete`;
    expect((await dispatch("POST", url, { headers })).status).toBe(200);
    const second = await dispatch("POST", url, { headers });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ success: false, error: "This stock take is not open" });
    const outcomes = (await entriesFor({ action: "inventory.stock_take.complete", shopId, entityId: id })).filter((r) => r.phase === "outcome");
    expect(outcomes.map((r) => r.outcome)).toEqual(["succeeded", "refused"]);
    expect(outcomes[1]!.reason).toBe("HTTP 400");
    expect(await quantity(shopId, p1)).toBe(5);
  });

  it("stock take complete refuses before claiming when the started entry cannot be written", async () => {
    const { shopId, headers } = await setup();
    const { id } = await openTake(shopId, headers);
    const res = await withAuditOff(() => dispatch("POST", `/api/shops/${shopId}/stock-takes/${id}/complete`, { headers }));
    expect(res.status).toBe(503);
    const row = await env.DB.prepare("SELECT status FROM stock_takes WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row!.status).toBe("open");
  });

  it("stock take cancel records open to cancelled, then refused", async () => {
    const { shopId, headers } = await setup();
    const { id } = await openTake(shopId, headers);
    const url = `/api/shops/${shopId}/stock-takes/${id}/cancel`;
    const first = await dispatch("POST", url, { headers });
    expect(first.status).toBe(200);
    const second = await dispatch("POST", url, { headers });
    expect(second.status).toBe(400);
    const rows = await entriesFor({ action: "inventory.stock_take.cancel", shopId, entityId: id });
    const outcomes = rows.filter((r) => r.phase === "outcome");
    expect(outcomes.map((r) => r.outcome)).toEqual(["succeeded", "refused"]);
    expect(outcomes[1]!.reason).toBe("HTTP 400");
    expect(outcomes[0]!.entity_type).toBe("stock_take");
    expect(JSON.parse(outcomes[0]!.changes_json as string)).toEqual({ status: ["open", "cancelled"] });
    expect(await gapRowsFor(rid(first))).toBe(0);
  });
});

describe("guarded transitions read the row before recording", () => {
  const ROUTES = [
    { kind: "po", op: "order", error: "Only draft purchase orders can be marked as ordered" },
    { kind: "po", op: "cancel", error: "Only draft or ordered purchase orders can be cancelled" },
    { kind: "stock_take", op: "complete", error: "This stock take is not open" },
    { kind: "stock_take", op: "cancel", error: "This stock take is not open" },
  ] as const;

  /** A real row for the route's kind (its creation writes audit rows too). */
  async function realRow(kind: "po" | "stock_take", shopId: string, headers: Record<string, string>) {
    if (kind === "po") {
      const productId = await makeProduct(shopId, headers);
      return { base: "purchase-orders", id: (await makePo(shopId, headers, productId)).id };
    }
    const res = await dispatch("POST", `/api/shops/${shopId}/stock-takes`, { headers, body: {} });
    expect(res.status, await res.clone().text()).toBe(201);
    return { base: "stock-takes", id: ((await res.json()) as { data: { id: string } }).data.id };
  }

  for (const { kind, op, error } of ROUTES) {
    it(`${kind} ${op}: an unknown id answers as before and records nothing`, async () => {
      const { shopId, headers } = await setup();
      const { base } = await realRow(kind, shopId, headers);
      const res = await dispatch("POST", `/api/shops/${shopId}/${base}/${SENTINEL}/${op}`, { headers });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error });
      expect(await rowsForRequest(rid(res))).toEqual([]);
      await expectNoRowCarries(SENTINEL);
    });

    it(`${kind} ${op}: a developer's unknown shop id answers as before and records nothing`, async () => {
      const { shopId, headers } = await setup();
      const { base, id } = await realRow(kind, shopId, headers);
      const dev = authHeaders((await devToken()).token);
      const res = await dispatch("POST", `/api/shops/${SENTINEL}/${base}/${id}/${op}`, { headers: dev });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error });
      expect(await rowsForRequest(rid(res))).toEqual([]);
      await expectNoRowCarries(SENTINEL);
    });

    it(`${kind} ${op}: a success records the shop's real id and the row's id`, async () => {
      const { shopId, headers } = await setup();
      const { base, id } = await realRow(kind, shopId, headers);
      const res = await dispatch("POST", `/api/shops/${shopId}/${base}/${id}/${op}`, { headers });
      expect(res.status, await res.clone().text()).toBe(200);
      const rows = await rowsForRequest(rid(res));
      expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
      for (const row of rows) {
        expect(row.shop_id).toBe(shopId);
        expect(row.entity_id).toBe(id);
      }
    });
  }
});
