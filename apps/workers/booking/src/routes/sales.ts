/**
 * WS-3 Phase 1: counter POS on the unified sales spine.
 *
 * Mounted under /booking/shops (auth + requireShopAccess: developer, or the
 * shop's own admin/staff). Ringing a sale is allowed for staff (user decision
 * P5); voiding is admin/developer only.
 *
 * Tenders:
 *   cash / card_external — record-only: the shop takes the money itself; the
 *     sale completes immediately and the platform commission is ledgered as
 *     owed ('pending' — WS-2 honesty: never 'transferred' without settlement).
 *   stripe — a hosted Checkout Session on the shop's Connect account
 *     (destination charge, application fee = commission). The counter shows
 *     the session URL as a QR; payment_intent.succeeded settles the sale.
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import { getUser } from "../middleware/auth.js";
import { shopExists } from "../middleware/shop-access.js";
import { todayUtcYmd } from "../lib/time.js";
import { d1Rows } from "../lib/d1-helpers.js";
import { createCheckoutSession, createRefund } from "../lib/stripe.js";
import { calculateCommissionPence } from "@repo/utils";
import {
  SaleInputError,
  resolveSaleLines,
  resolveConsumption,
  sumByType,
  computeCommission,
  buildSaleBatch,
  stockMovementStatements,
  claimSaleStock,
  releaseSaleStock,
  type SaleLineInput,
} from "../lib/sales-core.js";
import { reportError } from "../services/report-error.js";

const r = new Hono<{ Bindings: Env }>();

const isHttps = (u: unknown): u is string =>
  typeof u === "string" && (u.startsWith("https://") || u.startsWith("http://localhost"));

function nonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

r.post("/:shopId/sales", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: {
    items?: SaleLineInput[];
    discount_pence?: number;
    tip_pence?: number;
    tender?: string;
    staff_id?: string | null;
    customer_name?: string | null;
    customer_email?: string | null;
    note?: string | null;
    success_url?: string;
    cancel_url?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const tender = body.tender;
  if (tender !== "cash" && tender !== "card_external" && tender !== "stripe") {
    return c.json({ success: false, error: "tender must be cash, card_external or stripe" }, 400);
  }
  const discountPence = body.discount_pence ?? 0;
  const tipPence = body.tip_pence ?? 0;
  if (!nonNegInt(discountPence) || !nonNegInt(tipPence)) {
    return c.json({ success: false, error: "discount_pence and tip_pence must be non-negative integers (pence)" }, 400);
  }

  let lines;
  try {
    lines = await resolveSaleLines(db, shopId, body.items ?? []);
  } catch (e) {
    if (e instanceof SaleInputError) {
      return c.json({ success: false, error: e.message }, 400);
    }
    throw e;
  }

  if (body.staff_id) {
    const staff = await db
      .prepare("SELECT id FROM staff WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(body.staff_id, shopId)
      .first<{ id: string }>();
    if (!staff) return c.json({ success: false, error: "Staff member not found for this shop" }, 400);
  }

  const { servicesPence, retailPence } = sumByType(lines);
  const subtotalPence = servicesPence + retailPence;
  if (discountPence > subtotalPence) {
    return c.json({ success: false, error: "Discount cannot exceed the subtotal" }, 400);
  }

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id, commission_rate, retail_commission_rate, name FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{
      stripe_connect_account_id: string | null;
      commission_rate: number;
      retail_commission_rate: number;
      name: string;
    }>();
  const settings = await db
    .prepare("SELECT commission_bearer FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ commission_bearer: string }>();
  const commissionBearer = settings?.commission_bearer ?? "shop";
  const commissionRate = Number(shopRow?.commission_rate ?? 0.1);
  const retailCommissionRate = Number(shopRow?.retail_commission_rate ?? commissionRate);

  const { discountedServicesPence, discountedRetailPence, commissionPence } = computeCommission({
    servicesPence,
    retailPence,
    discountPence,
    commissionRate,
    retailCommissionRate,
  });
  const baseTotalPence = subtotalPence - discountPence + tipPence;
  const customerTotalPence = commissionBearer === "customer" ? baseTotalPence + commissionPence : baseTotalPence;

  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (tender === "stripe") {
    if (!connectId) {
      return c.json({ success: false, error: "Stripe Connect not configured" }, 400);
    }
    if (customerTotalPence <= 0) {
      return c.json({ success: false, error: "Stripe payment requires a total greater than zero" }, 400);
    }
    if (!isHttps(body.success_url) || !isHttps(body.cancel_url)) {
      return c.json({ success: false, error: "success_url and cancel_url must be https URLs" }, 400);
    }
  }

  const openDay = await db
    .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? AND status = 'open' LIMIT 1")
    .bind(shopId, todayUtcYmd())
    .first<{ id: string }>();

  const saleId = crypto.randomUUID();
  const isRecordOnly = tender !== "stripe";
  const consumption = await resolveConsumption(db, shopId, lines);

  // Oversell floor: atomically claim tracked stock before the sale persists.
  // A losing claim names the short products; the cashier fixes the count (or
  // unticks track_stock on the product) and re-rings.
  const stockClaim = await claimSaleStock(db, shopId, lines);
  if (!stockClaim.ok) {
    return c.json(
      { success: false, error: `Not enough stock: ${stockClaim.insufficient.join(", ")}` },
      400
    );
  }

  try {
    await db.batch(
      buildSaleBatch(db, {
        saleId,
        shopId,
        businessDayId: openDay?.id ?? null,
        staffId: body.staff_id ?? null,
        customerName: body.customer_name?.toString().trim() || null,
        customerEmail: body.customer_email?.toString().trim() || null,
        lines,
        consumption,
        subtotalPence,
        discountPence,
        tipPence,
        totalPence: customerTotalPence,
        tenderType: tender,
        status: isRecordOnly ? "completed" : "pending",
        note: body.note?.toString().trim() || null,
        ledger: {
          servicesAmountPence: discountedServicesPence,
          retailAmountPence: discountedRetailPence,
          commissionRate,
          retailCommissionRate,
          commissionPence,
          commissionBearer,
          // Record-only money never settles through Stripe, so the commission
          // stays 'pending' (owed) — it is collected out-of-band.
          status: "pending",
        },
        transactions: [
          {
            type: "sale",
            amountPence: customerTotalPence,
            status: isRecordOnly ? "captured" : "pending",
          },
        ],
      })
    );
  } catch (e) {
    // The sale never persisted (batch is atomic) — give the claimed stock back.
    await releaseSaleStock(db, shopId, stockClaim.claims);
    throw e;
  }

  let paymentUrl: string | null = null;
  if (tender === "stripe") {
    try {
      const session = await createCheckoutSession({
        secret: c.env.STRIPE_SECRET_KEY,
        amountPence: customerTotalPence,
        currency: "gbp",
        productName: `Sale at ${shopRow?.name ?? "shop"}`,
        destinationAccount: connectId!,
        applicationFeePence: commissionPence,
        metadata: { saleId, shopId, type: "sale" },
        successUrl: body.success_url!,
        cancelUrl: body.cancel_url!,
        idempotencyKey: `sale:${saleId}`,
      });
      paymentUrl = session.url;
      await db.batch([
        db
          .prepare("UPDATE sales SET stripe_checkout_session_id = ? WHERE id = ?")
          .bind(session.id, saleId),
        db
          .prepare("UPDATE bw_transactions SET stripe_id = ? WHERE sale_id = ?")
          .bind(session.id, saleId),
      ]);
    } catch (e) {
      // Undo the pending sale so stock and the ledger stay truthful; the
      // cashier simply retries once Stripe recovers.
      reportError("sale.checkout_session", e, { shopId, saleId });
      await voidSale(db, shopId, saleId, "Stripe session creation failed");
      return c.json({ success: false, error: e instanceof Error ? e.message : "Stripe error" }, 502);
    }
  }

  return c.json({
    success: true,
    sale: {
      id: saleId,
      status: isRecordOnly ? "completed" : "pending",
      subtotal_pence: subtotalPence,
      discount_pence: discountPence,
      tip_pence: tipPence,
      commission_pence: commissionBearer === "customer" ? commissionPence : 0,
      total_pence: customerTotalPence,
      tender_type: tender,
      payment_url: paymentUrl,
    },
  });
});

r.get("/:shopId/sales", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }
  const date = c.req.query("date") || todayUtcYmd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
  }
  const rows = await db
    .prepare(
      `SELECT id, booking_id, staff_id, customer_name, subtotal_pence, discount_pence, tip_pence,
              total_pence, tender_type, status, created_at, completed_at
       FROM sales
       WHERE shop_id = ? AND substr(created_at, 1, 10) = ?
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .bind(shopId, date)
    .all();
  return c.json({ success: true, data: d1Rows(rows) });
});

r.get("/:shopId/sales/:saleId", async (c) => {
  const shopId = c.req.param("shopId");
  const saleId = c.req.param("saleId");
  const db = c.env.DB;
  const sale = await db
    .prepare("SELECT * FROM sales WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(saleId, shopId)
    .first<Record<string, unknown>>();
  if (!sale) {
    return c.json({ success: false, error: "Sale not found" }, 404);
  }
  const items = await db
    .prepare(
      `SELECT id, item_type, service_id, product_id, variant_id, name, quantity,
              returned_quantity, unit_price_pence, line_total_pence, staff_id
       FROM sale_items WHERE sale_id = ? ORDER BY created_at`
    )
    .bind(saleId)
    .all();
  const returns = await db
    .prepare(
      `SELECT id, refund_pence, commission_reversal_pence, tender_type, status, reason, created_at, completed_at
       FROM sale_returns WHERE sale_id = ? ORDER BY created_at DESC`
    )
    .bind(saleId)
    .all();
  return c.json({ success: true, data: { ...sale, items: d1Rows(items), returns: d1Rows(returns) } });
});

// ─── POST /:shopId/sales/:saleId/refund — per-line returns (WS-3 Phase 2) ─────
//
// Admin/developer only. Refunds specific quantities of specific lines; the
// refund amount is the discounted line value (sale-level discount allocated
// pro-rata, same split as computeCommission) and tips are never refunded here.
// Product lines restock by default ('return' movements); back-bar consumption
// is NOT restored — those products were used on the client.
//
// Tenders: cash/card_external are record-only (the shop hands money back
// itself; books settle immediately). stripe calls POST /v1/refunds with
// refund_application_fee + reverse_transfer so the platform commission comes
// back proportionally; charge.refunded completes the return (WS-2 honesty:
// nothing is marked settled before Stripe confirms).

r.post("/:shopId/sales/:saleId/refund", async (c) => {
  const shopId = c.req.param("shopId");
  const saleId = c.req.param("saleId");
  const db = c.env.DB;
  const user = getUser(c);
  if (user.role !== "admin" && user.role !== "developer") {
    return c.json({ success: false, error: "Admin role required" }, 403);
  }

  let body: {
    lines?: Array<{ sale_item_id?: string; quantity?: number; restock?: boolean }>;
    reason?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ success: false, error: "lines is required" }, 400);
  }

  const sale = await db
    .prepare(
      `SELECT id, shop_id, subtotal_pence, discount_pence, refunded_pence, tender_type, status,
              stripe_payment_intent_id, business_day_id
       FROM sales WHERE id = ? AND shop_id = ? LIMIT 1`
    )
    .bind(saleId, shopId)
    .first<{
      id: string; shop_id: string; subtotal_pence: number; discount_pence: number;
      refunded_pence: number; tender_type: string; status: string;
      stripe_payment_intent_id: string | null; business_day_id: string | null;
    }>();
  if (!sale) return c.json({ success: false, error: "Sale not found" }, 404);
  if (sale.status !== "completed") {
    return c.json({ success: false, error: "Only completed sales can be refunded (void pending sales instead)" }, 400);
  }
  if (sale.tender_type === "stripe" && !sale.stripe_payment_intent_id) {
    return c.json({ success: false, error: "This Stripe sale has no settled payment to refund" }, 400);
  }

  const itemRows = await db
    .prepare(
      `SELECT id, item_type, product_id, variant_id, quantity, returned_quantity,
              unit_price_pence, line_total_pence, staff_id
       FROM sale_items WHERE sale_id = ?`
    )
    .bind(saleId)
    .all<{
      id: string; item_type: string; product_id: string | null; variant_id: string | null;
      quantity: number; returned_quantity: number; unit_price_pence: number;
      line_total_pence: number; staff_id: string | null;
    }>();
  const itemById = new Map((itemRows.results ?? []).map((i) => [i.id, i]));

  // The ledger row snapshots the rates in force when the sale was made —
  // reverse commission at THOSE rates, not today's.
  const ledgerRow = await db
    .prepare(
      `SELECT commission_rate, retail_commission_rate, commission_bearer
       FROM bw_commission_ledger WHERE sale_id = ? AND commission_amount_pence >= 0 LIMIT 1`
    )
    .bind(saleId)
    .first<{ commission_rate: number; retail_commission_rate: number; commission_bearer: string }>();
  const commissionRate = Number(ledgerRow?.commission_rate ?? 0.1);
  const retailCommissionRate = Number(ledgerRow?.retail_commission_rate ?? commissionRate);
  const commissionBearer = ledgerRow?.commission_bearer ?? "shop";

  // Validate + price the requested lines.
  const seen = new Set<string>();
  const priced: Array<{
    item: (typeof itemRows.results)[number]; qty: number; restock: boolean; refundPence: number;
  }> = [];
  let refundServicesPence = 0;
  let refundRetailPence = 0;
  for (const line of body.lines) {
    const item = line.sale_item_id ? itemById.get(line.sale_item_id) : undefined;
    if (!item) return c.json({ success: false, error: "Unknown sale item" }, 400);
    if (seen.has(item.id)) return c.json({ success: false, error: "Duplicate line for the same item" }, 400);
    seen.add(item.id);
    const qty = line.quantity ?? 0;
    if (!Number.isInteger(qty) || qty < 1 || qty > item.quantity - item.returned_quantity) {
      return c.json(
        { success: false, error: `Invalid quantity — ${item.quantity - item.returned_quantity} returnable on that line` },
        400
      );
    }
    const discountShare =
      sale.subtotal_pence > 0
        ? Math.round((sale.discount_pence * item.line_total_pence) / sale.subtotal_pence)
        : 0;
    const refundPence = Math.round(((item.line_total_pence - discountShare) * qty) / item.quantity);
    if (item.item_type === "service") refundServicesPence += refundPence;
    else refundRetailPence += refundPence;
    priced.push({
      item,
      qty,
      restock: item.item_type === "product" && item.product_id !== null && line.restock !== false,
      refundPence,
    });
  }

  let refundPence = refundServicesPence + refundRetailPence;
  const refundable = sale.subtotal_pence - sale.discount_pence - sale.refunded_pence;
  refundPence = Math.min(refundPence, Math.max(0, refundable));
  if (refundPence <= 0) {
    return c.json({ success: false, error: "Nothing left to refund on this sale" }, 400);
  }
  const commissionReversalPence =
    calculateCommissionPence(refundServicesPence, commissionRate).commission_pence +
    calculateCommissionPence(refundRetailPence, retailCommissionRate).commission_pence;
  // The customer paid the commission on top when the shop passes it through —
  // give their share back too.
  const customerRefundPence =
    refundPence + (commissionBearer === "customer" ? commissionReversalPence : 0);
  const fullyRefunded = sale.refunded_pence + refundPence >= sale.subtotal_pence - sale.discount_pence;

  // Atomic claim on the returnable quantities: a concurrent refund of the
  // same line loses (its guarded UPDATE matches 0 rows) and is compensated.
  const claims = await db.batch(
    priced.map(({ item, qty }) =>
      db
        .prepare(
          "UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ? AND quantity - returned_quantity >= ?"
        )
        .bind(qty, item.id, qty)
    )
  );
  const lost = claims.some((r) => (r.meta?.changes ?? 0) !== 1);
  if (lost) {
    await db.batch(
      priced
        .filter((_, i) => (claims[i]?.meta?.changes ?? 0) === 1)
        .map(({ item, qty }) =>
          db.prepare("UPDATE sale_items SET returned_quantity = returned_quantity - ? WHERE id = ?").bind(qty, item.id)
        )
    );
    return c.json({ success: false, error: "Another refund touched this sale — reload and try again" }, 409);
  }

  const returnId = crypto.randomUUID();
  const isStripe = sale.tender_type === "stripe";
  let stripeRefundId: string | null = null;

  if (isStripe) {
    try {
      const refund = await createRefund({
        secret: c.env.STRIPE_SECRET_KEY,
        paymentIntentId: sale.stripe_payment_intent_id!,
        amountPence: customerRefundPence,
        metadata: { saleId, returnId, shopId, type: "sale_refund" },
        idempotencyKey: `refund:${returnId}`,
      });
      stripeRefundId = refund.id;
    } catch (e) {
      // Give the claimed quantities back — nothing was refunded.
      reportError("sale.refund_stripe", e, { shopId, saleId, returnId });
      await db.batch(
        priced.map(({ item, qty }) =>
          db.prepare("UPDATE sale_items SET returned_quantity = returned_quantity - ? WHERE id = ?").bind(qty, item.id)
        )
      );
      return c.json({ success: false, error: e instanceof Error ? e.message : "Stripe refund failed" }, 502);
    }
  }

  // Persist the return. Record-only tenders settle immediately (the shop
  // hands the cash back); Stripe stays 'pending' until charge.refunded.
  const stmts = [
    db
      .prepare(
        `INSERT INTO sale_returns (id, shop_id, sale_id, refund_pence, commission_reversal_pence,
           tender_type, status, stripe_refund_id, reason, created_by, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        returnId,
        shopId,
        saleId,
        refundPence,
        commissionReversalPence,
        sale.tender_type,
        isStripe ? "pending" : "completed",
        stripeRefundId,
        typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null,
        user.sub,
        isStripe ? null : new Date().toISOString()
      ),
  ];
  for (const { item, qty, restock, refundPence: linePence } of priced) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO sale_return_items (id, return_id, shop_id, sale_item_id, quantity, refund_pence, restocked)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), returnId, shopId, item.id, qty, linePence, restock ? 1 : 0)
    );
    if (restock && item.product_id) {
      stmts.push(
        ...stockMovementStatements(db, {
          shopId,
          productId: item.product_id,
          variantId: item.variant_id,
          type: "return",
          quantityDelta: qty,
          unitCostPence: null,
          referenceType: "sale_return",
          referenceId: returnId,
          staffId: item.staff_id,
          note: "Customer return",
        })
      );
    }
  }
  // Compensating ledger row: negative amounts at the sale's snapshot rates.
  // 'pending' matches the sale flow — record-only commission is owed (netted
  // off), Stripe flips to 'transferred' when charge.refunded confirms the fee
  // actually came back.
  stmts.push(
    db
      .prepare(
        `INSERT INTO bw_commission_ledger (id, shop_id, business_day_id, booking_id, sale_id,
           services_amount_pence, retail_amount_pence, commission_rate, retail_commission_rate,
           commission_amount_pence, commission_bearer, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(
        crypto.randomUUID(),
        shopId,
        sale.business_day_id,
        saleId,
        -refundServicesPence,
        -refundRetailPence,
        commissionRate,
        retailCommissionRate,
        -commissionReversalPence,
        commissionBearer
      )
  );
  stmts.push(
    db
      .prepare(
        `INSERT INTO bw_transactions (id, booking_id, sale_id, shop_id, type, amount_pence, status, stripe_id)
         VALUES (?, NULL, ?, ?, 'refund', ?, ?, ?)`
      )
      .bind(crypto.randomUUID(), saleId, shopId, customerRefundPence, isStripe ? "pending" : "completed", stripeRefundId)
  );
  stmts.push(
    db
      .prepare(
        `UPDATE sales SET refunded_pence = refunded_pence + ?${!isStripe && fullyRefunded ? ", status = 'refunded'" : ""} WHERE id = ?`
      )
      .bind(refundPence, saleId)
  );
  await db.batch(stmts);

  return c.json({
    success: true,
    data: {
      id: returnId,
      refund_pence: refundPence,
      customer_refund_pence: customerRefundPence,
      commission_reversal_pence: commissionReversalPence,
      status: isStripe ? "pending" : "completed",
      fully_refunded: fullyRefunded,
    },
  });
});

r.post("/:shopId/sales/:saleId/void", async (c) => {
  const shopId = c.req.param("shopId");
  const saleId = c.req.param("saleId");
  const db = c.env.DB;
  const user = getUser(c);
  if (user.role !== "admin" && user.role !== "developer") {
    return c.json({ success: false, error: "Admin role required" }, 403);
  }

  const sale = await db
    .prepare("SELECT id, status, tender_type FROM sales WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(saleId, shopId)
    .first<{ id: string; status: string; tender_type: string }>();
  if (!sale) {
    return c.json({ success: false, error: "Sale not found" }, 404);
  }
  if (sale.status === "voided") {
    return c.json({ success: false, error: "Sale already voided" }, 400);
  }
  if (sale.tender_type === "stripe" && sale.status === "completed") {
    // Money already moved: that is a refund (Stripe dashboard → the
    // charge.refunded webhook flips the sale), not a void.
    return c.json({ success: false, error: "Paid Stripe sales must be refunded via Stripe, not voided" }, 400);
  }

  await voidSale(db, shopId, saleId, null);
  return c.json({ success: true });
});

/**
 * Void = the sale never effectively happened: mark it (and its tender/ledger
 * rows) voided and put decremented stock back with reversing movements, all
 * in one batch. Guarded by the atomic status flip — only one voider wins.
 */
async function voidSale(db: Env["DB"], shopId: string, saleId: string, note: string | null) {
  const claim = await db
    .prepare("UPDATE sales SET status = 'voided' WHERE id = ? AND shop_id = ? AND status IN ('pending','completed')")
    .bind(saleId, shopId)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return;

  const stmts = [
    db.prepare("UPDATE bw_transactions SET status = 'voided' WHERE sale_id = ?").bind(saleId),
    db.prepare("UPDATE bw_commission_ledger SET status = 'voided' WHERE sale_id = ?").bind(saleId),
  ];

  const movements = await db
    .prepare(
      `SELECT product_id, variant_id, quantity_delta, unit_cost_pence, staff_id
       FROM stock_movements WHERE shop_id = ? AND reference_type = 'sale' AND reference_id = ?`
    )
    .bind(shopId, saleId)
    .all();
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

  await db.batch(stmts);
}

export default r;
