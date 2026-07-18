import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getBookingsByShop, getBookingById,
  updateBookingStatus, cancelBookingIfOpen, getServiceById, getShopById,
} from "../db/queries.js";
import { authMiddleware } from "../middleware/auth.js";
import { sendReviewRequest } from "../services/email.js";
import { notifyWaitlistForOpenedSlot } from "../services/waitlist-notify.js";
import { requireShopRole } from "../middleware/rbac.js";
import { reportError } from "../services/report-error.js";

// ─── Router: /api/shops/:shopId/bookings (authenticated, requireShop) ─────────

const bookings = new Hono<{ Bindings: Bindings }>();
// Operational: admins and staff of the shop (developers bypass). Excludes customers.
bookings.use("*", authMiddleware, requireShopRole("admin", "staff"));

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

  // Cancellation is applied atomically against the open statuses so that
  // concurrent duplicate cancels perform the open → cancelled transition
  // exactly once (only that request fires the waitlist fan-out below). Any
  // other transition, and cancelling an already-closed booking, keeps the
  // original unconditional behavior.
  let freedSlot = false;
  if (body.status === "cancelled") {
    const res = await cancelBookingIfOpen(c.env.DB, bookingId);
    freedSlot = (res.meta?.changes ?? 0) > 0;
    if (!freedSlot) await updateBookingStatus(c.env.DB, bookingId, body.status);
  } else {
    await updateBookingStatus(c.env.DB, bookingId, body.status);
  }

  // Send review request when booking is marked completed
  if (body.status === "completed" && c.env.RESEND_API_KEY) {
    try {
      const reviewPref = await c.env.DB
        .prepare("SELECT review_request_email FROM shop_settings WHERE shop_id = ? LIMIT 1")
        .bind(shopId)
        .first<{ review_request_email: number | null }>();
      if (reviewPref?.review_request_email !== 0) {
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
      }
    } catch (err) {
      // Non-fatal: the status update stands even if the review email fails.
      reportError("booking.review_request_email", err, { shopId, bookingId });
    }
  }

  // A real open → cancelled transition frees a slot: notify matching waitlist
  // entries. `freedSlot` comes from the atomic UPDATE above (exactly once,
  // never on no_show/completed/re-saves), and past bookings are skipped so
  // housekeeping cancellations of old rows never advertise a slot that is
  // not actually available.
  const slotInFuture = new Date(booking.start_time).getTime() > Date.now();
  if (freedSlot && slotInFuture && c.env.RESEND_API_KEY) {
    try {
      const shop = await getShopById(c.env.DB, shopId);
      if (shop) {
        await notifyWaitlistForOpenedSlot(c.env.DB, c.env.RESEND_API_KEY, shop, {
          bookingDate: booking.booking_date,
          staffId: booking.staff_id,
        });
      }
    } catch (err) {
      // Non-fatal: the cancellation stands even if waitlist emails fail.
      reportError("booking.waitlist_notify", err, { shopId, bookingId });
    }
  }

  return c.json({ success: true });
});

// ─── Router: /api/bookings (public — customer booking) ───────────────────────
// WS-1: the booking worker (pivot-parlor-booking) is the canonical booking
// system. This proxies the request over the BOOKING service binding —
// method, headers (CF-Connecting-IP feeds its rate limiter via the shared KV)
// and body pass through unchanged, so the response contract the Remix action
// consumes is exactly what it was when the handler lived here.

const publicBookings = new Hono<{ Bindings: Bindings }>();

publicBookings.post("/", (c) =>
  c.env.BOOKING.fetch(new Request("https://booking/public/bookings", c.req.raw))
);

// Minimal public status — the post-payment confirm page polls this until the
// deposit webhook flips the booking to confirmed (migration 041).
publicBookings.get("/:bookingId", (c) =>
  c.env.BOOKING.fetch(
    new Request(
      `https://booking/public/bookings/${encodeURIComponent(c.req.param("bookingId"))}`,
      c.req.raw
    )
  )
);

// Cancel an unpaid deposit booking (Stripe cancel_url) so the slot frees
// immediately; the booking worker only honours pending+unpaid rows.
publicBookings.post("/:bookingId/abandon", (c) =>
  c.env.BOOKING.fetch(
    new Request(
      `https://booking/public/bookings/${encodeURIComponent(c.req.param("bookingId"))}/abandon`,
      c.req.raw
    )
  )
);

export { bookings as bookingsRouter, publicBookings as publicBookingRouter };
