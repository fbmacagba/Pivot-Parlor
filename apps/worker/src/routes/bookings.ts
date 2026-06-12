import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getBookingsByShop, getBookingById, createBooking,
  updateBookingStatus, checkSlotConflict, getServiceById, getShopById, getStaffById,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { sendBookingConfirmation, sendReviewRequest } from "../services/email.js";
import { requireShop } from "../middleware/rbac.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function toDateString(iso: string): string {
  return iso.slice(0, 10); // "YYYY-MM-DD"
}

// ─── Router: /api/shops/:shopId/bookings (authenticated, requireShop) ─────────

const bookings = new Hono<{ Bindings: Bindings }>();
bookings.use("*", authMiddleware, requireShop());

bookings.get("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const { date, staffId, status } = c.req.query();
  const list = await getBookingsByShop(c.env.DB, shopId, { date, staffId, status });
  return c.json({ success: true, data: list });
});

bookings.get("/:bookingId", async (c) => {
  const shopId = c.req.param("shopId")!; const bookingId = c.req.param("bookingId")!;
  const booking = await getBookingById(c.env.DB, bookingId);
  if (!booking || booking.shop_id !== shopId) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }
  return c.json({ success: true, data: booking });
});

bookings.put("/:bookingId/status", async (c) => {
  const shopId = c.req.param("shopId")!; const bookingId = c.req.param("bookingId")!;
  const booking = await getBookingById(c.env.DB, bookingId);
  if (!booking || booking.shop_id !== shopId) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }

  const body = await c.req.json<{ status?: string }>();
  const valid = ["confirmed", "completed", "cancelled", "no_show"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }

  await updateBookingStatus(c.env.DB, bookingId, body.status);

  // Send review request when booking is marked completed
  if (body.status === "completed" && c.env.RESEND_API_KEY) {
    try {
      const reviewPref = await c.env.DB
        .prepare("SELECT review_request_email FROM shop_settings WHERE shop_id = ? LIMIT 1")
        .bind(shopId)
        .first<{ review_request_email: number | null }>();
      if (reviewPref?.review_request_email === 0) throw new Error("review_request disabled");
      const shop = await getShopById(c.env.DB, shopId);
      const service = await getServiceById(c.env.DB, booking.service_id);
      if (shop && service) {
        await sendReviewRequest(c.env.RESEND_API_KEY, {
          customer_name:  booking.customer_name,
          customer_email: booking.customer_email,
          service_name:   service.name,
          shop_name:      shop.name,
          shop_slug:      shop.slug,
          booking_id:     bookingId,
        });
      }
    } catch (err) {
      console.warn("[Review] Request email failed (non-fatal):", err);
    }
  }

  return c.json({ success: true });
});

// ─── Router: /api/bookings (public — customer booking) ───────────────────────

const publicBookings = new Hono<{ Bindings: Bindings }>();

publicBookings.post("/", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    staff_id?: string;
    service_id?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    start_time?: string;   // ISO string
    notes?: string;
  }>();

  const { shop_id, staff_id, service_id, customer_name, customer_email, start_time } = body;
  if (!shop_id || !staff_id || !service_id || !customer_name || !customer_email || !start_time) {
    return c.json(
      { success: false, error: "shop_id, staff_id, service_id, customer_name, customer_email and start_time are required" },
      400
    );
  }

  // Validate shop
  const shop = await getShopById(c.env.DB, shop_id);
  if (!shop || !shop.is_active) return c.json({ success: false, error: "Shop not found" }, 404);

  // Validate service
  const service = await getServiceById(c.env.DB, service_id);
  if (!service || service.shop_id !== shop_id) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  // Validate staff — body input, so shop ownership is not covered by URL scoping
  const bookedStaff = await getStaffById(c.env.DB, staff_id);
  if (!bookedStaff || bookedStaff.shop_id !== shop_id || bookedStaff.is_active !== 1) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }

  const startDate = new Date(start_time);
  if (Number.isNaN(startDate.getTime())) {
    return c.json({ success: false, error: "start_time must be a valid ISO date-time" }, 400);
  }
  const endDate = addMinutes(startDate, service.duration_min);
  const bookingDate = toDateString(startDate.toISOString());
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  // Check slot availability
  const conflict = await checkSlotConflict(c.env.DB, staff_id, bookingDate, startISO, endISO);
  if (conflict) {
    return c.json({ success: false, error: "This time slot is no longer available" }, 409);
  }

  const commission = Math.round(service.price * shop.commission_rate * 100) / 100;
  const id = crypto.randomUUID();

  try {
    await createBooking(c.env.DB, {
      id,
      shop_id,
      staff_id,
      service_id,
      customer_name,
      customer_email,
      customer_phone: body.customer_phone ?? null,
      booking_date: bookingDate,
      start_time: startISO,
      end_time: endISO,
      notes: body.notes ?? null,
      amount: service.price,
      commission,
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
      .bind(shop_id)
      .first<{ booking_confirmation_email: number | null }>();
    if (c.env.RESEND_API_KEY && confirmPref?.booking_confirmation_email !== 0) {
      const staffMember = await getStaffById(c.env.DB, staff_id);
      await sendBookingConfirmation(c.env.RESEND_API_KEY, {
        customer_name,
        customer_email,
        service_name: service.name,
        staff_name: staffMember?.display_name ?? "your specialist",
        shop_name: shop.name,
        shop_slug: shop.slug,
        booking_date: bookingDate,
        start_time: startISO,
        duration_min: service.duration_min,
        amount: service.price,
        booking_id: id,
      });
    }
  } catch (err) {
    console.warn("[Email] Confirmation send failed (non-fatal):", err);
  }

  // Enqueue reminder job — fire-and-forget, never block booking creation
  try {
    // Use shop's configured reminder_hours_before (default 24h)
    const settingsRow = await c.env.DB
      .prepare("SELECT booking_reminder_email, reminder_hours_before FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(shop_id)
      .first<{ booking_reminder_email: number | null; reminder_hours_before: number | null }>();
    const reminderEnabled = settingsRow?.booking_reminder_email !== 0;
    const hoursBeforeNum = settingsRow?.reminder_hours_before ?? 24;
    const hoursBefore = Number.isFinite(hoursBeforeNum) && hoursBeforeNum > 0 ? hoursBeforeNum : 24;
    if (reminderEnabled) {
      const sendAt = new Date(startDate.getTime() - hoursBefore * 60 * 60_000).toISOString();
      await c.env.QUEUE?.send({ bookingId: id, sendAt });
    }
  } catch (err) {
    console.warn("[Queue] Could not enqueue reminder (non-fatal):", err);
  }

  return c.json({
    success: true,
    data: {
      id,
      shop_id,
      staff_id,
      service_id,
      customer_name,
      customer_email,
      booking_date: bookingDate,
      start_time: startISO,
      end_time: endISO,
      status: "pending",
      amount: service.price,
      commission,
    },
  }, 201);
});

export { bookings as bookingsRouter, publicBookings as publicBookingRouter };
