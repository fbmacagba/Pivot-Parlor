/**
 * Voiding a till sale, shared by the void route and the Stripe webhook (a
 * pending sale whose Checkout Session expired unpaid is voided too).
 */
import type { Env } from "../types.js";
import { d1Rows } from "./d1-helpers.js";
import { stockMovementStatements } from "./sales-core.js";

/** The sale fields that decide whether it can still be voided. */
export interface VoidableSale {
  status: string;
  tender_type: string;
  refunded_pence: number;
}

/**
 * Why this sale can no longer be voided, or null when it can. A void reverses
 * the whole sale (stock, tender, ledger), so it is only for a sale whose money
 * never moved: a pending one, or a completed record-only one with nothing
 * refunded. A paid Stripe sale is refunded, never voided. The same rule is
 * the guard in voidSale's flip, so the pre-check and the write agree.
 */
export function voidRefusal(sale: VoidableSale): string | null {
  if (sale.status === "voided") return "Sale already voided";
  if (sale.status === "refunded" || Number(sale.refunded_pence) > 0) return "Refunded sales cannot be voided";
  if (sale.status === "completed" && sale.tender_type === "stripe") {
    // Money already moved: that is a refund (Stripe dashboard → the
    // charge.refunded webhook flips the sale), not a void.
    return "Paid Stripe sales must be refunded via Stripe, not voided";
  }
  if (sale.status === "pending" || sale.status === "completed") return null;
  return "This sale cannot be voided";
}

/**
 * Void = the sale never effectively happened: mark it (and its tender/ledger
 * rows) voided and put decremented stock back with reversing movements, all
 * in ONE batch, so the flip and the reversal commit together or not at all.
 *
 * The flip is the guard. It writes NULL into the NOT NULL sales.status
 * (migration 035) unless the sale is still voidable (the voidRefusal rule),
 * which makes D1 roll the whole batch back. That makes it card-aware: a
 * pending Stripe sale that settled meanwhile is no longer voidable. On a
 * thrown batch a fresh read tells a lost race (claimed false) from a real
 * failure (rethrown).
 */
export async function voidSale(
  db: Env["DB"],
  shopId: string,
  saleId: string,
  note: string | null
): Promise<{ claimed: boolean; before: string | null }> {
  // Movements are written when the sale is rung, never later, so reading them
  // before the batch is safe. Every statement is shop-scoped.
  const movements = await db
    .prepare(
      `SELECT product_id, variant_id, quantity_delta, unit_cost_pence, staff_id
       FROM stock_movements WHERE shop_id = ? AND reference_type = 'sale' AND reference_id = ?`
    )
    .bind(shopId, saleId)
    .all();

  // The status read precedes the flip in the same batch, so `before` is the
  // status the flip actually found, not an earlier pre-read.
  const stmts = [
    db.prepare("SELECT status FROM sales WHERE id = ? AND shop_id = ?").bind(saleId, shopId),
    db
      .prepare(
        `UPDATE sales SET status = CASE
           WHEN (status = 'pending' OR (status = 'completed' AND tender_type != 'stripe')) AND refunded_pence = 0
           THEN 'voided' ELSE NULL END
         WHERE id = ? AND shop_id = ?`
      )
      .bind(saleId, shopId),
    db.prepare("UPDATE bw_transactions SET status = 'voided' WHERE sale_id = ? AND shop_id = ?").bind(saleId, shopId),
    db
      .prepare("UPDATE bw_commission_ledger SET status = 'voided' WHERE sale_id = ? AND shop_id = ?")
      .bind(saleId, shopId),
  ];
  for (const m of d1Rows<{
    product_id: string;
    variant_id: string | null;
    quantity_delta: number;
    unit_cost_pence: number | null;
    staff_id: string | null;
  }>(movements)) {
    stmts.push(
      ...stockMovementStatements(db, {
        shopId,
        productId: m.product_id,
        variantId: m.variant_id,
        type: "adjustment",
        quantityDelta: -m.quantity_delta,
        unitCostPence: m.unit_cost_pence,
        referenceType: "void",
        referenceId: saleId,
        staffId: m.staff_id,
        note: note ?? "Sale voided",
      })
    );
  }

  let read: D1Result | undefined;
  try {
    [read] = await db.batch(stmts);
  } catch (err) {
    const now = await db
      .prepare("SELECT status, tender_type, refunded_pence FROM sales WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(saleId, shopId)
      .first<VoidableSale>();
    if (now && voidRefusal(now) !== null) return { claimed: false, before: now.status };
    throw err;
  }
  const before = ((read?.results?.[0] as { status?: string } | undefined)?.status ?? null) as string | null;
  // No row in this shop: the flip matched nothing and every other statement
  // is scoped to the same sale and shop, so nothing changed.
  if (before === null) return { claimed: false, before: null };
  return { claimed: true, before };
}
