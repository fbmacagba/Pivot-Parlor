import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getProductById,
  getProductVariantById,
  stockMovementStatements,
  setReorderLevelsStmt,
  getReorderLevels,
  getLowStockByShop,
  getStockMovementsByShop,
  getInventoryReport,
  getShopTimezone,
  type StockMovementType,
} from "../db/queries.js";
import { batchWithAudit } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { isCalendarDate, shopDaysWindow, shopToday } from "../lib/shopTime.js";
import { readJsonObject, shiftDate } from "@repo/utils";

/**
 * WS-3 Phase 0: stock. Quantities only ever change through movements
 * (stockMovementStatements writes the movement + level, batched with the audit
 * entry so all three commit or none do). 'sale' and
 * 'consumption' movements are reserved for the POS (Phase 1) and back-bar
 * (Phase 2) flows — they carry money/BOM side-effects, so this manual
 * endpoint refuses them.
 */

const MANUAL_TYPES: ReadonlySet<StockMovementType> = new Set([
  "receive",
  "adjustment",
  "waste",
  "transfer",
  "return",
]);

const inventoryRouter = new Hono<{ Bindings: Bindings }>();

// ─── GET /api/shops/:shopId/inventory/low-stock ───────────────────────────────

inventoryRouter.get("/low-stock", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  return c.json({ success: true, data: await getLowStockByShop(c.env.DB, shopId) });
});

// ─── GET /api/shops/:shopId/inventory/report?from=&to= ────────────────────────
// Retail COGS/margin + per-product sell-through + per-staff retail +
// consumption cost (WS-3 Phase 2). Defaults to the last 30 days. Every day
// here is the shop's day (src/lib/shopTime.ts): the defaults, and which day a
// sale or stock movement falls on.

inventoryRouter.get("/report", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const timeZone = await getShopTimezone(c.env.DB, shopId);
  const today = shopToday(timeZone);
  const to = c.req.query("to") ?? today;
  const from = c.req.query("from") ?? shiftDate(today, -30);
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return c.json({ success: false, error: "from/to must be YYYY-MM-DD with from <= to" }, 400);
  }
  const report = await getInventoryReport(c.env.DB, shopId, shopDaysWindow(from, to, timeZone));
  return c.json({ success: true, data: { from, to, ...report } });
});

// ─── GET /api/shops/:shopId/inventory/movements ───────────────────────────────

inventoryRouter.get("/movements", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.query("product_id") || undefined;
  const limitRaw = Number(c.req.query("limit"));
  const list = await getStockMovementsByShop(c.env.DB, shopId, {
    product_id: productId,
    limit: Number.isInteger(limitRaw) ? limitRaw : undefined,
  });
  return c.json({ success: true, data: list });
});

// ─── POST /api/shops/:shopId/inventory/movements ──────────────────────────────

inventoryRouter.post("/movements", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await readJsonObject<{
    product_id?: string;
    variant_id?: string | null;
    type?: string;
    quantity_delta?: number;
    unit_cost_pence?: number | null;
    note?: string | null;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  if (!body.product_id || !body.type || body.quantity_delta === undefined) {
    return c.json({ success: false, error: "product_id, type and quantity_delta are required" }, 400);
  }
  if (!MANUAL_TYPES.has(body.type as StockMovementType)) {
    return c.json(
      { success: false, error: `type must be one of: ${[...MANUAL_TYPES].join(", ")}` },
      400
    );
  }
  if (!Number.isInteger(body.quantity_delta) || body.quantity_delta === 0) {
    return c.json({ success: false, error: "quantity_delta must be a non-zero integer" }, 400);
  }
  if (
    body.unit_cost_pence !== undefined &&
    body.unit_cost_pence !== null &&
    (!Number.isInteger(body.unit_cost_pence) || body.unit_cost_pence < 0)
  ) {
    return c.json({ success: false, error: "unit_cost_pence must be a non-negative integer (pence)" }, 400);
  }

  const product = await getProductById(c.env.DB, body.product_id);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  if (body.variant_id) {
    const variant = await getProductVariantById(c.env.DB, body.variant_id);
    if (!variant || variant.product_id !== product.id) {
      return c.json({ success: false, error: "Variant not found" }, 404);
    }
  }

  const id = crypto.randomUUID();
  const variantId = body.variant_id ?? null;
  const unitCost = body.unit_cost_pence ?? null;
  const refused = await batchWithAudit(
    c,
    stockMovementStatements(c.env.DB, {
      id,
      shop_id: shopId,
      product_id: product.id,
      variant_id: variantId,
      type: body.type as StockMovementType,
      quantity_delta: body.quantity_delta,
      unit_cost_pence: unitCost,
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null,
    }),
    {
      action: "inventory.movement",
      outcome: "succeeded",
      shopId,
      entityType: "stock_movement",
      entityId: id,
      changes: fieldChanges(null, {
        product_id: product.id,
        variant_id: variantId,
        type: body.type,
        quantity_delta: body.quantity_delta,
        unit_cost_pence: unitCost,
      }).changes,
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: { id } }, 201);
});

// ─── PUT /api/shops/:shopId/inventory/reorder ─────────────────────────────────

inventoryRouter.put("/reorder", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await readJsonObject<{
    product_id?: string;
    variant_id?: string | null;
    reorder_point?: number;
    reorder_qty?: number;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  if (!body.product_id || body.reorder_point === undefined || body.reorder_qty === undefined) {
    return c.json(
      { success: false, error: "product_id, reorder_point and reorder_qty are required" },
      400
    );
  }
  if (
    !Number.isInteger(body.reorder_point) || body.reorder_point < 0 ||
    !Number.isInteger(body.reorder_qty) || body.reorder_qty < 0
  ) {
    return c.json(
      { success: false, error: "reorder_point and reorder_qty must be non-negative integers" },
      400
    );
  }

  const product = await getProductById(c.env.DB, body.product_id);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  if (body.variant_id) {
    const variant = await getProductVariantById(c.env.DB, body.variant_id);
    if (!variant || variant.product_id !== product.id) {
      return c.json({ success: false, error: "Variant not found" }, 404);
    }
  }

  const variantId = body.variant_id ?? null;
  const current = await getReorderLevels(c.env.DB, shopId, product.id, variantId);
  const { changes, fields } = fieldChanges(current, {
    reorder_point: body.reorder_point,
    reorder_qty: body.reorder_qty,
  });
  const refused = await batchWithAudit(
    c,
    [
      setReorderLevelsStmt(c.env.DB, {
        shop_id: shopId,
        product_id: product.id,
        variant_id: variantId,
        reorder_point: body.reorder_point,
        reorder_qty: body.reorder_qty,
      }),
    ],
    {
      action: "inventory.reorder",
      outcome: "succeeded",
      shopId,
      entityType: "stock_level",
      entityId: variantId ?? product.id,
      changes,
      ...(fields.length > 0 ? { details: { fields } } : {}),
    },
  );
  if (refused) return refused;
  return c.json({ success: true });
});

export { inventoryRouter };
