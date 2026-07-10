/**
 * Public (unauthenticated) booking surface — WS-1.
 *
 * The canonical customer booking path. The main worker proxies its public
 * URLs here over a service binding:
 *   GET  /public/shops/:shopId/slots   ← /api/shops/:shopId/slots
 *   POST /public/bookings              ← /api/bookings
 * WS-4 renamed the money response fields to amount_pence/commission_pence
 * (integer pence); the web booking UI was updated in the same change.
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import {
  getShopById, getShopBySlug, getServiceById, getStaffById,
  createBooking, checkSlotConflict,
} from "../db/queries.js";
import { getAvailableSlots } from "../services/slots.js";
import { sendBookingConfirmation } from "../services/email.js";
import { reportError } from "../services/report-error.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { addMinutes, calculateCommissionPence, reminderDelaySeconds } from "@repo/utils";

function toDateString(iso: string): string {
  return iso.slice(0, 10); // "YYYY-MM-DD"
}

const publicRoutes = new Hono<{ Bindings: Env }>();

// ─── GET /public/shops/:shopId/slots ──────────────────────────────────────────
// Query: date (YYYY-MM-DD), service_id, [staff_id]

publicRoutes.get("/shops/:shopId/slots", async (c) => {
  const shopId = c.req.param("shopId")!;
  const { date, service_id, staff_id } = c.req.query();

  if (!date || !service_id) {
    return c.json({ success: false, error: "date and service_id are required" }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ success: false, error: "date must be in YYYY-MM-DD format" }, 400);
  }

  const service = await getServiceById(c.env.DB, service_id);
  if (!service || service.shop_id !== shopId) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  const slotList = await getAvailableSlots(
    shopId,
    staff_id ?? null,
    date,
    service.duration_min,
    c.env.DB,
    c.env.KV
  );

  return c.json({ success: true, data: slotList });
});

// ─── POST /public/bookings — customer booking creation ───────────────────────

publicRoutes.post(
  "/bookings",
  rateLimit({ name: "public-booking", limit: 30, windowS: 3600, key: clientIp }),
  async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    shop_slug?: string;
    staff_id?: string;
    service_id?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    start_time?: string;   // ISO string
    date?: string;         // shop-local YYYY-MM-DD the slot was offered for
    notes?: string;
  }>();

  const { shop_id, shop_slug, staff_id, service_id, customer_name, customer_email, start_time } = body;
  if ((!shop_id && !shop_slug) || !staff_id || !service_id || !customer_name || !customer_email || !start_time) {
    return c.json(
      {
        success: false,
        error:
          "shop_id (or shop_slug), staff_id, service_id, customer_name, customer_email and start_time are required",
      },
      400
    );
  }

  // Validate shop — accept either id or slug (the booking UI sends the slug)
  const shop = shop_id
    ? await getShopById(c.env.DB, shop_id)
    : await getShopBySlug(c.env.DB, shop_slug!);
  if (!shop || !shop.is_active) return c.json({ success: false, error: "Shop not found" }, 404);

  // Validate service
  const service = await getServiceById(c.env.DB, service_id);
  if (!service || service.shop_id !== shop.id) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  // Parse + range-check the requested time
  const startDate = new Date(start_time);
  if (Number.isNaN(startDate.getTime())) {
    return c.json({ success: false, error: "start_time must be a valid ISO date-time" }, 400);
  }
  if (startDate.getTime() <= Date.now()) {
    return c.json({ success: false, error: "start_time must be in the future" }, 400);
  }
  const startISO = startDate.toISOString();

  // For a specific staff request, validate the staff up front so an invalid or
  // cross-shop staff_id returns a precise 404 (rather than a generic slot 409).
  if (staff_id !== "any") {
    const reqStaff = await getStaffById(c.env.DB, staff_id);
    if (!reqStaff || reqStaff.shop_id !== shop.id || reqStaff.is_active !== 1) {
      return c.json({ success: false, error: "Staff member not found" }, 404);
    }
  }

  // Validate the time is a real, available slot in the staff schedule. Reuses
  // the same computation the booking UI reads, so any offered slot is accepted
  // while arbitrary / off-schedule / misaligned times are rejected. For an
  // "any available" request, adopt the staff_id of the matching free slot.
  const slotDate =
    body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : toDateString(startISO);
  const requestedStaff = staff_id === "any" ? null : staff_id;
  const slotList = await getAvailableSlots(
    shop.id,
    requestedStaff,
    slotDate,
    service.duration_min,
    c.env.DB,
    c.env.KV
  );
  const matchingSlot = slotList.find((s) => s.start_time === startISO && s.is_available);
  if (!matchingSlot) {
    return c.json({ success: false, error: "Selected time is not available" }, 409);
  }
  const resolvedStaffId = matchingSlot.staff_id;

  // Defensive: confirm the resolved staff belongs to this shop and is active
  const bookedStaff = await getStaffById(c.env.DB, resolvedStaffId);
  if (!bookedStaff || bookedStaff.shop_id !== shop.id || bookedStaff.is_active !== 1) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }

  const endDate = addMinutes(startDate, service.duration_min);
  const bookingDate = toDateString(startISO);
  const endISO = endDate.toISOString();

  // Defense-in-depth against the read->write race (the unique active-slot index
  // from migration 018 is the real guard; see the createBooking catch below).
  const conflict = await checkSlotConflict(c.env.DB, resolvedStaffId, startISO, endISO);
  if (conflict) {
    return c.json({ success: false, error: "This time slot is no longer available" }, 409);
  }

  const { commission_pence } = calculateCommissionPence(service.price_pence, shop.commission_rate);
  const id = crypto.randomUUID();

  try {
    await createBooking(c.env.DB, {
      id,
      shop_id: shop.id,
      staff_id: resolvedStaffId,
      service_id,
      customer_name,
      customer_email,
      customer_phone: body.customer_phone ?? null,
      booking_date: bookingDate,
      start_time: startISO,
      end_time: endISO,
      notes: body.notes ?? null,
      amount_pence: service.price_pence,
      commission_pence,
    });
  } catch (err) {
    // idx_bookings_active_slot (migration 018): a concurrent request won the
    // slot between checkSlotConflict and this INSERT.
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ success: false, error: "This time slot is no longer available" }, 409);
    }
    throw err;
  }

  // Send booking confirmation email — fire-and-forget, never block booking creation
  try {
    const confirmPref = await c.env.DB
      .prepare("SELECT booking_confirmation_email FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(shop.id)
      .first<{ booking_confirmation_email: number | null }>();
    if (c.env.RESEND_API_KEY && confirmPref?.booking_confirmation_email !== 0) {
      await sendBookingConfirmation(c.env.RESEND_API_KEY, {
        customer_name,
        customer_email,
        service_name: service.name,
        staff_name: bookedStaff.display_name ?? "your specialist",
        shop_name: shop.name,
        shop_slug: shop.slug,
        booking_date: bookingDate,
        start_time: startISO,
        duration_min: service.duration_min,
        amount_pence: service.price_pence,
        booking_id: id,
      });
    }
  } catch (err) {
    // Non-fatal: the booking is already created; the customer just gets no email.
    reportError("booking.confirmation_email", err, { shopId: shop.id, bookingId: id });
  }

  // Enqueue reminder job — fire-and-forget, never block booking creation
  try {
    // Use shop's configured reminder_hours_before (default 24h)
    const settingsRow = await c.env.DB
      .prepare("SELECT booking_reminder_email, reminder_hours_before FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(shop.id)
      .first<{ booking_reminder_email: number | null; reminder_hours_before: number | null }>();
    const reminderEnabled = settingsRow?.booking_reminder_email !== 0;
    const hoursBeforeNum = settingsRow?.reminder_hours_before ?? 24;
    const hoursBefore = Number.isFinite(hoursBeforeNum) && hoursBeforeNum > 0 ? hoursBeforeNum : 24;
    if (reminderEnabled) {
      const sendAtDate = new Date(startDate.getTime() - hoursBefore * 60 * 60_000);
      // delaySeconds caps at 12h; the consumer re-delays the remainder in hops.
      await c.env.QUEUE?.send(
        { bookingId: id, sendAt: sendAtDate.toISOString() },
        { delaySeconds: reminderDelaySeconds(sendAtDate, new Date()) }
      );
    }
  } catch (err) {
    // Non-fatal, but the customer will get no reminder for this booking.
    reportError("booking.reminder_enqueue", err, { shopId: shop.id, bookingId: id });
  }

  return c.json({
    success: true,
    data: {
      id,
      shop_id: shop.id,
      staff_id: resolvedStaffId,
      service_id,
      customer_name,
      customer_email,
      booking_date: bookingDate,
      start_time: startISO,
      end_time: endISO,
      status: "pending",
      amount_pence: service.price_pence,
      commission_pence,
    },
  }, 201);
});

export default publicRoutes;
