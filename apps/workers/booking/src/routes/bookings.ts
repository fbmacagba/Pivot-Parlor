import { Hono } from "hono";
import type { Env } from "../types.js";
import { shopExists } from "../middleware/shop-access.js";
import { addMinutesToHm, todayUtcYmd } from "../lib/time.js";
import { createPaymentIntentAutoCapture, createPaymentIntentManualCapture, capturePaymentIntent, cancelPaymentIntent, createRefund } from "../lib/stripe.js";
import {
  SaleInputError,
  resolveSaleLines,
  resolveConsumption,
  sumByType,
  computeCommission,
  buildSaleBatch,
  claimSaleStock,
  releaseSaleStock,
  type ResolvedLine,
} from "../lib/sales-core.js";
import { reportError } from "../services/report-error.js";
import { calculateCommissionPence } from "@repo/utils";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, batchWithAudit, statusOutcome } from "../audit/context.js";

const r = new Hono<{ Bindings: Env }>();

r.post("/:shopId/bookings/:bookingId/checkout", async (c) => {
  const shopId = c.req.param("shopId");
  const bookingId = c.req.param("bookingId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  // Products are catalogue references now (WS-3): the server prices them and
  // decrements stock — free-text {name, price} lines are no longer accepted.
  let body: {
    extraServices?: { serviceId: string; quantity: number }[];
    products?: { productId: string; variantId?: string | null; quantity: number }[];
    tipPercent?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const booking = await db
    .prepare("SELECT * FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(bookingId, shopId)
    .first<Record<string, unknown>>();
  if (!booking) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }
  if (booking.status === "completed") {
    return c.json({ success: false, error: "Already checked out" }, 400);
  }
  if (booking.status !== "confirmed") {
    return c.json({ success: false, error: "Booking must be confirmed and checked in to checkout" }, 400);
  }

  const st = await db
    .prepare("SELECT * FROM bw_booking_state WHERE booking_id = ?")
    .bind(bookingId)
    .first<Record<string, unknown>>();
  if (!st?.checked_in_at) {
    return c.json({ success: false, error: "Not checked in" }, 400);
  }

  // Atomic checkout claim (WS-2): flip confirmed → completed BEFORE any line
  // items or Stripe calls. A concurrent double-submit loses this UPDATE
  // (changes === 0) and cannot double-charge or duplicate items. On a Stripe
  // failure below the status is reverted so the checkout can be retried.
  //
  // Audit (Plan 3, pattern T): everything from the claim to the response runs
  // inside `run`, so a lost claim (409) records refused and a Stripe failure
  // (500) records failed. The body below is the original, not re-indented.
  let auditSaleId: string | null = null;
  let auditDepositCaptured = false;
  try {
    return await auditFor(c).run(
      { action: "booking.checkout", shopId, entityType: "booking", entityId: bookingId },
      async (): Promise<Response> => {
  const claim = await db
    .prepare("UPDATE bookings SET status = 'completed' WHERE id = ? AND shop_id = ? AND status = 'confirmed'")
    .bind(bookingId, shopId)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return c.json({ success: false, error: "Checkout already in progress or completed" }, 409);
  }

  // Any early exit after the claim must put the booking back to 'confirmed'
  // or it is stuck completed-but-unpaid.
  const revertClaim = () =>
    db
      .prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND shop_id = ? AND status = 'completed'")
      .bind(bookingId, shopId)
      .run();

  const settings = await db
    .prepare("SELECT commission_bearer FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ commission_bearer: string }>();
  const commissionBearer = settings?.commission_bearer ?? "shop";

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id, commission_rate, retail_commission_rate FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null; commission_rate: number; retail_commission_rate: number }>();
  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (!connectId) {
    await revertClaim();
    return c.json({ success: false, error: "Stripe Connect not configured" }, 400);
  }
  const commissionRate = Number(shopRow?.commission_rate ?? 0.1);
  const retailCommissionRate = Number(shopRow?.retail_commission_rate ?? commissionRate);

  // The base service line is the price agreed at booking time (post-promo),
  // which lives on bookings.amount_pence — pre-checkout line-item rows are
  // gone with bw_booking_items (migration 036).
  const baseSvc = await db
    .prepare("SELECT name FROM services WHERE id = ? LIMIT 1")
    .bind(booking.service_id)
    .first<{ name: string }>();
  const basePricePence = Number(booking.amount_pence ?? 0);
  const bookingStaffId = typeof booking.staff_id === "string" ? booking.staff_id : null;

  const lines: ResolvedLine[] = [
    {
      item_type: "service",
      service_id: String(booking.service_id),
      product_id: null,
      variant_id: null,
      name: baseSvc?.name ?? "Service",
      quantity: 1,
      unit_price_pence: basePricePence,
      cost_price_pence: 0,
      line_total_pence: basePricePence,
      staff_id: bookingStaffId,
      decrements_stock: false,
    },
  ];

  const extraInputs = [
    ...(body.extraServices ?? []).map((e) => ({
      type: "service" as const,
      serviceId: e.serviceId,
      quantity: e.quantity ?? 1,
      staffId: bookingStaffId,
    })),
    ...(body.products ?? []).map((p) => ({
      type: "product" as const,
      productId: p.productId,
      variantId: p.variantId ?? null,
      quantity: p.quantity ?? 1,
      staffId: bookingStaffId,
    })),
  ];
  if (extraInputs.length > 0) {
    try {
      lines.push(...(await resolveSaleLines(db, shopId, extraInputs)));
    } catch (e) {
      await revertClaim();
      if (e instanceof SaleInputError) {
        return c.json({ success: false, error: e.message }, 400);
      }
      throw e;
    }
  }

  const { servicesPence: servicesTotalPence, retailPence: productsTotalPence } = sumByType(lines);

  // Back-bar BOM for the base service + any service extras (WS-3 Phase 2).
  // Read-only, but it runs after the atomic status claim — any failure must
  // revert the claim like every other early exit.
  let consumption;
  try {
    consumption = await resolveConsumption(db, shopId, lines);
  } catch (e) {
    await revertClaim();
    throw e;
  }

  // Oversell floor: claim tracked product stock BEFORE any Stripe money moves,
  // so an insufficient cart fails cleanly instead of after a capture.
  let stockClaim;
  try {
    stockClaim = await claimSaleStock(db, shopId, lines);
  } catch (e) {
    await revertClaim();
    throw e;
  }
  if (!stockClaim.ok) {
    await revertClaim();
    return c.json(
      { success: false, error: `Not enough stock: ${stockClaim.insufficient.join(", ")}` },
      400
    );
  }

  const tipPct = [0, 5, 10, 15, 20].includes(Number(body.tipPercent)) ? Number(body.tipPercent) : 0;
  const subForTipPence = servicesTotalPence + productsTotalPence;
  const tipPence = Math.round((subForTipPence * tipPct) / 100);

  // Two commission rates (WS-3): the service rate on the service portion,
  // the shop's retail rate on the product portion. Rounding stays on the
  // WS-4 single path inside computeCommission.
  const { discountedServicesPence, discountedRetailPence, commissionPence } = computeCommission({
    servicesPence: servicesTotalPence,
    retailPence: productsTotalPence,
    discountPence: 0,
    commissionRate,
    retailCommissionRate,
  });
  const grandTotalPence = servicesTotalPence + productsTotalPence + tipPence;
  const customerTotalPence =
    commissionBearer === "customer" ? grandTotalPence + commissionPence : grandTotalPence;

  // Two deposit shapes (migration 041): a CHARGED deposit (hosted Checkout,
  // deposit_paid_at stamped by the webhook) is money already received — a
  // credit against today's total, never captured. A legacy HOLD (manual-
  // capture PI, no deposit_paid_at) is captured here exactly as before.
  // A REFUNDED deposit (cancel-with-refund, or an out-of-band Stripe refund)
  // must never be credited: the customer got that money back.
  const checkoutDepositTx = await db
    .prepare("SELECT status FROM bw_transactions WHERE booking_id = ? AND type = 'deposit' LIMIT 1")
    .bind(bookingId)
    .first<{ status: string }>();
  const depositRefunded = checkoutDepositTx?.status === "refunded";
  const depositPaid =
    !depositRefunded && typeof st.deposit_paid_at === "string" && st.deposit_paid_at.length > 0;
  const piId =
    !depositRefunded && !depositPaid && typeof st.stripe_payment_intent_id === "string"
      ? st.stripe_payment_intent_id.trim() || null
      : null;
  const depositPence = piId ? Number(st.deposit_amount_pence ?? 0) : 0;

  const captureFromHoldPence = piId ? Math.min(depositPence, customerTotalPence) : 0;
  const depositCreditPence = depositPaid
    ? Math.min(Number(st.deposit_amount_pence ?? 0), customerTotalPence)
    : 0;
  // The deposit charge already carried this much application fee; the balance
  // charge collects only the remaining commission so the platform's Stripe
  // take equals the ledger's commission exactly.
  const depositFeePaidPence = depositPaid ? Number(st.deposit_application_fee_pence ?? 0) : 0;
  const remainderPence = Math.max(0, customerTotalPence - captureFromHoldPence - depositCreditPence);
  const balanceApplicationFeePence = depositPaid
    ? Math.min(Math.max(0, commissionPence - depositFeePaidPence), remainderPence)
    : Math.min(commissionPence, remainderPence);

  let stripeChargeId = "";
  let balanceClientSecret: string | null = null;

  // Generated before the Stripe calls so the balance PI can carry it in
  // metadata — payment_intent.succeeded settles the sale by saleId.
  const saleId = crypto.randomUUID();
  auditSaleId = saleId;

  try {
    if (piId && captureFromHoldPence > 0) {
      // Deposit capture is synchronous — a repeated Idempotency-Key returns
      // the original capture instead of a second charge.
      const cap = await capturePaymentIntent(c.env.STRIPE_SECRET_KEY, piId, {
        ...(captureFromHoldPence < depositPence ? { amountPence: captureFromHoldPence } : {}),
        idempotencyKey: `capture:${bookingId}`,
      });
      // Set only once Stripe has taken the money: a later failure below
      // still records the capture (a failed capture never does).
      auditDepositCaptured = true;
      stripeChargeId = String((cap.latest_charge as string) ?? "");
    }

    let balancePiId: string | null = null;
    if (remainderPence > 0) {
      const bal = await createPaymentIntentAutoCapture({
        secret: c.env.STRIPE_SECRET_KEY,
        amountPence: remainderPence,
        currency: "gbp",
        destinationAccount: connectId,
        applicationFeePence: balanceApplicationFeePence,
        metadata: { shopId, bookingId, saleId, type: "balance" },
        idempotencyKey: `balance:${bookingId}`,
      });
      balanceClientSecret = bal.client_secret || null;
      balancePiId = bal.id;
      if (!stripeChargeId) {
        stripeChargeId = String(bal.latest_charge ?? bal.id ?? "");
      }
    }

    // Ledger honesty (WS-2): commission is 'transferred' only when all money
    // has actually settled. With an outstanding balance PI it stays 'pending'
    // until payment_intent.succeeded reconciles it (stripe-webhook.ts).
    const fullySettled = remainderPence === 0;
    const bd = await db
      .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? LIMIT 1")
      .bind(shopId, todayUtcYmd())
      .first<{ id: string }>();

    // The whole checkout persists atomically on the sales spine (WS-3):
    // sale header + line items + stock movements for catalogue products +
    // tender transactions + commission ledger + booking money columns.
    const nowIso = new Date().toISOString();
    const stmts = buildSaleBatch(db, {
      saleId,
      shopId,
      bookingId,
      businessDayId: bd?.id ?? null,
      staffId: bookingStaffId,
      customerName: typeof booking.customer_name === "string" ? booking.customer_name : null,
      customerEmail: typeof booking.customer_email === "string" ? booking.customer_email : null,
      lines,
      consumption,
      subtotalPence: servicesTotalPence + productsTotalPence,
      discountPence: 0,
      tipPence,
      totalPence: customerTotalPence,
      tenderType: "stripe",
      status: fullySettled ? "completed" : "pending",
      ledger: {
        servicesAmountPence: discountedServicesPence,
        retailAmountPence: discountedRetailPence,
        commissionRate,
        retailCommissionRate,
        commissionPence,
        commissionBearer,
        status: fullySettled ? "transferred" : "pending",
      },
      transactions: [
        ...(captureFromHoldPence > 0
          ? [{ type: "deposit_capture", amountPence: captureFromHoldPence, status: "captured", stripeId: piId ?? "", bookingId }]
          : []),
        ...(remainderPence > 0 && balancePiId
          ? [{ type: "balance", amountPence: remainderPence, status: "pending", stripeId: balancePiId, bookingId }]
          : []),
      ],
    });

    // A charged deposit's tx row was created at booking time against the
    // booking only — attach it to the sale so the sale's money trail is whole.
    if (depositCreditPence > 0) {
      stmts.push(
        db
          .prepare("UPDATE bw_transactions SET sale_id = ? WHERE booking_id = ? AND type = 'deposit'")
          .bind(saleId, bookingId)
      );
    }

    // bookings keeps only canonical columns; total_amount_pence + completed_at
    // live in bw_booking_state (completed_at only once fully settled).
    stmts.push(
      db
        .prepare(`UPDATE bookings SET amount_pence = ?, commission_pence = ? WHERE id = ? AND shop_id = ?`)
        .bind(customerTotalPence, commissionPence, bookingId, shopId),
      db
        .prepare(
          `UPDATE bw_booking_state SET total_amount_pence = ?, stripe_balance_pi = COALESCE(?, stripe_balance_pi),
             completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE booking_id = ?`
        )
        .bind(customerTotalPence, balancePiId, fullySettled ? nowIso : null, nowIso, bookingId)
    );

    await db.batch(stmts);

    return c.json({
      success: true,
      saleId,
      receipt: {
        services_pence: servicesTotalPence,
        products_pence: productsTotalPence,
        tip_pence: tipPence,
        subtotal_pence: grandTotalPence,
        commission_pence: commissionBearer === "customer" ? commissionPence : 0,
        total_pence: customerTotalPence,
        deposit_credit_pence: depositCreditPence,
        due_now_pence: remainderPence,
      },
      stripeChargeId,
      balanceClientSecret,
    });
  } catch (e) {
    // Revert the checkout claim AND the stock claim so the shop can retry once
    // Stripe recovers; the idempotency keys above make the retry safe. The
    // sale batch is atomic, so on any throw here no movement rows exist and
    // the release restores the exact pre-claim level.
    reportError("checkout.stripe", e, { shopId, bookingId });
    await revertClaim();
    await releaseSaleStock(db, shopId, stockClaim.claims);
    return c.json({ success: false, error: e instanceof Error ? e.message : "Checkout failed" }, 500);
  }
      },
      statusOutcome((res) => {
        if (res.status < 400) {
          return {
            changes: { status: ["confirmed", "completed"] },
            details: { sale_id: auditSaleId, deposit_captured: auditDepositCaptured },
          };
        }
        // Captured, then the balance PI or the persist batch failed: the
        // deposit is taken in Stripe though the booking reverted. No sale_id,
        // since the sale never persisted; changes stay null (a failure).
        if (res.status >= 500 && auditDepositCaptured) return { details: { deposit_captured: true } };
        return {};
      })
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

r.post("/:shopId/bookings", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: {
    serviceId: string;
    staffId: string;
    slotDate: string;
    slotTime: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    promoCode?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const av = await db
    .prepare(
      `SELECT id FROM bw_availability WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ? AND is_booked = 0 LIMIT 1`
    )
    .bind(shopId, body.staffId, body.slotDate, body.slotTime)
    .first<{ id: string }>();
  if (!av?.id) {
    return c.json({ success: false, error: "Slot not available" }, 400);
  }

  const service = await db
    .prepare("SELECT price_pence, duration_min FROM services WHERE id = ? AND shop_id = ? AND is_active = 1")
    .bind(body.serviceId, shopId)
    .first<{ price_pence: number; duration_min: number }>();
  if (!service) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  const settings = await db
    .prepare(
      "SELECT commission_bearer, promo_discount_code, promo_discount_percent FROM shop_settings WHERE shop_id = ? LIMIT 1"
    )
    .bind(shopId)
    .first<{
      commission_bearer: string;
      promo_discount_code: string | null;
      promo_discount_percent: number | null;
    }>();

  let pricePence = Number(service.price_pence);
  let promoDiscount = 0;
  let promoUsed: string | undefined;
  if (body.promoCode?.trim() && settings?.promo_discount_code?.trim()) {
    if (body.promoCode.trim().toLowerCase() === settings.promo_discount_code.trim().toLowerCase()) {
      promoDiscount = Number(settings.promo_discount_percent ?? 0);
      pricePence = Math.round(pricePence * (1 - Math.min(100, Math.max(0, promoDiscount)) / 100));
      promoUsed = body.promoCode.trim();
    }
  }

  // Deposit: half the price, min £5.
  const depositPence = Math.max(500, Math.round(pricePence * 0.5));

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id, commission_rate FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null; commission_rate: number }>();
  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (!connectId) {
    return c.json({ success: false, error: "Stripe Connect not configured for shop" }, 400);
  }
  // Single rounding path (WS-4): the shop's configured rate, not a literal.
  const commissionPence = calculateCommissionPence(pricePence, Number(shopRow?.commission_rate ?? 0.1)).commission_pence;
  const applicationFeePence = commissionPence;

  // Atomic slot claim BEFORE the PaymentIntent (WS-2, ABUSE-1): of two
  // concurrent requests for the same slot exactly one sees changes === 1;
  // the loser never reaches Stripe. Released on every failure path below.
  //
  // Audit (Plan 3, pattern T): from the slot claim to the response runs inside
  // `run`. The body below is the original, not re-indented. The booking id is
  // generated up front so the entry names the row this request creates.
  const bookingId = crypto.randomUUID();
  try {
    return await auditFor(c).run(
      { action: "booking.create", shopId, entityType: "booking", entityId: bookingId },
      async (): Promise<Response> => {
  const claim = await db
    .prepare(
      `UPDATE bw_availability SET is_booked = 1
       WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ? AND is_booked = 0`
    )
    .bind(shopId, body.staffId, body.slotDate, body.slotTime)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return c.json({ success: false, error: "Slot not available" }, 400);
  }
  const releaseClaim = () =>
    db
      .prepare(
        `UPDATE bw_availability SET is_booked = 0, booking_id = NULL
         WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ? AND booking_id IS NULL`
      )
      .bind(shopId, body.staffId, body.slotDate, body.slotTime)
      .run();

  let clientSecret = "";
  let paymentIntentId = "";
  try {
    // Deterministic Idempotency-Key: a double-submit for the same slot gets
    // the same PaymentIntent back instead of a second authorisation.
    const pi = await createPaymentIntentManualCapture({
      secret: c.env.STRIPE_SECRET_KEY,
      amountPence: depositPence,
      currency: "gbp",
      destinationAccount: connectId,
      applicationFeePence,
      metadata: {
        shopId,
        bookingId,
        staffId: body.staffId,
        serviceId: body.serviceId,
        slotDate: body.slotDate,
        slotTime: body.slotTime,
      },
      idempotencyKey: `deposit:${shopId}:${body.staffId}:${body.slotDate}:${body.slotTime}`,
    });
    clientSecret = pi.client_secret;
    paymentIntentId = pi.id;
  } catch (e) {
    reportError("booking.deposit_pi_create", e, { shopId, staffId: body.staffId, slotDate: body.slotDate, slotTime: body.slotTime });
    await releaseClaim();
    return c.json({ success: false, error: e instanceof Error ? e.message : "Stripe error" }, 502);
  }

  const endTime = addMinutesToHm(body.slotTime, service.duration_min);

  const qrCodeData = JSON.stringify({
    bookingId,
    shopId,
    staffId: body.staffId,
    slotDate: body.slotDate,
    slotTime: body.slotTime,
  });

  // bookings keeps only canonical columns; deposit/PI/promo/QR state is
  // written to bw_booking_state below.
  try {
    await db
      .prepare(
        `INSERT INTO bookings (
           id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone,
           booking_date, start_time, end_time, status, notes, amount_pence, commission_pence
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?)`
      )
      .bind(
        bookingId,
        shopId,
        body.staffId,
        body.serviceId,
        body.customerName,
        body.customerEmail,
        body.customerPhone ?? "",
        body.slotDate,
        body.slotTime,
        endTime,
        pricePence,
        commissionPence
      )
      .run();
  } catch (err) {
    // idx_bookings_active_slot (migration 018): a booking from another path
    // (e.g. the public dynamic-slots flow) won this staff/time first. Unwind:
    // release the availability claim and void the uncaptured hold.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      await releaseClaim();
      try {
        await cancelPaymentIntent(c.env.STRIPE_SECRET_KEY, paymentIntentId, `cancel:${paymentIntentId}`);
      } catch (cancelErr) {
        // The hold auto-expires in ~7 days; report so it is not invisible.
        reportError("booking.deposit_pi_cancel", cancelErr, { shopId, paymentIntentId });
      }
      return c.json({ success: false, error: "This time slot is no longer available" }, 409);
    }
    throw err;
  }

  // No pre-checkout line items any more (WS-3): the checkout derives the base
  // service from bookings.amount_pence and creates the sale itself.

  // The slot was already claimed atomically above; attach the booking to it.
  await db
    .prepare(
      `UPDATE bw_availability SET booking_id = ?
       WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND slot_time = ? AND is_booked = 1 AND booking_id IS NULL`
    )
    .bind(bookingId, shopId, body.staffId, body.slotDate, body.slotTime)
    .run();

  await db
    .prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, stripe_payment_intent_id, promo_code, promo_discount_percent, qr_code_data, slot_time, updated_at)
       VALUES (?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      bookingId,
      shopId,
      depositPence,
      paymentIntentId,
      promoUsed ?? null,
      promoUsed ? promoDiscount : null,
      qrCodeData,
      body.slotTime,
      new Date().toISOString()
    )
    .run();

  const txId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id) VALUES (?, ?, ?, 'deposit', ?, 'pending', ?)`
    )
    .bind(txId, bookingId, shopId, depositPence, paymentIntentId)
    .run();

  return c.json({
    success: true,
    bookingId,
    clientSecret,
    depositAmountPence: depositPence,
    qrCodeData,
  });
      },
      statusOutcome((res) =>
        res.status < 400
          ? {
              changes: { status: [null, "confirmed"] },
              details: { channel: "staff", deposit_required: true },
            }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

r.post("/:shopId/walk-ins", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const date = todayUtcYmd();
  const open = await db
    .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? AND status = 'open' LIMIT 1")
    .bind(shopId, date)
    .first<{ id: string }>();
  if (!open) {
    return c.json({ success: false, error: "Shop is not open today" }, 400);
  }

  let body: { serviceId: string; staffId: string; customerName: string; customerPhone?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const slot = await db
    .prepare(
      `SELECT id, slot_time FROM bw_availability WHERE shop_id = ? AND staff_id = ? AND slot_date = ? AND is_booked = 0 ORDER BY slot_time ASC LIMIT 1`
    )
    .bind(shopId, body.staffId, date)
    .first<{ id: string; slot_time: string }>();
  if (!slot?.id) {
    return c.json({ success: false, error: "No availability for this staff today" }, 400);
  }

  const service = await db
    .prepare("SELECT price_pence, duration_min, name FROM services WHERE id = ? AND shop_id = ?")
    .bind(body.serviceId, shopId)
    .first<{ price_pence: number; duration_min: number; name: string }>();
  if (!service) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  const bookingId = crypto.randomUUID();

  // Atomic claim of the selected slot (WS-2): a concurrent walk-in that
  // selected the same earliest slot loses this UPDATE and gets a 409 to retry.
  //
  // Audit (Plan 3, pattern T): from the slot claim to the response runs inside
  // `run`. The body below is the original, not re-indented.
  try {
    return await auditFor(c).run(
      { action: "booking.create", shopId, entityType: "booking", entityId: bookingId },
      async (): Promise<Response> => {
  const claim = await db
    .prepare("UPDATE bw_availability SET is_booked = 1, booking_id = ? WHERE id = ? AND is_booked = 0")
    .bind(bookingId, slot.id)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return c.json({ success: false, error: "This time slot is no longer available" }, 409);
  }

  const endTime = addMinutesToHm(slot.slot_time, service.duration_min);
  const pricePence = Number(service.price_pence);
  const rateRow = await db
    .prepare("SELECT commission_rate FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ commission_rate: number }>();
  // Single rounding path (WS-4): the shop's configured rate, not a literal.
  const commissionPence = calculateCommissionPence(pricePence, Number(rateRow?.commission_rate ?? 0.1)).commission_pence;
  const email = `walkin+${bookingId.slice(0, 8)}@pivotparlor.invalid`;

  const qrCodeData = JSON.stringify({
    bookingId,
    shopId,
    staffId: body.staffId,
    slotDate: date,
    slotTime: slot.slot_time,
  });

  // bookings keeps only canonical columns; walk-in state is written to
  // bw_booking_state below.
  try {
    await db
      .prepare(
        `INSERT INTO bookings (
           id, shop_id, staff_id, service_id, customer_name, customer_email, customer_phone,
           booking_date, start_time, end_time, status, notes, amount_pence, commission_pence
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?)`
      )
      .bind(
        bookingId,
        shopId,
        body.staffId,
        body.serviceId,
        body.customerName,
        email,
        body.customerPhone ?? "",
        date,
        slot.slot_time,
        endTime,
        pricePence,
        commissionPence
      )
      .run();
  } catch (err) {
    // idx_bookings_active_slot (migration 018): another walk-in or online
    // booking won this staff/time slot first. Release the claim taken above.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      await db
        .prepare("UPDATE bw_availability SET is_booked = 0, booking_id = NULL WHERE id = ? AND booking_id = ?")
        .bind(slot.id, bookingId)
        .run();
      return c.json({ success: false, error: "This time slot is no longer available" }, 409);
    }
    throw err;
  }

  // No pre-checkout line items any more (WS-3): the checkout derives the base
  // service from bookings.amount_pence and creates the sale itself.

  await db
    .prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence, qr_code_data, slot_time, updated_at)
       VALUES (?, ?, 'walk_in', 0, ?, ?, ?)`
    )
    .bind(bookingId, shopId, qrCodeData, slot.slot_time, new Date().toISOString())
    .run();

  return c.json({
    success: true,
    bookingId,
    qrCodeData,
    estimatedWaitMinutes: 15,
    assignedSlotTime: slot.slot_time,
  });
      },
      statusOutcome((res) =>
        res.status < 400
          ? { changes: { status: [null, "confirmed"] }, details: { channel: "walk_in" } }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

r.post("/:shopId/check-in", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: { qrCodeData: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  let parsed: { bookingId: string; shopId: string; staffId: string; slotDate: string; slotTime: string };
  try {
    parsed = JSON.parse(body.qrCodeData) as typeof parsed;
  } catch {
    return c.json({ success: false, error: "Invalid QR payload" }, 400);
  }
  if (parsed.shopId !== shopId) {
    return c.json({ success: false, error: "QR does not match shop" }, 400);
  }

  const booking = await db
    .prepare("SELECT * FROM bookings WHERE id = ? AND shop_id = ?")
    .bind(parsed.bookingId, shopId)
    .first<Record<string, unknown>>();
  if (!booking) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }
  if (booking.status !== "confirmed") {
    return c.json({ success: false, error: "Invalid booking status for check-in" }, 400);
  }

  const preCheck = await db
    .prepare("SELECT checked_in_at FROM bw_booking_state WHERE booking_id = ?")
    .bind(parsed.bookingId)
    .first<{ checked_in_at: string | null }>();
  if (preCheck?.checked_in_at) {
    return c.json({ success: false, error: "Already checked in" }, 400);
  }

  // checked_in_at lives in bw_booking_state only. Upsert so bookings created
  // before a state row existed still record their check-in.
  // Audit (Plan 3, pattern B): the upsert and its entry commit together.
  const refused = await batchWithAudit(
    c,
    [
      db
        .prepare(
          `INSERT INTO bw_booking_state (booking_id, shop_id, checked_in_at, updated_at)
           VALUES (?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(booking_id) DO UPDATE SET checked_in_at = datetime('now'), updated_at = datetime('now')`
        )
        .bind(parsed.bookingId, shopId),
    ],
    {
      action: "booking.check_in",
      shopId,
      entityType: "booking",
      entityId: parsed.bookingId,
      outcome: "succeeded",
      details: { already_checked_in: Boolean(preCheck?.checked_in_at) },
    }
  );
  if (refused) return refused;

  const rowIn = await db
    .prepare("SELECT checked_in_at FROM bw_booking_state WHERE booking_id = ? AND shop_id = ?")
    .bind(parsed.bookingId, shopId)
    .first<{ checked_in_at: string | null }>();
  const checkedInAt = rowIn?.checked_in_at ?? new Date().toISOString();

  const svc = await db
    .prepare("SELECT name FROM services WHERE id = ?")
    .bind(booking.service_id)
    .first<{ name: string }>();
  const stf = await db
    .prepare("SELECT display_name FROM staff WHERE id = ?")
    .bind(booking.staff_id)
    .first<{ display_name: string }>();

  return c.json({
    success: true,
    bookingId: parsed.bookingId,
    customerName: booking.customer_name,
    serviceName: svc?.name ?? "",
    staffName: stf?.display_name ?? "",
    checkedInAt,
  });
});

// ─── POST /:shopId/bookings/:bookingId/cancel — cancel with deposit disposition ─
//
// The only cancellation path that is deposit-aware. Policy ("we only earn when
// you earn"): staff choose whether a CHARGED deposit is refunded (full refund,
// application fee reversed too — createRefund already sets
// refund_application_fee + reverse_transfer) or kept (shop earned the deposit,
// the commission already collected on it stands). An uncaptured HOLD is always
// voided — there is nothing to keep. Already-cancelled bookings are accepted
// so deposits stranded by the deposit-blind customer self-cancel path remain
// refundable afterwards.

r.post("/:shopId/bookings/:bookingId/cancel", async (c) => {
  const shopId = c.req.param("shopId");
  const bookingId = c.req.param("bookingId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: { refundDeposit?: boolean };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  // Fresh cancels default to refund; the RECOVERY path (already-cancelled
  // booking) acts only on an EXPLICIT true, so a bare re-cancel can never
  // silently refund a deposit staff deliberately chose to keep.
  const refundExplicit = body.refundDeposit === true;
  const refundDeposit = body.refundDeposit !== false;

  const booking = await db
    .prepare("SELECT * FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(bookingId, shopId)
    .first<Record<string, unknown>>();
  if (!booking) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }
  if (booking.status === "completed" || booking.status === "no_show") {
    return c.json({ success: false, error: "Closed bookings cannot be cancelled" }, 400);
  }

  const st = await db
    .prepare("SELECT * FROM bw_booking_state WHERE booking_id = ? AND shop_id = ? LIMIT 1")
    .bind(bookingId, shopId)
    .first<Record<string, unknown>>();
  const depositTx = await db
    .prepare(
      "SELECT id, status, sale_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit' LIMIT 1"
    )
    .bind(bookingId)
    .first<{ id: string; status: string; sale_id: string | null }>();
  const refundTx = await db
    .prepare(
      "SELECT id FROM bw_transactions WHERE booking_id = ? AND type = 'refund' LIMIT 1"
    )
    .bind(bookingId)
    .first<{ id: string }>();

  const piId =
    typeof st?.stripe_payment_intent_id === "string"
      ? st.stripe_payment_intent_id.trim() || null
      : null;
  const depositPaid = typeof st?.deposit_paid_at === "string" && st.deposit_paid_at.length > 0;
  const depositPence = Number(st?.deposit_amount_pence ?? 0);
  const depositFeePence = Number(st?.deposit_application_fee_pence ?? 0);

  const alreadyRefunded = Boolean(refundTx) || depositTx?.status === "refunded";
  const chargedDeposit =
    depositPaid &&
    piId !== null &&
    depositTx?.status === "captured" &&
    !depositTx.sale_id &&
    !alreadyRefunded &&
    depositPence > 0;
  const holdDeposit = !depositPaid && piId !== null && depositTx?.status === "pending";

  // Atomic claim (idiom of the checkout claim above): flip open → cancelled
  // exactly once; concurrent duplicate cancels lose the UPDATE. An already-
  // cancelled booking skips the flip — that is the recovery path for deposits
  // stranded by the customer self-cancel, and it acts only on an explicit
  // refund request (or a stranded hold, which can only be voided).
  //
  // Audit (Plan 3, pattern T, decision 10): from the flip to the response runs
  // inside `run`, so the early 4xx answers record refused. The body below is
  // the original, not re-indented. `changes` is set only when a flip happened.
  const priorStatus = String(booking.status);
  let flipped = false;
  let auditBeforeStatus = priorStatus;
  let auditDeposit: "refunded" | "voided" | "kept" | "none" = "none";
  try {
    return await auditFor(c).run(
      { action: "booking.cancel", shopId, entityType: "booking", entityId: bookingId },
      async (): Promise<Response> => {
  if (priorStatus !== "cancelled") {
    // The before-status for the audit entry is read in the SAME batch (one D1
    // transaction) as the flip, so it is the status the UPDATE actually found,
    // not the earlier pre-read (a settle webhook may have confirmed it since).
    const [beforeRead, claim] = await db.batch([
      db.prepare("SELECT status FROM bookings WHERE id = ? AND shop_id = ?").bind(bookingId, shopId),
      db
        .prepare(
          "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND shop_id = ? AND status IN ('pending', 'confirmed')"
        )
        .bind(bookingId, shopId),
    ]);
    if ((claim?.meta?.changes ?? 0) !== 1) {
      return c.json({ success: false, error: "Booking was modified by another request" }, 409);
    }
    const found = (beforeRead?.results?.[0] as { status?: string } | undefined)?.status;
    if (typeof found === "string") auditBeforeStatus = found;
    flipped = true;
  } else if (!refundExplicit || !(chargedDeposit || holdDeposit)) {
    const reason = alreadyRefunded ? "Deposit already refunded" : "Booking is already cancelled";
    return c.json({ success: false, error: reason }, 400);
  }
  // On a refund failure the correct open status is 'confirmed': a captured
  // deposit means the settle webhook ran, even if the pre-claim read caught
  // the booking mid-flip as 'pending'.
  const revertClaim = () =>
    flipped
      ? db
          .prepare(
            "UPDATE bookings SET status = 'confirmed' WHERE id = ? AND shop_id = ? AND status = 'cancelled'"
          )
          .bind(bookingId, shopId)
          .run()
      : Promise.resolve(null);

  let depositAction: "refunded" | "kept" | "hold_voided" | "none" = "none";
  let refundPence = 0;

  if (chargedDeposit && refundDeposit) {
    // Atomic deposit claim BEFORE Stripe: zeroing deposit_amount_pence (a)
    // serializes concurrent refund attempts (the loser sees changes 0 and
    // never reaches Stripe), and (b) kills the checkout deposit-credit
    // first, so even a refund-succeeded-but-recording-failed crash can never
    // credit money the customer got back — the failure direction is always
    // "shop must settle manually", never "customer paid twice is credited".
    const nowIso = new Date().toISOString();
    const depClaim = await db
      .prepare(
        `UPDATE bw_booking_state SET deposit_amount_pence = 0, deposit_application_fee_pence = 0,
           updated_at = ? WHERE booking_id = ? AND shop_id = ? AND deposit_amount_pence > 0`
      )
      .bind(nowIso, bookingId, shopId)
      .run();
    if ((depClaim.meta?.changes ?? 0) === 1) {
      let refundId = "";
      try {
        const refund = await createRefund({
          secret: c.env.STRIPE_SECRET_KEY,
          paymentIntentId: piId!,
          amountPence: depositPence,
          metadata: { shopId, bookingId, type: "deposit_refund" },
          idempotencyKey: `deposit-refund:${bookingId}`,
        });
        refundId = refund.id;
      } catch (err) {
        reportError("booking.deposit_cancel_refund", err, { shopId, bookingId });
        // Restore the claimed deposit and the open status; the deterministic
        // Idempotency-Key makes a retry safe even if Stripe actually
        // committed the refund before the failure.
        await db
          .prepare(
            `UPDATE bw_booking_state SET deposit_amount_pence = ?, deposit_application_fee_pence = ?,
               updated_at = ? WHERE booking_id = ? AND shop_id = ? AND deposit_amount_pence = 0`
          )
          .bind(depositPence, depositFeePence, nowIso, bookingId, shopId)
          .run();
        await revertClaim();
        return c.json(
          { success: false, error: "Deposit refund failed. The booking was not cancelled. Try again." },
          502
        );
      }
      // Record the refund. The tx carries the REFUND id — charge.refunded
      // flips the original deposit tx (keyed by PI id) and completes this
      // one; if that webhook already landed, insert as completed directly.
      const depNow = await db
        .prepare("SELECT status FROM bw_transactions WHERE booking_id = ? AND type = 'deposit' LIMIT 1")
        .bind(bookingId)
        .first<{ status: string }>();
      await db
        .prepare(
          `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
           VALUES (?, ?, ?, 'refund', ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          bookingId,
          shopId,
          depositPence,
          depNow?.status === "refunded" ? "completed" : "pending",
          refundId
        )
        .run();
      depositAction = "refunded";
      refundPence = depositPence;
    }
    // depClaim changes 0: a concurrent refund won the claim — the booking
    // stays cancelled and the deposit is already being handled; report none.
  } else if (chargedDeposit && !refundDeposit) {
    depositAction = "kept";
  } else if (holdDeposit) {
    // A hold can only be voided; refundDeposit is meaningless here. Non-fatal
    // on Stripe error — the uncaptured hold auto-expires in ~7 days.
    try {
      await cancelPaymentIntent(c.env.STRIPE_SECRET_KEY, piId!, `cancel:${piId}`);
    } catch (err) {
      reportError("booking.deposit_cancel_void", err, { shopId, bookingId, piId });
    }
    await db
      .prepare(
        "UPDATE bw_transactions SET status = 'cancelled' WHERE booking_id = ? AND type = 'deposit' AND status = 'pending'"
      )
      .bind(bookingId)
      .run();
    depositAction = "hold_voided";
  }

  // Every disposition the handler can take, mapped onto the audit enum.
  // A Record keyed on the disposition type: a new value is a compile error.
  const DEPOSIT_AUDIT: Record<typeof depositAction, "refunded" | "voided" | "kept" | "none"> = {
    refunded: "refunded",
    kept: "kept",
    hold_voided: "voided",
    none: "none",
  };
  auditDeposit = DEPOSIT_AUDIT[depositAction];

  return c.json({
    success: true,
    data: {
      status: "cancelled",
      flipped,
      deposit_action: depositAction,
      refund_pence: refundPence,
    },
  });
      },
      statusOutcome((res) =>
        res.status < 400
          ? {
              ...(flipped ? { changes: { status: [auditBeforeStatus, "cancelled"] as [unknown, unknown] } } : {}),
              details: { deposit: auditDeposit },
            }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default r;
