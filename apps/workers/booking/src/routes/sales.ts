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
import {
  createCheckoutSession,
  createRefund,
  isDefiniteStripeRefusal,
  listRefundsForPaymentIntent,
} from "../lib/stripe.js";
import { expireSessionBestEffort } from "../lib/checkout-expiry.js";
import { voidRefusal, voidSale, type VoidableSale } from "../lib/sale-void.js";
import { calculateCommissionPence, readJsonObject } from "@repo/utils";
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
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, statusOutcome } from "../audit/context.js";

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

  const body = await readJsonObject<{
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
  }>(c.req);
  if (!body) {
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

  // Audit (Plan 3, pattern T): everything from the stock claim to the response
  // runs inside `run`, so a lost claim (400) records refused and a Stripe
  // failure (502) records failed. The body below is the original, not
  // re-indented. `shopId` is a resolved id: shopExists matched it above.
  try {
    return await auditFor(c).run(
      { action: "pos.sale", shopId, entityType: "sale", entityId: saleId },
      async (): Promise<Response> => {
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
        // The customer pays at the counter, so the QR page need not outlive
        // the visit: Stripe's default is 24 hours. Stripe's minimum is 30
        // minutes from creation; 31 keeps clock skew safe.
        expiresAtEpochS: Math.floor(Date.now() / 1000) + 31 * 60,
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
      },
      statusOutcome((res) =>
        res.status < 400
          ? {
              changes: { status: [null, isRecordOnly ? "completed" : "pending"] as [unknown, unknown] },
              details: { tender, lines: lines.length, total_pence: customerTotalPence },
            }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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

  const body = await readJsonObject<{
    lines?: Array<{ sale_item_id?: string; quantity?: number; restock?: boolean }>;
    reason?: string;
  }>(c.req);
  if (!body) {
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
        { success: false, error: `Invalid quantity: ${item.quantity - item.returned_quantity} returnable on that line` },
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

  // Audit (Plan 3, pattern T): everything from the return claim to the
  // response runs inside `run`, so a lost claim (409) records refused and a
  // Stripe failure (502) records failed. The body below is the original, not
  // re-indented. `sale.shop_id` is the resolved id from the row read above.
  // `finalizeFailed`: Stripe refunded and the return is on record, but its
  // refund id and restock could not be saved (details only).
  let finalizeFailed = false;
  try {
    return await auditFor(c).run(
      { action: "payment.refund.issue", shopId: sale.shop_id, entityType: "sale", entityId: saleId },
      async (): Promise<Response> => {
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
    const won = priced
      .filter((_, i) => (claims[i]?.meta?.changes ?? 0) === 1)
      .map(({ item, qty }) =>
        db.prepare("UPDATE sale_items SET returned_quantity = returned_quantity - ? WHERE id = ?").bind(qty, item.id)
      );
    // D1 rejects an empty batch ("No SQL statements detected"), which turned a
    // total loss (no line claimed) into a 500 instead of the 409 below.
    if (won.length > 0) await db.batch(won);
    return c.json({ success: false, error: "Another refund touched this sale. Reload and try again." }, 409);
  }

  const returnId = crypto.randomUUID();
  const isStripe = sale.tender_type === "stripe";
  const refundTxId = crypto.randomUUID();
  const ledgerRowId = crypto.randomUUID();
  const lines = priced.map((p) => ({ ...p, rowId: crypto.randomUUID() }));
  const releaseClaims = (): D1PreparedStatement[] =>
    priced.map(({ item, qty }) =>
      db.prepare("UPDATE sale_items SET returned_quantity = returned_quantity - ? WHERE id = ?").bind(qty, item.id)
    );
  const restockStatements = (line: (typeof lines)[number]): D1PreparedStatement[] =>
    line.restock && line.item.product_id
      ? stockMovementStatements(db, {
          shopId,
          productId: line.item.product_id,
          variantId: line.item.variant_id,
          type: "return",
          quantityDelta: line.qty,
          unitCostPence: null,
          referenceType: "sale_return",
          referenceId: returnId,
          staffId: line.item.staff_id,
          note: "Customer return",
        })
      : [];

  // Record the return BEFORE any money moves, for every tender. The first
  // statement is the guard: it writes NULL into the NOT NULL sales.status
  // (migration 035) unless the sale is still 'completed', so a void, dispute
  // or full refund that landed after the checks above rolls the whole record
  // back. A Stripe return starts 'pending' with no refund id yet. If
  // charge.refunded arrives before this request finishes, it finds this
  // return and completes it, rather than booking the same money a second time
  // as a dashboard refund. Record-only tenders settle here (the shop hands the
  // cash back), restock included; a Stripe return restocks once Stripe has
  // accepted the refund.
  //
  // The guard also reads refunded_pence as it stands, not as the checks above
  // read it, so a concurrent refund of other lines can neither push the sale
  // past its total (rolled back, 409) nor leave a record-only sale that this
  // refund completes still 'completed' (it flips to 'refunded' here). Stripe
  // sales flip on charge.refunded, as before.
  const record: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sales SET status = CASE
           WHEN status = 'completed' AND refunded_pence + ?1 <= subtotal_pence - discount_pence
           THEN CASE WHEN ?2 = 1 AND refunded_pence + ?1 >= subtotal_pence - discount_pence THEN 'refunded' ELSE 'completed' END
           ELSE NULL END,
           refunded_pence = refunded_pence + ?1
         WHERE id = ?3 AND shop_id = ?4`
      )
      .bind(refundPence, isStripe ? 0 : 1, saleId, shopId),
    db
      .prepare(
        `INSERT INTO sale_returns (id, shop_id, sale_id, refund_pence, commission_reversal_pence,
           tender_type, status, stripe_refund_id, reason, created_by, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        returnId,
        shopId,
        saleId,
        refundPence,
        commissionReversalPence,
        sale.tender_type,
        isStripe ? "pending" : "completed",
        typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null,
        user.sub,
        isStripe ? null : new Date().toISOString()
      ),
  ];
  for (const line of lines) {
    const restockNow = !isStripe && line.restock;
    record.push(
      db
        .prepare(
          `INSERT INTO sale_return_items (id, return_id, shop_id, sale_item_id, quantity, refund_pence, restocked)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(line.rowId, returnId, shopId, line.item.id, line.qty, line.refundPence, restockNow ? 1 : 0)
    );
    if (restockNow) record.push(...restockStatements(line));
  }
  // Compensating ledger row: negative amounts at the sale's snapshot rates.
  // 'pending' matches the sale flow — record-only commission is owed (netted
  // off), Stripe flips to 'transferred' when charge.refunded confirms the fee
  // actually came back.
  record.push(
    db
      .prepare(
        `INSERT INTO bw_commission_ledger (id, shop_id, business_day_id, booking_id, sale_id,
           services_amount_pence, retail_amount_pence, commission_rate, retail_commission_rate,
           commission_amount_pence, commission_bearer, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(
        ledgerRowId,
        shopId,
        sale.business_day_id,
        saleId,
        -refundServicesPence,
        -refundRetailPence,
        commissionRate,
        retailCommissionRate,
        -commissionReversalPence,
        commissionBearer
      ),
    db
      .prepare(
        `INSERT INTO bw_transactions (id, booking_id, sale_id, shop_id, type, amount_pence, status, stripe_id)
         VALUES (?, NULL, ?, ?, 'refund', ?, ?, NULL)`
      )
      .bind(refundTxId, saleId, shopId, customerRefundPence, isStripe ? "pending" : "completed"),
    // Read back in the same transaction: the answer's fully_refunded is the
    // sale as this refund left it, not as the checks above read it.
    db.prepare("SELECT refunded_pence, subtotal_pence, discount_pence FROM sales WHERE id = ?").bind(saleId)
  );
  let fullyRefunded: boolean;
  try {
    const results = await db.batch(record);
    const after = results[results.length - 1]?.results?.[0] as
      | { refunded_pence: number; subtotal_pence: number; discount_pence: number }
      | undefined;
    fullyRefunded = after
      ? Number(after.refunded_pence) >= Number(after.subtotal_pence) - Number(after.discount_pence)
      : false;
  } catch (e) {
    const now = await db
      .prepare("SELECT status, refunded_pence, subtotal_pence, discount_pence FROM sales WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(saleId, shopId)
      .first<{ status: string; refunded_pence: number; subtotal_pence: number; discount_pence: number }>();
    await db.batch(releaseClaims());
    if (
      now &&
      (now.status !== "completed" ||
        Number(now.refunded_pence) + refundPence > Number(now.subtotal_pence) - Number(now.discount_pence))
    ) {
      return c.json({ success: false, error: "This sale changed while refunding. Reload and try again." }, 409);
    }
    throw e;
  }

  if (isStripe) {
    let stripeRefundId: string | null = null;
    let stripeError: unknown = null;
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
      stripeError = e;
      reportError("sale.refund_stripe", e, { shopId, saleId, returnId });
      // A 5xx or a network failure is ambiguous: the refund may have gone
      // through. Ask Stripe before undoing anything, so a cashier's retry can
      // never refund the same units twice. A refusal (4xx) certainly did nothing.
      if (!isDefiniteStripeRefusal(e)) {
        try {
          const refunds = await listRefundsForPaymentIntent(c.env.STRIPE_SECRET_KEY, sale.stripe_payment_intent_id!);
          stripeRefundId = refunds.find((r) => r.metadata.returnId === returnId)?.id || null;
        } catch (lookupErr) {
          reportError("sale.refund_lookup", lookupErr, { shopId, saleId, returnId });
        }
      }
    }
    if (!stripeRefundId) {
      // Nothing was refunded (or Stripe could not say, which is treated as
      // nothing, as before): remove the record and give the claimed
      // quantities back. If an unrelated charge.refunded counted this return
      // towards a full refund meanwhile, the sale goes back to completed.
      await db.batch([
        db.prepare("DELETE FROM sale_return_items WHERE return_id = ?").bind(returnId),
        db.prepare("DELETE FROM sale_returns WHERE id = ?").bind(returnId),
        db.prepare("DELETE FROM bw_commission_ledger WHERE id = ?").bind(ledgerRowId),
        db.prepare("DELETE FROM bw_transactions WHERE id = ?").bind(refundTxId),
        db.prepare("UPDATE sales SET refunded_pence = refunded_pence - ? WHERE id = ?").bind(refundPence, saleId),
        db
          .prepare(
            "UPDATE sales SET status = 'completed' WHERE id = ? AND status = 'refunded' AND refunded_pence < subtotal_pence - discount_pence"
          )
          .bind(saleId),
        ...releaseClaims(),
      ]);
      return c.json(
        { success: false, error: stripeError instanceof Error ? stripeError.message : "Stripe refund failed" },
        502
      );
    }

    // Stripe accepted the refund: stamp its id and restock. The money and its
    // record already stand, so a failure here is reported, not answered: the
    // return stays on record (charge.refunded completes it) and the claim
    // stays held, so a retry cannot refund the same units again.
    const finalize: D1PreparedStatement[] = [
      db.prepare("UPDATE sale_returns SET stripe_refund_id = ? WHERE id = ?").bind(stripeRefundId, returnId),
      db.prepare("UPDATE bw_transactions SET stripe_id = ? WHERE id = ?").bind(stripeRefundId, refundTxId),
    ];
    for (const line of lines) {
      if (!line.restock) continue;
      finalize.push(
        ...restockStatements(line),
        db.prepare("UPDATE sale_return_items SET restocked = 1 WHERE id = ?").bind(line.rowId)
      );
    }
    try {
      await db.batch(finalize);
    } catch (e) {
      finalizeFailed = true;
      reportError("sale.refund_finalize", e, { shopId, saleId, returnId });
    }
  }

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
      },
      statusOutcome((res) =>
        res.status < 400
          ? {
              details: {
                lines: priced.length,
                refund_pence: refundPence,
                via_stripe: sale.tender_type === "stripe",
                ...(finalizeFailed ? { finalized: false } : {}),
              },
            }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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
    .prepare(
      "SELECT id, status, tender_type, refunded_pence, stripe_checkout_session_id FROM sales WHERE id = ? AND shop_id = ? LIMIT 1"
    )
    .bind(saleId, shopId)
    .first<VoidableSale & { id: string; stripe_checkout_session_id: string | null }>();
  if (!sale) {
    return c.json({ success: false, error: "Sale not found" }, 404);
  }
  const refusal = voidRefusal(sale);
  if (refusal) {
    return c.json({ success: false, error: refusal }, 400);
  }

  // Audit (Plan 3, pattern T): from the guarded flip to the response. The
  // status change is recorded only when this request's flip won the claim.
  // `sale` was read WHERE shop_id = shopId, so shopId is a resolved id.
  // A lost flip (a concurrent void, a settle that made a Stripe sale paid, or
  // a refund) never answers success: it answers what a fresh read finds and
  // is recorded refused, not_voidable.
  let flip: { claimed: boolean; before: string | null } = { claimed: false, before: null };
  try {
    return await auditFor(c).run(
      { action: "pos.void", shopId, entityType: "sale", entityId: saleId },
      async (): Promise<Response> => {
        flip = await voidSale(db, shopId, saleId, null);
        if (flip.claimed) {
          // A pending Stripe sale's QR Checkout stays payable for Stripe's
          // default 24 hours: close it, best effort, so nobody pays for a sale
          // that no longer exists.
          if (flip.before === "pending" && sale.tender_type === "stripe") {
            await expireSessionBestEffort(c.env.STRIPE_SECRET_KEY, sale.stripe_checkout_session_id, { saleId });
          }
          return c.json({ success: true });
        }
        const now = await db
          .prepare("SELECT status, tender_type, refunded_pence FROM sales WHERE id = ? AND shop_id = ? LIMIT 1")
          .bind(saleId, shopId)
          .first<VoidableSale>();
        const found = now ? voidRefusal(now) : null;
        return found
          ? c.json({ success: false, error: found }, 400)
          : c.json({ success: false, error: "This sale changed while voiding. Reload and try again." }, 409);
      },
      statusOutcome((res) => {
        if (!flip.claimed) return { reason: "not_voidable" };
        return res.status < 400 ? { changes: { status: [flip.before, "voided"] as [unknown, unknown] } } : {};
      })
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default r;
