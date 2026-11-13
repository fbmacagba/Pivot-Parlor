import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getProductById,
  getProductVariantById,
  getStockTakeById,
  getStockTakesByShop,
  getStockTakeItems,
  getCurrentQuantity,
  statusGuardStmt,
  stockMovementStatements,
} from "../db/queries.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, auditShopId, batchWithAudit, statusOutcome, UNRESOLVED_SHOP } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { readJsonObject } from "@repo/utils";

/**
 * WS-3 Phase 2: stock-take sessions. One open session per shop; staff enter
 * counts over time (expected_qty snapshots the level at entry for the variance
 * report); completing the session emits 'adjustment' movements against the
 * CURRENT level (not the snapshot) so sales rung up mid-count stay consistent.
 * Completion is guarded by an atomic status flip — only one closer wins.
 */

const r = new Hono<{ Bindings: Bindings }>();

// ─── GET /api/shops/:shopId/stock-takes ───────────────────────────────────────

r.get("/", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  return c.json({ success: true, data: await getStockTakesByShop(c.env.DB, shopId) });
});

// ─── GET /api/shops/:shopId/stock-takes/:stockTakeId ──────────────────────────

r.get("/:stockTakeId", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const st = await getStockTakeById(c.env.DB, shopId, c.req.param("stockTakeId")!);
  if (!st) return c.json({ success: false, error: "Stock take not found" }, 404);
  const items = await getStockTakeItems(c.env.DB, st.id);
  return c.json({ success: true, data: { ...st, items } });
});

// ─── POST /api/shops/:shopId/stock-takes — open a session ─────────────────────

r.post("/", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const user = getUser(c);
  const body: { notes?: string } = (await readJsonObject(c.req)) ?? {};

  const openTake = () =>
    c.env.DB
      .prepare("SELECT id FROM stock_takes WHERE shop_id = ? AND status = 'open' LIMIT 1")
      .bind(shopId)
      .first<{ id: string }>();
  const alreadyOpen = (openId: string) =>
    c.json(
      { success: false, error: "A stock take is already open. Complete or cancel it first.", open_id: openId },
      409
    );
  const open = await openTake();
  if (open) return alreadyOpen(open.id);

  const id = crypto.randomUUID();
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null;
  // Developers pass requireShopRole without a shop check: the entry records
  // the shop only once it resolves (never the raw param).
  const auditShop = await auditShopId(c, shopId);
  let refused: Response | null;
  try {
    refused = await batchWithAudit(
      c,
      [
        // The insert is its own guard: an open committed since the check above
        // makes status NULL, which the NOT NULL column refuses, so the batch
        // (and its audit entry) rolls back instead of opening a second take.
        c.env.DB
          .prepare(
            `INSERT INTO stock_takes (id, shop_id, status, notes, created_by)
             VALUES (?1, ?2,
                     CASE WHEN EXISTS (SELECT 1 FROM stock_takes WHERE shop_id = ?2 AND status = 'open')
                          THEN NULL ELSE 'open' END,
                     ?3, ?4)`
          )
          .bind(id, shopId, notes, user.sub),
      ],
      {
        action: "inventory.stock_take.open",
        outcome: "succeeded",
        shopId: auditShop,
        entityType: "stock_take",
        entityId: id,
        changes: fieldChanges(null, { status: "open" }).changes,
        ...(auditShop ? {} : { details: UNRESOLVED_SHOP }),
      },
    );
  } catch (e) {
    // Rolled back whole. If another take is now open, answer as the check
    // above now would; any other failure is not a lost race, so it propagates.
    const fresh = await openTake();
    if (fresh) return alreadyOpen(fresh.id);
    throw e;
  }
  if (refused) return refused;
  return c.json({ success: true, data: { id } }, 201);
});

// ─── PUT /api/shops/:shopId/stock-takes/:stockTakeId/items — record counts ────
// Staff do the counting. Re-counting a product replaces the previous row
// (count AND expected snapshot refresh together).

r.put("/:stockTakeId/items", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const st = await getStockTakeById(c.env.DB, shopId, c.req.param("stockTakeId")!);
  if (!st) return c.json({ success: false, error: "Stock take not found" }, 404);
  const notOpen = () => c.json({ success: false, error: "This stock take is no longer open" }, 400);
  if (st.status !== "open") return notOpen();

  const body = await readJsonObject<{
    items?: Array<{ product_id?: string; variant_id?: string | null; counted_qty?: number }>;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ success: false, error: "items is required" }, 400);
  }
  if (body.items.length > 200) {
    return c.json({ success: false, error: "Too many items in one request (max 200)" }, 400);
  }

  // The guard leads the batch: a completion or cancel committed since the
  // check above rolls the counts back instead of filing them on a closed take.
  const stmts = [statusGuardStmt(c.env.DB, "stock_takes", st.id, shopId, ["open"])];
  for (const item of body.items) {
    if (!item.product_id) return c.json({ success: false, error: "product_id is required on every item" }, 400);
    if (!Number.isInteger(item.counted_qty) || (item.counted_qty ?? -1) < 0) {
      return c.json({ success: false, error: "counted_qty must be a non-negative integer" }, 400);
    }
    const product = await getProductById(c.env.DB, item.product_id);
    if (!product || product.shop_id !== shopId) {
      return c.json({ success: false, error: "Product not found" }, 404);
    }
    let variantId: string | null = null;
    if (item.variant_id) {
      const variant = await getProductVariantById(c.env.DB, item.variant_id);
      if (!variant || variant.product_id !== product.id) {
        return c.json({ success: false, error: "Variant not found" }, 404);
      }
      variantId = variant.id;
    }

    const expected = await getCurrentQuantity(c.env.DB, shopId, product.id, variantId);
    stmts.push(
      variantId === null
        ? c.env.DB
            .prepare(
              `INSERT INTO stock_take_items (id, stock_take_id, shop_id, product_id, variant_id, expected_qty, counted_qty)
               VALUES (?, ?, ?, ?, NULL, ?, ?)
               ON CONFLICT(stock_take_id, product_id) WHERE variant_id IS NULL
               DO UPDATE SET counted_qty = excluded.counted_qty, expected_qty = excluded.expected_qty`
            )
            .bind(crypto.randomUUID(), st.id, shopId, product.id, expected, item.counted_qty)
        : c.env.DB
            .prepare(
              `INSERT INTO stock_take_items (id, stock_take_id, shop_id, product_id, variant_id, expected_qty, counted_qty)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(stock_take_id, product_id, variant_id) WHERE variant_id IS NOT NULL
               DO UPDATE SET counted_qty = excluded.counted_qty, expected_qty = excluded.expected_qty`
            )
            .bind(crypto.randomUUID(), st.id, shopId, product.id, variantId, expected, item.counted_qty)
    );
  }

  let refused: Response | null;
  try {
    refused = await batchWithAudit(c, stmts, {
      action: "inventory.stock_take.count",
      outcome: "succeeded",
      shopId,
      entityType: "stock_take",
      entityId: st.id,
      // Count lines in the request (every one passed validation to reach here).
      // The handler does not dedupe: a product listed twice is two lines, the
      // later upsert winning, so this is lines submitted, not distinct products.
      details: { items: body.items.length },
    });
  } catch (e) {
    // Rolled back whole. If the take has closed, answer as the check above
    // now would; any other failure is not a lost race, so it propagates.
    const fresh = await getStockTakeById(c.env.DB, shopId, st.id);
    if (fresh?.status !== "open") return notOpen();
    throw e;
  }
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── POST /api/shops/:shopId/stock-takes/:stockTakeId/complete ────────────────

r.post("/:stockTakeId/complete", authMiddleware, requireShopRole("admin"), async (c) => {
  const user = getUser(c);
  const notOpen = () => c.json({ success: false, error: "This stock take is not open" }, 400);
  // Read first, so the entry carries the row's own id and shop id, never URL
  // text. An unknown stock take (or shop) answers exactly as the claim alone
  // did and records nothing; the conditional claim below stays the only gate.
  const st = await getStockTakeById(c.env.DB, c.req.param("shopId")!, c.req.param("stockTakeId")!);
  if (!st) return notOpen();
  const shopId = st.shop_id;
  const stockTakeId = st.id;

  // Claim-first (Plan decision 3): started entry, then the claim, then the
  // movements batch, all inside run(). If the movements batch throws, run()
  // writes outcome `failed` (reason: the error name) and rethrows, so the
  // response is a 500 and the stock take stays `completed` with no
  // adjustments. Only an isolate death between the claim and the outcome
  // leaves a started entry with no outcome, which reads as unknown.
  let itemsCounted = 0;
  let itemsAdjusted = 0;
  try {
    return await auditFor(c).run(
      { action: "inventory.stock_take.complete", shopId, entityType: "stock_take", entityId: stockTakeId },
      async (): Promise<Response> => {
        const claim = await c.env.DB
          .prepare(
            "UPDATE stock_takes SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND shop_id = ? AND status = 'open'"
          )
          .bind(stockTakeId, shopId)
          .run();
        if ((claim.meta?.changes ?? 0) !== 1) return notOpen();

        const items = await getStockTakeItems(c.env.DB, stockTakeId);
        const stmts = [];
        let adjusted = 0;
        for (const item of items) {
          const current = await getCurrentQuantity(c.env.DB, shopId, item.product_id, item.variant_id);
          const delta = item.counted_qty - current;
          if (delta === 0) continue;
          adjusted++;
          stmts.push(
            ...stockMovementStatements(c.env.DB, {
              id: crypto.randomUUID(),
              shop_id: shopId,
              product_id: item.product_id,
              variant_id: item.variant_id,
              type: "adjustment",
              quantity_delta: delta,
              reference_type: "stock_take",
              reference_id: stockTakeId,
              staff_id: null,
              note: `Stock take count ${item.counted_qty} (was ${current}) by ${user.sub}`,
            })
          );
        }
        if (stmts.length > 0) await c.env.DB.batch(stmts);

        itemsCounted = items.length;
        itemsAdjusted = adjusted;
        return c.json({ success: true, data: { items_counted: items.length, items_adjusted: adjusted } });
      },
      statusOutcome((res) =>
        res.status < 400 ? { details: { items_counted: itemsCounted, items_adjusted: itemsAdjusted } } : {}
      ),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── POST /api/shops/:shopId/stock-takes/:stockTakeId/cancel ──────────────────

r.post("/:stockTakeId/cancel", authMiddleware, requireShopRole("admin"), async (c) => {
  const notOpen = () => c.json({ success: false, error: "This stock take is not open" }, 400);
  // Read first, so the entry carries the row's own id and shop id, never URL
  // text. An unknown stock take (or shop) answers exactly as the UPDATE alone
  // did and records nothing; the conditional UPDATE below stays the only gate.
  const st = await getStockTakeById(c.env.DB, c.req.param("shopId")!, c.req.param("stockTakeId")!);
  if (!st) return notOpen();
  try {
    return await auditFor(c).run(
      { action: "inventory.stock_take.cancel", shopId: st.shop_id, entityType: "stock_take", entityId: st.id },
      async (): Promise<Response> => {
        const res = await c.env.DB
          .prepare("UPDATE stock_takes SET status = 'cancelled' WHERE id = ? AND shop_id = ? AND status = 'open'")
          .bind(st.id, st.shop_id)
          .run();
        if ((res.meta?.changes ?? 0) !== 1) return notOpen();
        return c.json({ success: true });
      },
      statusOutcome((res) => (res.status < 400 ? { changes: { status: ["open", "cancelled"] } } : {})),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export { r as stockTakesRouter };
