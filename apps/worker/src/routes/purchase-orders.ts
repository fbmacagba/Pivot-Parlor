import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getProductById,
  getProductVariantById,
  getPurchaseOrdersByShop,
  getPurchaseOrderById,
  getPurchaseOrderItems,
  receivePurchaseOrderItemStmt,
  statusGuardStmt,
  stockMovementStatements,
} from "../db/queries.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, batchWithAudit, statusOutcome } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";

/**
 * WS-3 Phase 2: purchasing. Lifecycle draft → ordered → (partial) → received,
 * or cancelled while nothing has been received. Receiving is the ONLY place
 * stock enters through a PO: each received line emits a 'receive' movement +
 * level upsert in one batch (stockMovementStatements' invariant), updates the
 * line's received_qty, refreshes the product/variant cost to the latest paid
 * cost, and recomputes the header status inside the same transaction.
 *
 * Edit and receive check the PO before they write, so their batches open with
 * guards (statusGuardStmt, receivePurchaseOrderItemStmt) that roll the batch
 * back if a concurrent order, cancel or receipt committed in between.
 */

const r = new Hono<{ Bindings: Bindings }>();

interface PoItemInput {
  product_id?: string;
  variant_id?: string | null;
  quantity?: number;
  unit_cost_pence?: number;
}

/** Validate + normalise item inputs against the shop's catalogue. */
async function resolvePoItems(
  db: Bindings["DB"],
  shopId: string,
  items: PoItemInput[]
): Promise<
  | { ok: true; items: Array<{ product_id: string; variant_id: string | null; quantity: number; unit_cost_pence: number }> }
  | { ok: false; error: string }
> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "At least one item is required" };
  }
  if (items.length > 100) return { ok: false, error: "Too many items (max 100)" };

  const resolved: Array<{ product_id: string; variant_id: string | null; quantity: number; unit_cost_pence: number }> = [];
  for (const item of items) {
    if (!item.product_id) return { ok: false, error: "product_id is required on every item" };
    if (!Number.isInteger(item.quantity) || (item.quantity ?? 0) < 1 || (item.quantity ?? 0) > 100_000) {
      return { ok: false, error: "quantity must be an integer between 1 and 100000" };
    }
    const product = await getProductById(db, item.product_id);
    if (!product || product.shop_id !== shopId) return { ok: false, error: "Product not found" };

    let cost = product.cost_price_pence;
    let variantId: string | null = null;
    if (item.variant_id) {
      const variant = await getProductVariantById(db, item.variant_id);
      if (!variant || variant.product_id !== product.id) return { ok: false, error: "Variant not found" };
      variantId = variant.id;
      cost = variant.cost_price_pence;
    }
    if (item.unit_cost_pence !== undefined) {
      if (!Number.isInteger(item.unit_cost_pence) || item.unit_cost_pence < 0) {
        return { ok: false, error: "unit_cost_pence must be a non-negative integer (pence)" };
      }
      cost = item.unit_cost_pence;
    }
    resolved.push({ product_id: product.id, variant_id: variantId, quantity: item.quantity!, unit_cost_pence: cost });
  }
  return { ok: true, items: resolved };
}

const NOT_EDITABLE = "Only draft purchase orders can be edited";
const NOT_RECEIVABLE = "Only ordered purchase orders can be received";

type ReceiptLine = { item_id?: string; quantity?: number };
type PoItemRow = Awaited<ReturnType<typeof getPurchaseOrderItems>>[number];

/**
 * The receipt pre-check: the PO can still be received, and every line names
 * one of its items once, for a whole number no greater than is outstanding.
 * Returns the first problem as the 400 message, or null. The handler runs it
 * before the batch, and again on fresh reads if the batch's guards roll it
 * back, so a receipt that lost a race answers the 400 it would have answered
 * a moment later.
 */
function receiptProblem(po: { status: string } | null, items: PoItemRow[], lines: ReceiptLine[]): string | null {
  if (!po || (po.status !== "ordered" && po.status !== "partial")) return NOT_RECEIVABLE;
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.item_id || !byId.has(line.item_id)) return "Unknown purchase order item";
    if (seen.has(line.item_id)) return "Duplicate line for the same item";
    seen.add(line.item_id);
    if (!Number.isInteger(line.quantity) || (line.quantity ?? 0) < 1) return "quantity must be a positive integer";
    const item = byId.get(line.item_id)!;
    const outstanding = item.quantity - item.received_qty;
    if (line.quantity! > outstanding) {
      return `Cannot receive ${line.quantity} of "${item.product_name}": only ${outstanding} outstanding`;
    }
  }
  return null;
}

// ─── GET /api/shops/:shopId/purchase-orders ───────────────────────────────────

r.get("/", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  return c.json({ success: true, data: await getPurchaseOrdersByShop(c.env.DB, shopId) });
});

// ─── GET /api/shops/:shopId/purchase-orders/:poId ─────────────────────────────

r.get("/:poId", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const po = await getPurchaseOrderById(c.env.DB, shopId, c.req.param("poId")!);
  if (!po) return c.json({ success: false, error: "Purchase order not found" }, 404);
  const items = await getPurchaseOrderItems(c.env.DB, po.id);
  return c.json({ success: true, data: { ...po, items } });
});

// ─── POST /api/shops/:shopId/purchase-orders — create draft ───────────────────

r.post("/", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await c.req.json<{
    supplier_id?: string | null;
    notes?: string | null;
    items?: PoItemInput[];
  }>();

  if (body.supplier_id) {
    const supplier = await c.env.DB
      .prepare("SELECT id FROM suppliers WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(body.supplier_id, shopId)
      .first<{ id: string }>();
    if (!supplier) return c.json({ success: false, error: "Supplier not found" }, 404);
  }

  const resolved = await resolvePoItems(c.env.DB, shopId, body.items ?? []);
  if (!resolved.ok) return c.json({ success: false, error: resolved.error }, 400);

  const poId = crypto.randomUUID();
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null;
  const refused = await batchWithAudit(
    c,
    [
      c.env.DB
        .prepare("INSERT INTO purchase_orders (id, shop_id, supplier_id, status, notes) VALUES (?, ?, ?, 'draft', ?)")
        .bind(poId, shopId, body.supplier_id ?? null, notes),
      ...resolved.items.map((i) =>
        c.env.DB
          .prepare(
            "INSERT INTO purchase_order_items (id, po_id, shop_id, product_id, variant_id, quantity, unit_cost_pence) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(crypto.randomUUID(), poId, shopId, i.product_id, i.variant_id, i.quantity, i.unit_cost_pence)
      ),
    ],
    {
      action: "inventory.po.create",
      outcome: "succeeded",
      shopId,
      entityType: "purchase_order",
      entityId: poId,
      changes: fieldChanges(null, { status: "draft" }).changes,
      details: { items: resolved.items.length, supplier_id: body.supplier_id ?? null },
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: { id: poId } }, 201);
});

// ─── PUT /api/shops/:shopId/purchase-orders/:poId — edit while draft ──────────

r.put("/:poId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const po = await getPurchaseOrderById(c.env.DB, shopId, c.req.param("poId")!);
  if (!po) return c.json({ success: false, error: "Purchase order not found" }, 404);
  if (po.status !== "draft") {
    return c.json({ success: false, error: NOT_EDITABLE }, 400);
  }

  const body = await c.req.json<{
    supplier_id?: string | null;
    notes?: string | null;
    items?: PoItemInput[];
  }>();

  if (body.supplier_id) {
    const supplier = await c.env.DB
      .prepare("SELECT id FROM suppliers WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(body.supplier_id, shopId)
      .first<{ id: string }>();
    if (!supplier) return c.json({ success: false, error: "Supplier not found" }, 404);
  }

  const resolved = await resolvePoItems(c.env.DB, shopId, body.items ?? []);
  if (!resolved.ok) return c.json({ success: false, error: resolved.error }, 400);

  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) || null : po.notes;
  const nextSupplier = body.supplier_id !== undefined ? body.supplier_id : po.supplier_id;
  // Header fields only; names go in details.fields, never the notes text.
  const { changes, fields } = fieldChanges(
    { supplier_id: po.supplier_id, notes: po.notes },
    { supplier_id: nextSupplier, notes }
  );
  // The guard leads the batch: an order or cancel committed since the
  // pre-check rolls back the line replacement and the entry with it.
  let refused: Response | null;
  try {
    refused = await batchWithAudit(
      c,
      [
        statusGuardStmt(c.env.DB, "purchase_orders", po.id, shopId, ["draft"]),
        c.env.DB
          .prepare("UPDATE purchase_orders SET supplier_id = ?, notes = ? WHERE id = ? AND status = 'draft'")
          .bind(nextSupplier, notes, po.id),
        c.env.DB.prepare("DELETE FROM purchase_order_items WHERE po_id = ?").bind(po.id),
        ...resolved.items.map((i) =>
          c.env.DB
            .prepare(
              "INSERT INTO purchase_order_items (id, po_id, shop_id, product_id, variant_id, quantity, unit_cost_pence) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(crypto.randomUUID(), po.id, shopId, i.product_id, i.variant_id, i.quantity, i.unit_cost_pence)
        ),
      ],
      {
        action: "inventory.po.update",
        outcome: "succeeded",
        shopId,
        entityType: "purchase_order",
        entityId: po.id,
        changes,
        details: { items: resolved.items.length, ...(fields.length > 0 ? { fields } : {}) },
      },
    );
  } catch (e) {
    // Rolled back whole. If the PO has left draft, answer as the pre-check
    // now would; any other failure is not a lost race, so it propagates.
    const fresh = await getPurchaseOrderById(c.env.DB, shopId, po.id);
    if (fresh?.status !== "draft") return c.json({ success: false, error: NOT_EDITABLE }, 400);
    throw e;
  }
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── POST /api/shops/:shopId/purchase-orders/:poId/order ──────────────────────

r.post("/:poId/order", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const notDraft = () => c.json({ success: false, error: "Only draft purchase orders can be marked as ordered" }, 400);
  // Read first, so the entry carries the row's own id and shop id, never URL
  // text. An unknown PO (or shop) answers exactly as the UPDATE alone did and
  // records nothing; the conditional UPDATE below stays the only gate.
  const po = await getPurchaseOrderById(c.env.DB, shopId, c.req.param("poId")!);
  if (!po) return notDraft();
  try {
    return await auditFor(c).run(
      { action: "inventory.po.order", shopId: po.shop_id, entityType: "purchase_order", entityId: po.id },
      async (): Promise<Response> => {
        const res = await c.env.DB
          .prepare(
            "UPDATE purchase_orders SET status = 'ordered', ordered_at = datetime('now') WHERE id = ? AND shop_id = ? AND status = 'draft'"
          )
          .bind(po.id, po.shop_id)
          .run();
        if ((res.meta?.changes ?? 0) !== 1) return notDraft();
        return c.json({ success: true });
      },
      statusOutcome((res) => (res.status < 400 ? { changes: { status: ["draft", "ordered"] } } : {})),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── POST /api/shops/:shopId/purchase-orders/:poId/cancel ─────────────────────

r.post("/:poId/cancel", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const notCancellable = () =>
    c.json({ success: false, error: "Only draft or ordered purchase orders can be cancelled" }, 400);
  // Read first: the entry carries the row's own id and shop id (never URL
  // text) and `changes` its prior status. An unknown PO (or shop) answers
  // exactly as the UPDATE alone did and records nothing. The conditional
  // UPDATE below stays the sole gate, so a second cancel reaches it and
  // records `refused`.
  const prev = await getPurchaseOrderById(c.env.DB, shopId, c.req.param("poId")!);
  if (!prev) return notCancellable();
  try {
    return await auditFor(c).run(
      { action: "inventory.po.cancel", shopId: prev.shop_id, entityType: "purchase_order", entityId: prev.id },
      async (): Promise<Response> => {
        // Once stock has been received (partial/received) the PO is history, not
        // cancellable — corrections go through inventory adjustments.
        const res = await c.env.DB
          .prepare(
            "UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND shop_id = ? AND status IN ('draft','ordered')"
          )
          .bind(prev.id, prev.shop_id)
          .run();
        if ((res.meta?.changes ?? 0) !== 1) return notCancellable();
        return c.json({ success: true });
      },
      statusOutcome((res) => (res.status < 400 ? { changes: { status: [prev.status, "cancelled"] } } : {})),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── POST /api/shops/:shopId/purchase-orders/:poId/receive ────────────────────

r.post("/:poId/receive", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const po = await getPurchaseOrderById(c.env.DB, shopId, c.req.param("poId")!);
  if (!po) return c.json({ success: false, error: "Purchase order not found" }, 404);
  if (po.status !== "ordered" && po.status !== "partial") {
    return c.json({ success: false, error: NOT_RECEIVABLE }, 400);
  }

  const body = await c.req.json<{ lines?: ReceiptLine[] }>();
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ success: false, error: "lines is required" }, 400);
  }
  const lines = body.lines;

  const items = await getPurchaseOrderItems(c.env.DB, po.id);
  const problem = receiptProblem(po, items, lines);
  if (problem) return c.json({ success: false, error: problem }, 400);
  const byId = new Map(items.map((i) => [i.id, i]));

  // Guards first: the status guard and each line's received_qty CASE roll the
  // whole batch back if a cancel or another receipt landed since the checks.
  const stmts = [statusGuardStmt(c.env.DB, "purchase_orders", po.id, shopId, ["ordered", "partial"])];
  let units = 0;
  for (const line of lines) {
    const item = byId.get(line.item_id!)!;
    units += line.quantity!;
    stmts.push(receivePurchaseOrderItemStmt(c.env.DB, item.id, line.quantity!));
    stmts.push(
      ...stockMovementStatements(c.env.DB, {
        id: crypto.randomUUID(),
        shop_id: shopId,
        product_id: item.product_id,
        variant_id: item.variant_id,
        type: "receive",
        quantity_delta: line.quantity!,
        unit_cost_pence: item.unit_cost_pence,
        reference_type: "purchase_order",
        reference_id: po.id,
      })
    );
    // Latest-cost update: the price actually paid becomes the product's COGS
    // basis for future sales. Zero-cost lines don't overwrite a known cost.
    if (item.unit_cost_pence > 0) {
      stmts.push(
        item.variant_id
          ? c.env.DB
              .prepare("UPDATE product_variants SET cost_price_pence = ? WHERE id = ?")
              .bind(item.unit_cost_pence, item.variant_id)
          : c.env.DB
              .prepare("UPDATE products SET cost_price_pence = ? WHERE id = ?")
              .bind(item.unit_cost_pence, item.product_id)
      );
    }
  }

  // Header status recomputes INSIDE the same transaction, after the item
  // updates above have applied (D1 batches run sequentially in one tx).
  stmts.push(
    c.env.DB
      .prepare(
        `UPDATE purchase_orders SET
           status = CASE WHEN (SELECT COALESCE(SUM(quantity - received_qty), 0) FROM purchase_order_items WHERE po_id = ?) <= 0
                         THEN 'received' ELSE 'partial' END,
           received_at = CASE WHEN (SELECT COALESCE(SUM(quantity - received_qty), 0) FROM purchase_order_items WHERE po_id = ?) <= 0
                              THEN datetime('now') ELSE received_at END
         WHERE id = ?`
      )
      .bind(po.id, po.id, po.id)
  );

  let refused: Response | null;
  try {
    refused = await batchWithAudit(c, stmts, {
      action: "inventory.po.receive",
      outcome: "succeeded",
      shopId,
      entityType: "purchase_order",
      entityId: po.id,
      details: { lines: lines.length, units },
    });
  } catch (e) {
    // Rolled back whole. If the checks now fail on fresh reads (the PO was
    // cancelled, or another receipt took the units), answer as they would;
    // any other failure is not a lost race, so it propagates.
    const fresh = await getPurchaseOrderById(c.env.DB, shopId, po.id);
    const lost = receiptProblem(fresh, fresh ? await getPurchaseOrderItems(c.env.DB, po.id) : [], lines);
    if (lost) return c.json({ success: false, error: lost }, 400);
    throw e;
  }
  if (refused) return refused;
  const updated = await getPurchaseOrderById(c.env.DB, shopId, po.id);
  return c.json({ success: true, data: { status: updated?.status } });
});

export { r as purchaseOrdersRouter };
