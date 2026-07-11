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
import { createCheckoutSession } from "../lib/stripe.js";
import {
  SaleInputError,
  resolveSaleLines,
  sumByType,
  computeCommission,
  buildSaleBatch,
  stockMovementStatements,
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

  await db.batch(
    buildSaleBatch(db, {
      saleId,
      shopId,
      businessDayId: openDay?.id ?? null,
      staffId: body.staff_id ?? null,
      customerName: body.customer_name?.toString().trim() || null,
      customerEmail: body.customer_email?.toString().trim() || null,
      lines,
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
              unit_price_pence, line_total_pence, staff_id
       FROM sale_items WHERE sale_id = ? ORDER BY created_at`
    )
    .bind(saleId)
    .all();
  return c.json({ success: true, data: { ...sale, items: d1Rows(items) } });
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
