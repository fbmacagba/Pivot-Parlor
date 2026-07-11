/**
 * WS-3 Phase 1: shared sale-building logic for the unified commerce spine.
 * Both the counter POS (routes/sales.ts) and the appointment checkout
 * (routes/bookings.ts) resolve cart lines against the catalogue, split
 * commission across the two per-shop rates, and persist the whole sale in
 * ONE atomic db.batch built here — sale header + line items + stock
 * movements/levels + tender transaction + commission ledger.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { calculateCommissionPence } from "@repo/utils";

export interface SaleLineInput {
  type?: string;
  serviceId?: string;
  productId?: string;
  variantId?: string | null;
  quantity?: number;
  staffId?: string | null;
}

export interface ResolvedLine {
  item_type: "service" | "product";
  service_id: string | null;
  product_id: string | null;
  variant_id: string | null;
  name: string;
  quantity: number;
  unit_price_pence: number;
  cost_price_pence: number;
  line_total_pence: number;
  staff_id: string | null;
  /** Product lines with track_stock=1 emit a 'sale' stock movement. */
  decrements_stock: boolean;
}

export class SaleInputError extends Error {}

const MAX_QTY = 999;

/**
 * Resolve cart lines against the shop's catalogue. Prices and COGS are read
 * server-side (never trusted from the client) and snapshotted per line.
 * Throws SaleInputError with a user-readable message on any invalid line.
 */
export async function resolveSaleLines(
  db: D1Database,
  shopId: string,
  lines: SaleLineInput[]
): Promise<ResolvedLine[]> {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new SaleInputError("At least one line item is required");
  }
  if (lines.length > 50) {
    throw new SaleInputError("Too many line items (max 50)");
  }

  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const qty = line.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new SaleInputError("quantity must be an integer between 1 and 999");
    }

    let staffId: string | null = null;
    if (line.staffId) {
      const staff = await db
        .prepare("SELECT id FROM staff WHERE id = ? AND shop_id = ? LIMIT 1")
        .bind(line.staffId, shopId)
        .first<{ id: string }>();
      if (!staff) throw new SaleInputError("Staff member not found for this shop");
      staffId = staff.id;
    }

    if (line.type === "service") {
      if (!line.serviceId) throw new SaleInputError("serviceId is required for service lines");
      const svc = await db
        .prepare("SELECT id, name, price_pence FROM services WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1")
        .bind(line.serviceId, shopId)
        .first<{ id: string; name: string; price_pence: number }>();
      if (!svc) throw new SaleInputError("Service not found");
      resolved.push({
        item_type: "service",
        service_id: svc.id,
        product_id: null,
        variant_id: null,
        name: svc.name,
        quantity: qty,
        unit_price_pence: svc.price_pence,
        cost_price_pence: 0,
        line_total_pence: svc.price_pence * qty,
        staff_id: staffId,
        decrements_stock: false,
      });
      continue;
    }

    if (line.type === "product") {
      if (!line.productId) throw new SaleInputError("productId is required for product lines");
      const product = await db
        .prepare(
          `SELECT id, name, retail_price_pence, cost_price_pence, track_stock
           FROM products WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1`
        )
        .bind(line.productId, shopId)
        .first<{ id: string; name: string; retail_price_pence: number; cost_price_pence: number; track_stock: number }>();
      if (!product) throw new SaleInputError("Product not found");

      let name = product.name;
      let unit = product.retail_price_pence;
      let cost = product.cost_price_pence;
      let variantId: string | null = null;
      if (line.variantId) {
        const variant = await db
          .prepare(
            `SELECT id, name, retail_price_pence, cost_price_pence
             FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1 LIMIT 1`
          )
          .bind(line.variantId, product.id)
          .first<{ id: string; name: string; retail_price_pence: number; cost_price_pence: number }>();
        if (!variant) throw new SaleInputError("Product variant not found");
        variantId = variant.id;
        name = `${product.name} — ${variant.name}`;
        unit = variant.retail_price_pence;
        cost = variant.cost_price_pence;
      }

      resolved.push({
        item_type: "product",
        service_id: null,
        product_id: product.id,
        variant_id: variantId,
        name,
        quantity: qty,
        unit_price_pence: unit,
        cost_price_pence: cost,
        line_total_pence: unit * qty,
        staff_id: staffId,
        decrements_stock: product.track_stock === 1,
      });
      continue;
    }

    throw new SaleInputError("Each line must have type 'service' or 'product'");
  }
  return resolved;
}

export interface ConsumptionEntry {
  product_id: string;
  /** Negative: units leaving stock. */
  quantity_delta: number;
  unit_cost_pence: number | null;
}

/**
 * Back-bar consumption (WS-3 Phase 2): service_products is the per-service
 * bill of materials — selling a service consumes its products. Only active,
 * stock-tracked products move. Runs on BOTH sale paths (POS counter sales and
 * appointment checkout); pending Stripe sales consume at creation just like
 * 'sale' movements, and voiding reverses both (voidSale reverses every
 * movement referencing the sale).
 */
export async function resolveConsumption(
  db: D1Database,
  shopId: string,
  lines: ResolvedLine[]
): Promise<ConsumptionEntry[]> {
  const perService = new Map<string, number>();
  for (const l of lines) {
    if (l.item_type === "service" && l.service_id) {
      perService.set(l.service_id, (perService.get(l.service_id) ?? 0) + l.quantity);
    }
  }
  if (perService.size === 0) return [];

  const entries: ConsumptionEntry[] = [];
  for (const [serviceId, svcQty] of perService) {
    const { results } = await db
      .prepare(
        `SELECT sp.product_id, sp.quantity, p.cost_price_pence
         FROM service_products sp
         JOIN products p ON p.id = sp.product_id
         WHERE sp.service_id = ? AND sp.shop_id = ? AND p.is_active = 1 AND p.track_stock = 1`
      )
      .bind(serviceId, shopId)
      .all<{ product_id: string; quantity: number; cost_price_pence: number }>();
    for (const row of results ?? []) {
      entries.push({
        product_id: row.product_id,
        quantity_delta: -(row.quantity * svcQty),
        unit_cost_pence: row.cost_price_pence,
      });
    }
  }
  return entries;
}

export function sumByType(lines: ResolvedLine[]): { servicesPence: number; retailPence: number } {
  let servicesPence = 0;
  let retailPence = 0;
  for (const l of lines) {
    if (l.item_type === "service") servicesPence += l.line_total_pence;
    else retailPence += l.line_total_pence;
  }
  return { servicesPence, retailPence };
}

/**
 * Split a sale-level discount pro-rata across the service and retail portions,
 * then apply each portion's commission rate (user decision 2026-07-11: retail
 * has its own rate). Tips are never part of the base. All rounding goes
 * through calculateCommissionPence (WS-4 single rounding path).
 */
export function computeCommission(args: {
  servicesPence: number;
  retailPence: number;
  discountPence: number;
  commissionRate: number;
  retailCommissionRate: number;
}): { discountedServicesPence: number; discountedRetailPence: number; commissionPence: number } {
  const subtotal = args.servicesPence + args.retailPence;
  const discount = Math.min(Math.max(0, args.discountPence), subtotal);
  const discountedServicesPence =
    subtotal > 0 ? args.servicesPence - Math.round((discount * args.servicesPence) / subtotal) : 0;
  const discountedRetailPence = subtotal - discount - discountedServicesPence;
  const commissionPence =
    calculateCommissionPence(discountedServicesPence, args.commissionRate).commission_pence +
    calculateCommissionPence(discountedRetailPence, args.retailCommissionRate).commission_pence;
  return { discountedServicesPence, discountedRetailPence, commissionPence };
}

export interface SaleBatchArgs {
  saleId: string;
  shopId: string;
  bookingId?: string | null;
  businessDayId?: string | null;
  staffId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  lines: ResolvedLine[];
  subtotalPence: number;
  discountPence: number;
  tipPence: number;
  totalPence: number;
  tenderType: "cash" | "card_external" | "stripe";
  /** 'completed' for record-only tenders and settled checkouts, 'pending' while Stripe money is outstanding. */
  status: "pending" | "completed";
  /** Back-bar BOM movements from resolveConsumption (WS-3 Phase 2). */
  consumption?: ConsumptionEntry[];
  note?: string | null;
  ledger: {
    servicesAmountPence: number;
    retailAmountPence: number;
    commissionRate: number;
    retailCommissionRate: number;
    commissionPence: number;
    commissionBearer: string;
    /** 'transferred' only when the money has actually settled through Stripe (WS-2 honesty). */
    status: "pending" | "transferred";
  };
  transactions: Array<{
    type: string;
    amountPence: number;
    status: string;
    stripeId?: string | null;
    bookingId?: string | null;
  }>;
}

/**
 * Build the atomic statement list for a sale. Every quantity change is a
 * stock_movements row + stock_levels upsert in the SAME batch — mirrors
 * applyStockMovement in the main worker's queries.ts (keep the ON CONFLICT
 * targets in sync with migration 034's partial unique indexes).
 */
export function buildSaleBatch(db: D1Database, args: SaleBatchArgs): D1PreparedStatement[] {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    db
      .prepare(
        `INSERT INTO sales (id, shop_id, booking_id, business_day_id, staff_id, customer_name, customer_email,
           subtotal_pence, discount_pence, tip_pence, total_pence, tender_type, status, note, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        args.saleId,
        args.shopId,
        args.bookingId ?? null,
        args.businessDayId ?? null,
        args.staffId ?? null,
        args.customerName ?? null,
        args.customerEmail ?? null,
        args.subtotalPence,
        args.discountPence,
        args.tipPence,
        args.totalPence,
        args.tenderType,
        args.status,
        args.note ?? null,
        args.status === "completed" ? now : null
      )
  );

  for (const line of args.lines) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO sale_items (id, sale_id, shop_id, item_type, service_id, product_id, variant_id,
             name, quantity, unit_price_pence, cost_price_pence, line_total_pence, staff_id, is_commissionable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          crypto.randomUUID(),
          args.saleId,
          args.shopId,
          line.item_type,
          line.service_id,
          line.product_id,
          line.variant_id,
          line.name,
          line.quantity,
          line.unit_price_pence,
          line.cost_price_pence,
          line.line_total_pence,
          line.staff_id
        )
    );

    if (line.decrements_stock && line.product_id) {
      stmts.push(...stockMovementStatements(db, {
        shopId: args.shopId,
        productId: line.product_id,
        variantId: line.variant_id,
        type: "sale",
        quantityDelta: -line.quantity,
        unitCostPence: line.cost_price_pence,
        referenceType: "sale",
        referenceId: args.saleId,
        staffId: line.staff_id,
      }));
    }
  }

  // Back-bar consumption rides in the same batch and carries the same
  // reference as the 'sale' movements, so voidSale reverses it too.
  for (const entry of args.consumption ?? []) {
    stmts.push(
      ...stockMovementStatements(db, {
        shopId: args.shopId,
        productId: entry.product_id,
        variantId: null,
        type: "consumption",
        quantityDelta: entry.quantity_delta,
        unitCostPence: entry.unit_cost_pence,
        referenceType: "sale",
        referenceId: args.saleId,
        staffId: args.staffId ?? null,
        note: "Back-bar consumption",
      })
    );
  }

  for (const tx of args.transactions) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bw_transactions (id, booking_id, sale_id, shop_id, type, amount_pence, status, stripe_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          tx.bookingId ?? null,
          args.saleId,
          args.shopId,
          tx.type,
          tx.amountPence,
          tx.status,
          tx.stripeId ?? null
        )
    );
  }

  stmts.push(
    db
      .prepare(
        `INSERT INTO bw_commission_ledger (id, shop_id, business_day_id, booking_id, sale_id,
           services_amount_pence, retail_amount_pence, commission_rate, retail_commission_rate,
           commission_amount_pence, commission_bearer, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        args.shopId,
        args.businessDayId ?? null,
        args.bookingId ?? null,
        args.saleId,
        args.ledger.servicesAmountPence,
        args.ledger.retailAmountPence,
        args.ledger.commissionRate,
        args.ledger.retailCommissionRate,
        args.ledger.commissionPence,
        args.ledger.commissionBearer,
        args.ledger.status
      )
  );

  return stmts;
}

/**
 * Movement + level upsert pair. The ON CONFLICT targets must match the paired
 * partial unique indexes idx_stock_levels_product / idx_stock_levels_variant
 * (migration 034) — SQLite resolves the upsert against the partial index whose
 * WHERE clause matches.
 */
export function stockMovementStatements(
  db: D1Database,
  m: {
    shopId: string;
    productId: string;
    variantId: string | null;
    type: string;
    quantityDelta: number;
    unitCostPence: number | null;
    referenceType: string | null;
    referenceId: string | null;
    staffId: string | null;
    note?: string | null;
  }
): D1PreparedStatement[] {
  const movement = db
    .prepare(
      `INSERT INTO stock_movements (id, shop_id, product_id, variant_id, type, quantity_delta,
         unit_cost_pence, reference_type, reference_id, staff_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      m.shopId,
      m.productId,
      m.variantId,
      m.type,
      m.quantityDelta,
      m.unitCostPence,
      m.referenceType,
      m.referenceId,
      m.staffId,
      m.note ?? null
    );
  const level =
    m.variantId === null
      ? db
          .prepare(
            `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity)
             VALUES (?, ?, ?, NULL, ?)
             ON CONFLICT(shop_id, product_id) WHERE variant_id IS NULL
             DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now')`
          )
          .bind(crypto.randomUUID(), m.shopId, m.productId, m.quantityDelta)
      : db
          .prepare(
            `INSERT INTO stock_levels (id, shop_id, product_id, variant_id, quantity)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(shop_id, product_id, variant_id) WHERE variant_id IS NOT NULL
             DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now')`
          )
          .bind(crypto.randomUUID(), m.shopId, m.productId, m.variantId, m.quantityDelta);
  return [movement, level];
}
