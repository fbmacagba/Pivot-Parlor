import { Hono } from "hono";
import type { Env } from "../types.js";
import { shopExists } from "../middleware/shop-access.js";
import { addMinutesToHm, todayUtcYmd } from "../lib/time.js";
import { createPaymentIntentAutoCapture, createPaymentIntentManualCapture, capturePaymentIntent, cancelPaymentIntent } from "../lib/stripe.js";
import { reportError } from "../services/report-error.js";
import { calculateCommissionPence } from "@repo/utils";

const r = new Hono<{ Bindings: Env }>();

r.post("/:shopId/bookings/:bookingId/checkout", async (c) => {
  const shopId = c.req.param("shopId");
  const bookingId = c.req.param("bookingId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: {
    extraServices?: { serviceId: string; quantity: number }[];
    products?: { name: string; price_pence: number; quantity: number }[];
    tipPercent?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  for (const p of body.products ?? []) {
    if (!Number.isInteger(p.price_pence) || p.price_pence < 0) {
      return c.json({ success: false, error: "product price_pence must be a non-negative integer (pence)" }, 400);
    }
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
  const claim = await db
    .prepare("UPDATE bookings SET status = 'completed' WHERE id = ? AND shop_id = ? AND status = 'confirmed'")
    .bind(bookingId, shopId)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return c.json({ success: false, error: "Checkout already in progress or completed" }, 409);
  }

  const settings = await db
    .prepare("SELECT commission_bearer, product_commission_enabled FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ commission_bearer: string; product_commission_enabled: number }>();
  const commissionBearer = settings?.commission_bearer ?? "shop";
  const productCommission = Number(settings?.product_commission_enabled ?? 0) === 1;

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id, commission_rate FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null; commission_rate: number }>();
  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (!connectId) {
    return c.json({ success: false, error: "Stripe Connect not configured" }, 400);
  }
  const commissionRate = Number(shopRow?.commission_rate ?? 0.1);

  const svcSum = await db
    .prepare(
      "SELECT COALESCE(SUM(total_price_pence), 0) AS s FROM bw_booking_items WHERE booking_id = ? AND item_type = 'service'"
    )
    .bind(bookingId)
    .first<{ s: number }>();
  let servicesTotalPence = Number(svcSum?.s ?? 0);

  const extras = body.extraServices ?? [];
  for (const ex of extras) {
    const svc = await db
      .prepare("SELECT price_pence, name FROM services WHERE id = ? AND shop_id = ?")
      .bind(ex.serviceId, shopId)
      .first<{ price_pence: number; name: string }>();
    if (svc) {
      const q = Math.max(1, ex.quantity ?? 1);
      const linePence = svc.price_pence * q;
      servicesTotalPence += linePence;
      const itemId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, total_price_pence, is_commissionable)
           VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, 1)`
        )
        .bind(itemId, bookingId, shopId, ex.serviceId, svc.name, q, svc.price_pence, linePence)
        .run();
    }
  }

  let productsTotalPence = 0;
  for (const p of body.products ?? []) {
    const q = Math.max(1, p.quantity ?? 1);
    const linePence = p.price_pence * q;
    productsTotalPence += linePence;
    const itemId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, total_price_pence, is_commissionable)
         VALUES (?, ?, ?, 'product', NULL, ?, ?, ?, ?, ?)`
      )
      .bind(itemId, bookingId, shopId, p.name, q, p.price_pence, linePence, productCommission ? 1 : 0)
      .run();
  }

  const tipPct = [0, 5, 10, 15, 20].includes(Number(body.tipPercent)) ? Number(body.tipPercent) : 0;
  const subForTipPence = servicesTotalPence + productsTotalPence;
  const tipPence = Math.round((subForTipPence * tipPct) / 100);
  if (tipPct > 0 && tipPence > 0) {
    const itemId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, total_price_pence, is_commissionable)
         VALUES (?, ?, ?, 'tip', NULL, 'Tip', 1, ?, ?, 0)`
      )
      .bind(itemId, bookingId, shopId, tipPence, tipPence)
      .run();
  }

  let commissionBasePence = servicesTotalPence;
  if (productCommission) commissionBasePence += productsTotalPence;
  // Single rounding path (WS-4): the shop's configured rate, not a literal.
  const commissionPence = calculateCommissionPence(commissionBasePence, commissionRate).commission_pence;
  const grandTotalPence = servicesTotalPence + productsTotalPence + tipPence;
  const customerTotalPence =
    commissionBearer === "customer" ? grandTotalPence + commissionPence : grandTotalPence;

  const piId = typeof st.stripe_payment_intent_id === "string" ? st.stripe_payment_intent_id.trim() || null : null;
  const depositPence = piId ? Number(st.deposit_amount_pence ?? 0) : 0;

  const captureFromHoldPence = piId ? Math.min(depositPence, customerTotalPence) : 0;
  const remainderPence = Math.max(0, customerTotalPence - captureFromHoldPence);
  const balanceApplicationFeePence = Math.min(commissionPence, remainderPence);

  let stripeChargeId = "";
  let balanceClientSecret: string | null = null;

  try {
    if (piId && captureFromHoldPence > 0) {
      // Deposit capture is synchronous — a repeated Idempotency-Key returns
      // the original capture instead of a second charge.
      const cap = await capturePaymentIntent(c.env.STRIPE_SECRET_KEY, piId, {
        ...(captureFromHoldPence < depositPence ? { amountPence: captureFromHoldPence } : {}),
        idempotencyKey: `capture:${bookingId}`,
      });
      stripeChargeId = String((cap.latest_charge as string) ?? "");
    }

    if (remainderPence > 0) {
      const bal = await createPaymentIntentAutoCapture({
        secret: c.env.STRIPE_SECRET_KEY,
        amountPence: remainderPence,
        currency: "gbp",
        destinationAccount: connectId,
        applicationFeePence: balanceApplicationFeePence,
        metadata: { shopId, bookingId, type: "balance" },
        idempotencyKey: `balance:${bookingId}`,
      });
      balanceClientSecret = bal.client_secret || null;
      await db
        .prepare("UPDATE bw_booking_state SET stripe_balance_pi = ?, updated_at = ? WHERE booking_id = ?")
        .bind(bal.id, new Date().toISOString(), bookingId)
        .run();
      // The balance PI is unconfirmed here (the customer pays via
      // client_secret); record it pending — payment_intent.succeeded flips it.
      const txBal = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id) VALUES (?, ?, ?, 'balance', ?, 'pending', ?)`
        )
        .bind(txBal, bookingId, shopId, remainderPence, bal.id)
        .run();
      if (!stripeChargeId) {
        stripeChargeId = String(bal.latest_charge ?? bal.id ?? "");
      }
    }

    if (captureFromHoldPence > 0) {
      const tx1 = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id) VALUES (?, ?, ?, 'deposit_capture', ?, 'captured', ?)`
        )
        .bind(tx1, bookingId, shopId, captureFromHoldPence, piId ?? "")
        .run();
    }

    // Ledger honesty (WS-2): commission is 'transferred' only when all money
    // has actually settled. With an outstanding balance PI it stays 'pending'
    // until payment_intent.succeeded reconciles it (stripe-webhook.ts).
    const fullySettled = remainderPence === 0;
    const ledgerId = crypto.randomUUID();
    const bd = await db
      .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? LIMIT 1")
      .bind(shopId, todayUtcYmd())
      .first<{ id: string }>();
    await db
      .prepare(
        `INSERT INTO bw_commission_ledger (id, shop_id, business_day_id, booking_id, services_amount_pence, commission_rate, commission_amount_pence, commission_bearer, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ledgerId,
        shopId,
        bd?.id ?? null,
        bookingId,
        servicesTotalPence,
        commissionRate,
        commissionPence,
        commissionBearer,
        fullySettled ? "transferred" : "pending"
      )
      .run();

    // Status was already claimed above; persist the final money figures.
    // bookings keeps only canonical columns; total_amount_pence + completed_at live
    // in bw_booking_state (completed_at only once fully settled).
    await db
      .prepare(`UPDATE bookings SET amount_pence = ?, commission_pence = ? WHERE id = ? AND shop_id = ?`)
      .bind(customerTotalPence, commissionPence, bookingId, shopId)
      .run();

    await db
      .prepare(
        `UPDATE bw_booking_state SET total_amount_pence = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE booking_id = ?`
      )
      .bind(
        customerTotalPence,
        fullySettled ? new Date().toISOString() : null,
        new Date().toISOString(),
        bookingId
      )
      .run();

    return c.json({
      success: true,
      receipt: {
        services_pence: servicesTotalPence,
        products_pence: productsTotalPence,
        tip_pence: tipPence,
        subtotal_pence: grandTotalPence,
        commission_pence: commissionBearer === "customer" ? commissionPence : 0,
        total_pence: customerTotalPence,
      },
      stripeChargeId,
      balanceClientSecret,
    });
  } catch (e) {
    // Revert the checkout claim so the shop can retry once Stripe recovers;
    // the idempotency keys above make the retry safe.
    reportError("checkout.stripe", e, { shopId, bookingId });
    await db
      .prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND shop_id = ? AND status = 'completed'")
      .bind(bookingId, shopId)
      .run();
    return c.json({ success: false, error: e instanceof Error ? e.message : "Checkout failed" }, 500);
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

  const bookingId = crypto.randomUUID();

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

  const itemId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, total_price_pence, is_commissionable)
       SELECT ?, ?, ?, 'service', s.id, s.name, 1, s.price_pence, ?, 1 FROM services s WHERE s.id = ?`
    )
    .bind(itemId, bookingId, shopId, pricePence, body.serviceId)
    .run();

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

  const itemId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price_pence, total_price_pence, is_commissionable)
       VALUES (?, ?, ?, 'service', ?, ?, 1, ?, ?, 1)`
    )
    .bind(itemId, bookingId, shopId, body.serviceId, service.name, pricePence, pricePence)
    .run();

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
  await db
    .prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, checked_in_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(booking_id) DO UPDATE SET checked_in_at = datetime('now'), updated_at = datetime('now')`
    )
    .bind(parsed.bookingId, shopId)
    .run();

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

export default r;
