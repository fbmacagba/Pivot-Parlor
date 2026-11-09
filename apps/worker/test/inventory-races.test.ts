/**
 * PO receive, PO edit and stock-take count check the record's status, then
 * write in one D1 batch. A cancel, order, completion or second receipt that
 * commits in between used to let the batch write into a record that no longer
 * accepted it (stock added to a cancelled PO, an ordered PO's lines replaced,
 * a count silently dropped). Each test commits that concurrent write just
 * before the handler's batch runs, then proves the batch rolled back whole:
 * the pre-check's own 400, no stock, no movement, no audit entry.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { entriesFor } from "./audit-helpers";

type Body<T> = { success: boolean; data: T; error?: string };

async function adminFor(shopId: string): Promise<Record<string, string>> {
  return authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
}

async function seedProduct(shopId: string, stock = 0): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO products (id, shop_id, name, cost_price_pence, retail_price_pence, track_stock, is_active)
     VALUES (?, ?, ?, 300, 1000, 1, 1)`
  )
    .bind(id, shopId, `Race product ${id.slice(0, 6)}`)
    .run();
  if (stock > 0) {
    await env.DB.prepare("INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity) VALUES (?, ?, ?, NULL, ?)")
      .bind(crypto.randomUUID(), shopId, id, stock)
      .run();
  }
  return id;
}

async function stockQty(shopId: string, productId: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT quantity FROM stock_levels WHERE shop_id = ? AND product_id = ? AND variant_id IS NULL")
    .bind(shopId, productId)
    .first<{ quantity: number }>();
  return Number(row?.quantity ?? 0);
}

async function movementsFor(referenceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id = ?")
    .bind(referenceId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Send a request whose FIRST DB.batch() is preceded by `concurrent`, a write
 *  committed as another request would have committed it after this handler's
 *  pre-check. Throws if the handler never reached a batch, so a test cannot
 *  pass on a request that was refused before the window it is about. */
async function withConcurrentWrite(
  concurrent: D1PreparedStatement[],
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  let fired = false;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            await target.batch(concurrent);
          }
          return target.batch(stmts);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as typeof env.DB;
  const raceEnv = new Proxy(env, {
    get(target, prop) {
      return prop === "DB" ? db : Reflect.get(target, prop);
    },
  });
  const ctx = createExecutionContext();
  const res = (await worker.fetch(
    new Request(`https://worker.test${path}`, { method, headers, body: JSON.stringify(body) }) as never,
    raceEnv as never,
    ctx as never,
  )) as unknown as Response;
  await waitOnExecutionContext(ctx);
  if (!fired) throw new Error("the handler never reached a batch: the race window was not exercised");
  return res;
}

async function seedPo(shop: string, headers: Record<string, string>, product: string, quantity: number) {
  const created = await dispatch("POST", `/api/shops/${shop}/purchase-orders`, {
    headers,
    body: { items: [{ product_id: product, quantity, unit_cost_pence: 400 }] },
  });
  expect(created.status).toBe(201);
  const poId = ((await created.json()) as Body<{ id: string }>).data.id;
  const item = await env.DB.prepare("SELECT id FROM purchase_order_items WHERE po_id = ?").bind(poId).first<{ id: string }>();
  return { poId, itemId: item!.id };
}

async function poState(poId: string) {
  return env.DB.prepare(
    `SELECT po.status, i.quantity, i.received_qty
       FROM purchase_orders po JOIN purchase_order_items i ON i.po_id = po.id
      WHERE po.id = ?`
  )
    .bind(poId)
    .all<{ status: string; quantity: number; received_qty: number }>()
    .then((r) => r.results ?? []);
}

describe("purchase order receive races", () => {
  it("a receipt racing a cancel adds no stock and leaves the PO cancelled", async () => {
    const shop = await seedShop("Race Receive Cancel");
    const headers = await adminFor(shop);
    const product = await seedProduct(shop);
    const { poId, itemId } = await seedPo(shop, headers, product, 5);
    expect((await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/order`, { headers })).status).toBe(200);

    const res = await withConcurrentWrite(
      [env.DB.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").bind(poId)],
      "POST",
      `/api/shops/${shop}/purchase-orders/${poId}/receive`,
      headers,
      { lines: [{ item_id: itemId, quantity: 5 }] },
    );

    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as Body<null>).error).toBe("Only ordered purchase orders can be received");
    expect(await poState(poId)).toEqual([{ status: "cancelled", quantity: 5, received_qty: 0 }]);
    expect(await stockQty(shop, product)).toBe(0);
    expect(await movementsFor(poId)).toBe(0);
    expect(await entriesFor({ action: "inventory.po.receive", entityId: poId })).toHaveLength(0);
  });

  it("two receipts racing for the same units cannot receive more than was ordered", async () => {
    const shop = await seedShop("Race Receive Twice");
    const headers = await adminFor(shop);
    const product = await seedProduct(shop);
    const { poId, itemId } = await seedPo(shop, headers, product, 5);
    expect((await dispatch("POST", `/api/shops/${shop}/purchase-orders/${poId}/order`, { headers })).status).toBe(200);

    // The other receipt took 3 of the 5 after this one's outstanding check.
    const res = await withConcurrentWrite(
      [
        env.DB.prepare("UPDATE purchase_order_items SET received_qty = 3 WHERE id = ?").bind(itemId),
        env.DB.prepare("UPDATE purchase_orders SET status = 'partial' WHERE id = ?").bind(poId),
      ],
      "POST",
      `/api/shops/${shop}/purchase-orders/${poId}/receive`,
      headers,
      { lines: [{ item_id: itemId, quantity: 3 }] },
    );

    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as Body<null>).error).toMatch(/^Cannot receive 3 of ".+": only 2 outstanding$/);
    expect(await poState(poId)).toEqual([{ status: "partial", quantity: 5, received_qty: 3 }]);
    expect(await stockQty(shop, product)).toBe(0);
    expect(await movementsFor(poId)).toBe(0);
    expect(await entriesFor({ action: "inventory.po.receive", entityId: poId })).toHaveLength(0);
  });
});

describe("purchase order edit race", () => {
  it("an edit racing an order leaves the ordered PO's lines alone", async () => {
    const shop = await seedShop("Race Edit Order");
    const headers = await adminFor(shop);
    const product = await seedProduct(shop);
    const { poId, itemId } = await seedPo(shop, headers, product, 5);

    const res = await withConcurrentWrite(
      [env.DB.prepare("UPDATE purchase_orders SET status = 'ordered' WHERE id = ?").bind(poId)],
      "PUT",
      `/api/shops/${shop}/purchase-orders/${poId}`,
      headers,
      { notes: "late edit", items: [{ product_id: product, quantity: 9 }] },
    );

    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as Body<null>).error).toBe("Only draft purchase orders can be edited");
    expect(await poState(poId)).toEqual([{ status: "ordered", quantity: 5, received_qty: 0 }]);
    const lines = await env.DB.prepare("SELECT id FROM purchase_order_items WHERE po_id = ?").bind(poId).all<{ id: string }>();
    expect(lines.results?.map((l) => l.id)).toEqual([itemId]);
    const header = await env.DB.prepare("SELECT notes FROM purchase_orders WHERE id = ?").bind(poId).first<{ notes: string | null }>();
    expect(header?.notes).toBeNull();
    expect(await entriesFor({ action: "inventory.po.update", entityId: poId })).toHaveLength(0);
  });
});

describe("stock-take count race", () => {
  it("a count racing a completion is refused, not silently dropped", async () => {
    const shop = await seedShop("Race Count Complete");
    const headers = await adminFor(shop);
    const product = await seedProduct(shop, 10);
    const opened = await dispatch("POST", `/api/shops/${shop}/stock-takes`, { headers, body: {} });
    expect(opened.status).toBe(201);
    const stId = ((await opened.json()) as Body<{ id: string }>).data.id;

    const res = await withConcurrentWrite(
      [env.DB.prepare("UPDATE stock_takes SET status = 'completed', completed_at = datetime('now') WHERE id = ?").bind(stId)],
      "PUT",
      `/api/shops/${shop}/stock-takes/${stId}/items`,
      headers,
      { items: [{ product_id: product, counted_qty: 7 }] },
    );

    expect(res.status, await res.clone().text()).toBe(400);
    expect(((await res.json()) as Body<null>).error).toBe("This stock take is no longer open");
    const items = await env.DB.prepare("SELECT COUNT(*) AS n FROM stock_take_items WHERE stock_take_id = ?")
      .bind(stId)
      .first<{ n: number }>();
    expect(Number(items?.n)).toBe(0);
    const st = await env.DB.prepare("SELECT status FROM stock_takes WHERE id = ?").bind(stId).first<{ status: string }>();
    expect(st?.status).toBe("completed");
    expect(await stockQty(shop, product)).toBe(10);
    expect(await entriesFor({ action: "inventory.stock_take.count", entityId: stId })).toHaveLength(0);
  });
});

describe("stock-take open race", () => {
  it("an open racing another open is refused, leaving exactly one open take", async () => {
    const shop = await seedShop("Race Open Twice");
    const headers = await adminFor(shop);
    // The other open committed after this one's "already open?" check.
    const otherId = crypto.randomUUID();

    const res = await withConcurrentWrite(
      [env.DB.prepare("INSERT INTO stock_takes (id, shop_id, status) VALUES (?, ?, 'open')").bind(otherId, shop)],
      "POST",
      `/api/shops/${shop}/stock-takes`,
      headers,
      {},
    );

    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as Body<null> & { open_id?: string };
    expect(body.error).toBe("A stock take is already open. Complete or cancel it first.");
    expect(body.open_id).toBe(otherId);
    const open = await env.DB.prepare("SELECT id FROM stock_takes WHERE shop_id = ? AND status = 'open'")
      .bind(shop)
      .all<{ id: string }>();
    expect(open.results?.map((r) => r.id)).toEqual([otherId]);
    expect(await entriesFor({ action: "inventory.stock_take.open", shopId: shop })).toHaveLength(0);
  });

  it("an open in another shop does not block this shop's open", async () => {
    const shop = await seedShop("Race Open Elsewhere");
    const elsewhere = await seedShop("Race Open Other Shop");
    const headers = await adminFor(shop);

    const res = await withConcurrentWrite(
      [env.DB.prepare("INSERT INTO stock_takes (id, shop_id, status) VALUES (?, ?, 'open')").bind(crypto.randomUUID(), elsewhere)],
      "POST",
      `/api/shops/${shop}/stock-takes`,
      headers,
      {},
    );

    expect(res.status, await res.clone().text()).toBe(201);
    const id = ((await res.json()) as Body<{ id: string }>).data.id;
    const st = await env.DB.prepare("SELECT status FROM stock_takes WHERE id = ?").bind(id).first<{ status: string }>();
    expect(st?.status).toBe("open");
    expect(await entriesFor({ action: "inventory.stock_take.open", shopId: shop, entityId: id })).toHaveLength(1);
  });
});
