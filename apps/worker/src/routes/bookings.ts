import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getBookingsByShop, getBookingById, getBookingDepositState,
  updateBookingStatus, cancelBookingIfOpen, getServiceById, getShopById,
} from "../db/queries.js";
import { authMiddleware, extractSessionJwt } from "../middleware/auth.js";
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

  const body = await c.req.json<{ status?: string; refund_deposit?: boolean }>();
  const valid = ["confirmed", "completed", "cancelled", "no_show"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }

  // Slot-in-future check shared by both cancellation paths. start_time is an
  // ISO instant for public bookings but bare "HH:MM" for staff-created hold
  // bookings — combine with booking_date when the direct parse fails.
  const startMs = (() => {
    const direct = new Date(booking.start_time).getTime();
    if (!Number.isNaN(direct)) return direct;
    return new Date(`${booking.booking_date}T${booking.start_time}`).getTime();
  })();
  const slotInFuture = startMs > Date.now();

  // Deposit-aware cancellation fork (WS-2 follow-up): when the booking has
  // live Stripe deposit money — a captured deposit not yet credited to a
  // sale, or an uncaptured hold — the cancel must run in the booking worker
  // (the only worker with Stripe credentials), which refunds/keeps/voids per
  // refund_deposit and flips the status itself. Already-cancelled bookings
  // route through too: that is the recovery path for deposits stranded by
  // the deposit-blind customer self-cancel. Everything else falls through to
  // the plain local update exactly as before.
  if (body.status === "cancelled" && !["completed", "no_show"].includes(booking.status)) {
    const dep = await getBookingDepositState(c.env.DB, bookingId, shopId);
    const depositRelevant =
      dep?.stripe_payment_intent_id &&
      ((dep.deposit_paid_at && dep.deposit_tx_status === "captured" && !dep.deposit_tx_sale_id) ||
        (!dep.deposit_paid_at && dep.deposit_tx_status === "pending"));
    if (depositRelevant) {
      // The booking worker's auth is Bearer-only; cookie sessions carry the
      // same JWT, so mint the header from whichever transport arrived.
      const token = extractSessionJwt(c.req.raw.headers);
      const fwd = new Headers({ "Content-Type": "application/json" });
      if (token) fwd.set("Authorization", `Bearer ${token}`);
      const res = await c.env.BOOKING.fetch(
        new Request(`https://booking/booking/shops/${shopId}/bookings/${bookingId}/cancel`, {
          method: "POST",
          headers: fwd,
          // Forward refund_deposit only when the client actually sent it: the
          // booking worker defaults fresh cancels to refund, but its recovery
          // path acts only on an EXPLICIT true — a bare re-cancel must never
          // silently refund a deposit staff chose to keep.
          body: JSON.stringify(
            typeof body.refund_deposit === "boolean" ? { refundDeposit: body.refund_deposit } : {}
          ),
        })
      );
      const payload = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: { flipped?: boolean } }
        | null;

      // Fire the waitlist fan-out only when the booking worker reports IT
      // performed the open → cancelled flip — exactly one notifier even
      // under racing cancels, and never for recovery calls.
      if (payload?.data?.flipped === true && slotInFuture && c.env.RESEND_API_KEY) {
        try {
          const shop = await getShopById(c.env.DB, shopId);
          if (shop) {
            await notifyWaitlistForOpenedSlot(c.env.DB, c.env.RESEND_API_KEY, shop, {
              bookingDate: booking.booking_date,
              staffId: booking.staff_id,
            });
          }
        } catch (err) {
          reportError("booking.waitlist_notify", err, { shopId, bookingId });
        }
      }
      return c.json(
        payload ?? { success: false, error: "Cancellation failed" },
        res.status as 200
      );
    }
    // An explicit refund request for a booking whose deposit is not live
    // (already refunded, credited to a sale, or never existed) must not
    // silently succeed as a plain status change — the admin asked for money
    // movement that cannot happen.
    if (body.refund_deposit === true) {
      return c.json({ success: false, error: "Deposit already refunded or not refundable" }, 400);
    }
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
