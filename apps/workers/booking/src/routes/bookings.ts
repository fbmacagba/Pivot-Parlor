import { Hono } from "hono";
import type { Env } from "../types.js";
import { shopExists } from "../middleware/shop-access.js";
import { addMinutesToHm, todayUtcYmd } from "../lib/time.js";
import { createPaymentIntentAutoCapture, createPaymentIntentManualCapture, capturePaymentIntent } from "../lib/stripe.js";

const r = new Hono<{ Bindings: Env }>();

function gbpToPence(gbp: number): number {
  return Math.round(gbp * 100);
}

r.post("/:shopId/bookings/:bookingId/checkout", async (c) => {
  const shopId = c.req.param("shopId");
  const bookingId = c.req.param("bookingId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  let body: {
    extraServices?: { serviceId: string; quantity: number }[];
    products?: { name: string; price: number; quantity: number }[];
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

  const settings = await db
    .prepare("SELECT commission_bearer, product_commission_enabled FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ commission_bearer: string; product_commission_enabled: number }>();
  const commissionBearer = settings?.commission_bearer ?? "shop";
  const productCommission = Number(settings?.product_commission_enabled ?? 0) === 1;

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null }>();
  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (!connectId) {
    return c.json({ success: false, error: "Stripe Connect not configured" }, 400);
  }

  const svcSum = await db
    .prepare(
      "SELECT COALESCE(SUM(total_price), 0) AS s FROM bw_booking_items WHERE booking_id = ? AND item_type = 'service'"
    )
    .bind(bookingId)
    .first<{ s: number }>();
  let servicesTotal = Number(svcSum?.s ?? 0);

  const extras = body.extraServices ?? [];
  for (const ex of extras) {
    const svc = await db
      .prepare("SELECT price, name FROM services WHERE id = ? AND shop_id = ?")
      .bind(ex.serviceId, shopId)
      .first<{ price: number; name: string }>();
    if (svc) {
      const q = Math.max(1, ex.quantity ?? 1);
      const line = Number(svc.price) * q;
      servicesTotal += line;
      const itemId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price, total_price, is_commissionable)
           VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, 1)`
        )
        .bind(itemId, bookingId, shopId, ex.serviceId, svc.name, q, svc.price, line)
        .run();
    }
  }

  let productsTotal = 0;
  for (const p of body.products ?? []) {
    const q = Math.max(1, p.quantity ?? 1);
    const line = Number(p.price) * q;
    productsTotal += line;
    const itemId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price, total_price, is_commissionable)
         VALUES (?, ?, ?, 'product', NULL, ?, ?, ?, ?, ?)`
      )
      .bind(itemId, bookingId, shopId, p.name, q, p.price, line, productCommission ? 1 : 0)
      .run();
  }

  const tipPct = [0, 5, 10, 15, 20].includes(Number(body.tipPercent)) ? Number(body.tipPercent) : 0;
  const subForTip = servicesTotal + productsTotal;
  const tipAmount = subForTip * (tipPct / 100);
  if (tipPct > 0 && tipAmount > 0) {
    const itemId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price, total_price, is_commissionable)
         VALUES (?, ?, ?, 'tip', NULL, 'Tip', 1, ?, ?, 0)`
      )
      .bind(itemId, bookingId, shopId, tipAmount, tipAmount)
      .run();
  }

  let commissionBase = servicesTotal;
  if (productCommission) commissionBase += productsTotal;
  const commissionAmount = commissionBase * 0.1;
  const grandTotal = servicesTotal + productsTotal + tipAmount;
  const customerTotal =
    commissionBearer === "customer" ? grandTotal + commissionAmount : grandTotal;

  const piId = typeof st.stripe_payment_intent_id === "string" ? st.stripe_payment_intent_id.trim() || null : null;
  const depositGbp = piId ? Number(st.deposit_amount ?? 0) : 0;
  const customerTotalPence = gbpToPence(customerTotal);
  const depositPence = gbpToPence(depositGbp);
  const commissionPence = gbpToPence(commissionAmount);

  const captureFromHoldPence = piId ? Math.min(depositPence, customerTotalPence) : 0;
  const remainderPence = Math.max(0, customerTotalPence - captureFromHoldPence);
  const balanceApplicationFeePence = Math.min(commissionPence, remainderPence);

  let stripeChargeId = "";
  let balanceClientSecret: string | null = null;

  try {
    if (piId && captureFromHoldPence > 0) {
      const cap =
        captureFromHoldPence < depositPence
          ? await capturePaymentIntent(c.env.STRIPE_SECRET_KEY, piId, { amountPence: captureFromHoldPence })
          : await capturePaymentIntent(c.env.STRIPE_SECRET_KEY, piId);
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
      });
      balanceClientSecret = bal.client_secret || null;
      await db
        .prepare("UPDATE bw_booking_state SET stripe_balance_pi = ?, updated_at = ? WHERE booking_id = ?")
        .bind(bal.id, new Date().toISOString(), bookingId)
        .run();
      if (!stripeChargeId) {
        stripeChargeId = String((bal as { latest_charge?: string }).latest_charge ?? bal.id ?? "");
      }
    }

    const captureGbp = captureFromHoldPence / 100;
    if (captureGbp > 0) {
      const tx1 = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount, status, stripe_id) VALUES (?, ?, ?, 'deposit_capture', ?, 'captured', ?)`
        )
        .bind(tx1, bookingId, shopId, captureGbp, piId ?? "")
        .run();
    }

    const ledgerId = crypto.randomUUID();
    const bd = await db
      .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? LIMIT 1")
      .bind(shopId, todayUtcYmd())
      .first<{ id: string }>();
    await db
      .prepare(
        `INSERT INTO bw_commission_ledger (id, shop_id, business_day_id, booking_id, services_amount, commission_rate, commission_amount, commission_bearer, status)
         VALUES (?, ?, ?, ?, ?, 0.10, ?, ?, 'transferred')`
      )
      .bind(
        ledgerId,
        shopId,
        bd?.id ?? null,
        bookingId,
        servicesTotal,
        commissionAmount,
        commissionBearer
      )
      .run();

    // bookings keeps only canonical columns; total_amount lives in
    // bw_booking_state (updated below) and completion time is captured by
    // status = 'completed' plus bw_booking_state.updated_at.
    await db
      .prepare(
        `UPDATE bookings SET status = 'completed', amount = ?, commission = ? WHERE id = ? AND shop_id = ?`
      )
      .bind(customerTotal, commissionAmount, bookingId, shopId)
      .run();

    await db
      .prepare("UPDATE bw_booking_state SET total_amount = ?, updated_at = ? WHERE booking_id = ?")
      .bind(customerTotal, new Date().toISOString(), bookingId)
      .run();

    return c.json({
      success: true,
      receipt: {
        services: servicesTotal,
        products: productsTotal,
        tip: tipAmount,
        subtotal: grandTotal,
        commission: commissionBearer === "customer" ? commissionAmount : 0,
        total: customerTotal,
      },
      stripeChargeId,
      balanceClientSecret,
    });
  } catch (e) {
    console.error("[booking] checkout stripe error", e);
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
    .prepare("SELECT price, duration_min FROM services WHERE id = ? AND shop_id = ? AND is_active = 1")
    .bind(body.serviceId, shopId)
    .first<{ price: number; duration_min: number }>();
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

  let priceGbp = Number(service.price);
  let promoDiscount = 0;
  let promoUsed: string | undefined;
  if (body.promoCode?.trim() && settings?.promo_discount_code?.trim()) {
    if (body.promoCode.trim().toLowerCase() === settings.promo_discount_code.trim().toLowerCase()) {
      promoDiscount = Number(settings.promo_discount_percent ?? 0);
      priceGbp = priceGbp * (1 - Math.min(100, Math.max(0, promoDiscount)) / 100);
      promoUsed = body.promoCode.trim();
    }
  }

  const depositGbp = Math.max(5, priceGbp * 0.5);
  const depositPence = gbpToPence(depositGbp);
  const applicationFeePence = gbpToPence(priceGbp * 0.1);

  const shopRow = await db
    .prepare("SELECT stripe_connect_account_id FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ stripe_connect_account_id: string | null }>();
  const connectId = shopRow?.stripe_connect_account_id?.trim();
  if (!connectId) {
    return c.json({ success: false, error: "Stripe Connect not configured for shop" }, 400);
  }

  let clientSecret = "";
  let paymentIntentId = "";
  try {
    const pi = await createPaymentIntentManualCapture({
      secret: c.env.STRIPE_SECRET_KEY,
      amountPence: depositPence,
      currency: "gbp",
      destinationAccount: connectId,
      applicationFeePence,
      metadata: {
        shopId,
        staffId: body.staffId,
        serviceId: body.serviceId,
        slotDate: body.slotDate,
        slotTime: body.slotTime,
      },
    });
    clientSecret = pi.client_secret;
    paymentIntentId = pi.id;
  } catch (e) {
    console.error("[booking] PI create failed", e);
    return c.json({ success: false, error: e instanceof Error ? e.message : "Stripe error" }, 502);
  }

  const bookingId = crypto.randomUUID();
  const endTime = addMinutesToHm(body.slotTime, service.duration_min);
  const commission = priceGbp * 0.1;

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
           booking_date, start_time, end_time, status, notes, amount, commission
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
        priceGbp,
        commission
      )
      .run();
  } catch (err) {
    // idx_bookings_active_slot (migration 018): a concurrent request won the
    // slot between the availability check and this INSERT.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ success: false, error: "This time slot is no longer available" }, 409);
    }
    throw err;
  }

  const itemId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price, total_price, is_commissionable)
       SELECT ?, ?, ?, 'service', s.id, s.name, 1, s.price, ?, 1 FROM services s WHERE s.id = ?`
    )
    .bind(itemId, bookingId, shopId, priceGbp, body.serviceId)
    .run();

  await db
    .prepare("UPDATE bw_availability SET is_booked = 1, booking_id = ? WHERE id = ?")
    .bind(bookingId, av.id)
    .run();

  await db
    .prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount, stripe_payment_intent_id, promo_code, promo_discount_percent, qr_code_data, slot_time, updated_at)
       VALUES (?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      bookingId,
      shopId,
      depositGbp,
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
      `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount, status, stripe_id) VALUES (?, ?, ?, 'deposit', ?, 'pending', ?)`
    )
    .bind(txId, bookingId, shopId, depositGbp, paymentIntentId)
    .run();

  return c.json({
    success: true,
    bookingId,
    clientSecret,
    depositAmount: depositGbp,
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
    .prepare("SELECT price, duration_min, name FROM services WHERE id = ? AND shop_id = ?")
    .bind(body.serviceId, shopId)
    .first<{ price: number; duration_min: number; name: string }>();
  if (!service) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  const bookingId = crypto.randomUUID();
  const endTime = addMinutesToHm(slot.slot_time, service.duration_min);
  const priceGbp = Number(service.price);
  const commission = priceGbp * 0.1;
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
           booking_date, start_time, end_time, status, notes, amount, commission
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
        priceGbp,
        commission
      )
      .run();
  } catch (err) {
    // idx_bookings_active_slot (migration 018): another walk-in or online
    // booking won this staff/time slot first.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ success: false, error: "This time slot is no longer available" }, 409);
    }
    throw err;
  }

  const itemId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_booking_items (id, booking_id, shop_id, item_type, service_id, name, quantity, unit_price, total_price, is_commissionable)
       VALUES (?, ?, ?, 'service', ?, ?, 1, ?, ?, 1)`
    )
    .bind(itemId, bookingId, shopId, body.serviceId, service.name, priceGbp, priceGbp)
    .run();

  await db
    .prepare("UPDATE bw_availability SET is_booked = 1, booking_id = ? WHERE id = ?")
    .bind(bookingId, slot.id)
    .run();

  await db
    .prepare(
      `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount, qr_code_data, slot_time, updated_at)
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
