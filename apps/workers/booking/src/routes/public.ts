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
  getShopById,
  getShopBySlug,
  getServiceById,
  getStaffById,
  createBooking,
  checkSlotConflict,
  cancelPendingBookingStmts,
} from "../db/queries.js";
import { getAvailableSlots } from "../services/slots.js";
import { runBookingSideEffects } from "../services/booking-side-effects.js";
import { reportError } from "../services/report-error.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { createCheckoutSession } from "../lib/stripe.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, statusOutcome } from "../audit/context.js";
import { addMinutes, calculateCommissionPence, isPortfolioDemoShopRecord, PORTFOLIO_DEMO_ERROR } from "@repo/utils";

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
    return c.json(
      { success: false, error: "date and service_id are required" },
      400,
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      { success: false, error: "date must be in YYYY-MM-DD format" },
      400,
    );
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
    c.env.KV,
  );

  return c.json({ success: true, data: slotList });
});

// ─── POST /public/bookings — customer booking creation ───────────────────────

publicRoutes.post(
  "/bookings",
  rateLimit({
    name: "public-booking",
    limit: 30,
    windowS: 3600,
    key: clientIp,
  }),
  async (c) => {
    const body = await c.req.json<{
      shop_id?: string;
      shop_slug?: string;
      staff_id?: string;
      service_id?: string;
      customer_name?: string;
      customer_email?: string;
      customer_phone?: string;
      start_time?: string; // ISO string
      date?: string; // shop-local YYYY-MM-DD the slot was offered for
      notes?: string;
    }>();

    const {
      shop_id,
      shop_slug,
      staff_id,
      service_id,
      customer_name,
      customer_email,
      start_time,
    } = body;
    if (
      (!shop_id && !shop_slug) ||
      !staff_id ||
      !service_id ||
      !customer_name ||
      !customer_email ||
      !start_time
    ) {
      return c.json(
        {
          success: false,
          error:
            "shop_id (or shop_slug), staff_id, service_id, customer_name, customer_email and start_time are required",
        },
        400,
      );
    }

    // Validate shop — accept either id or slug (the booking UI sends the slug)
    const shop = shop_id
      ? await getShopById(c.env.DB, shop_id)
      : await getShopBySlug(c.env.DB, shop_slug!);
    if (!shop || !shop.is_active)
      return c.json({ success: false, error: "Shop not found" }, 404);

    // Enforced on the resolved shop, so using its original ID cannot bypass the demo boundary.
    if (isPortfolioDemoShopRecord(shop)) {
      return c.json({ success: false, error: PORTFOLIO_DEMO_ERROR }, 403);
    }

    // Validate service
    const service = await getServiceById(c.env.DB, service_id);
    if (!service || service.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }

    // Parse + range-check the requested time
    const startDate = new Date(start_time);
    if (Number.isNaN(startDate.getTime())) {
      return c.json(
        { success: false, error: "start_time must be a valid ISO date-time" },
        400,
      );
    }
    if (startDate.getTime() <= Date.now()) {
      return c.json(
        { success: false, error: "start_time must be in the future" },
        400,
      );
    }
    const startISO = startDate.toISOString();

    // For a specific staff request, validate the staff up front so an invalid or
    // cross-shop staff_id returns a precise 404 (rather than a generic slot 409).
    if (staff_id !== "any") {
      const reqStaff = await getStaffById(c.env.DB, staff_id);
      if (
        !reqStaff ||
        reqStaff.shop_id !== shop.id ||
        reqStaff.is_active !== 1
      ) {
        return c.json({ success: false, error: "Staff member not found" }, 404);
      }
    }

    // Validate the time is a real, available slot in the staff schedule. Reuses
    // the same computation the booking UI reads, so any offered slot is accepted
    // while arbitrary / off-schedule / misaligned times are rejected. For an
    // "any available" request, adopt the staff_id of the matching free slot.
    const slotDate =
      body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : toDateString(startISO);
    const requestedStaff = staff_id === "any" ? null : staff_id;
    const slotList = await getAvailableSlots(
      shop.id,
      requestedStaff,
      slotDate,
      service.duration_min,
      c.env.DB,
      c.env.KV,
    );
    const matchingSlot = slotList.find(
      (s) => s.start_time === startISO && s.is_available,
    );
    if (!matchingSlot) {
      return c.json(
        { success: false, error: "Selected time is not available" },
        409,
      );
    }
    const resolvedStaffId = matchingSlot.staff_id;

    // Defensive: confirm the resolved staff belongs to this shop and is active
    const bookedStaff = await getStaffById(c.env.DB, resolvedStaffId);
    if (
      !bookedStaff ||
      bookedStaff.shop_id !== shop.id ||
      bookedStaff.is_active !== 1
    ) {
      return c.json({ success: false, error: "Staff member not found" }, 404);
    }

    const endDate = addMinutes(startDate, service.duration_min);
    const bookingDate = toDateString(startISO);
    const endISO = endDate.toISOString();

    // Defense-in-depth against the read->write race (the unique active-slot index
    // from migration 018 is the real guard; see the createBooking catch below).
    const conflict = await checkSlotConflict(
      c.env.DB,
      resolvedStaffId,
      startISO,
      endISO,
    );
    if (conflict) {
      return c.json(
        { success: false, error: "This time slot is no longer available" },
        409,
      );
    }

    const { commission_pence } = calculateCommissionPence(
      service.price_pence,
      shop.commission_rate,
    );
    const id = crypto.randomUUID();
    let depositRequired = false;

    // From the first write to the response: one started/outcome pair. The
    // validation, 404s and the slot pre-check above change nothing, so they
    // write nothing. A 409 (slot taken) is recorded refused, a 502 (no
    // Checkout Session) failed. Personal data and the Checkout URL are never
    // recorded: only structured values.
    try {
      return await auditFor(c).run(
        { action: "booking.create", shopId: shop.id, entityType: "booking", entityId: id },
        async (): Promise<Response> => {
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
          if (
            err instanceof Error &&
            err.message.includes("UNIQUE constraint failed")
          ) {
            return c.json(
              { success: false, error: "This time slot is no longer available" },
              409,
            );
          }
          throw err;
        }

        // Customer-facing deposit (migration 041): when the shop has enabled
        // deposits AND has a working Connect account, the booking stays 'pending'
        // and the customer is sent to a hosted Stripe Checkout page. The
        // payment_intent.succeeded webhook flips it to 'confirmed' and runs the
        // side effects; an expired/abandoned session frees the slot (webhook +
        // cron sweep). Everything else keeps today's free booking flow.
        const connectId = shop.stripe_connect_account_id?.trim();
        const depositCfg = await c.env.DB.prepare(
          "SELECT deposits_enabled, deposit_percent, deposit_min_pence FROM shop_settings WHERE shop_id = ? LIMIT 1",
        )
          .bind(shop.id)
          .first<{
            deposits_enabled: number | null;
            deposit_percent: number | null;
            deposit_min_pence: number | null;
          }>();
        const depositsOn =
          depositCfg?.deposits_enabled === 1 &&
          Boolean(connectId) &&
          shop.stripe_connect_onboarded === 1;

        if (depositsOn) {
          const pct = Math.min(
            100,
            Math.max(1, Math.round(Number(depositCfg?.deposit_percent ?? 50))),
          );
          const minPence = Math.max(
            0,
            Math.round(Number(depositCfg?.deposit_min_pence ?? 500)),
          );
          // Deposit never exceeds the service price; a high minimum becomes full prepay.
          const depositPence = Math.min(
            service.price_pence,
            Math.max(Math.round((service.price_pence * pct) / 100), minPence),
          );

          if (depositPence > 0) {
            // Only a booking that really goes to Checkout needs a deposit; a
            // zero deposit takes the free path below.
            depositRequired = true;
            // Platform fee on the deposit portion only — the appointment checkout
            // collects the remaining commission on the balance charge (it reads
            // deposit_application_fee_pence back to stay exact).
            const depositFeePence = calculateCommissionPence(
              depositPence,
              shop.commission_rate,
            ).commission_pence;
            const webUrl = (c.env.WEB_URL ?? "").replace(/\/$/, "");

            let session: { id: string; url: string };
            try {
              session = await createCheckoutSession({
                secret: c.env.STRIPE_SECRET_KEY,
                amountPence: depositPence,
                currency: "gbp",
                productName: `Booking deposit: ${service.name} at ${shop.name}`,
                destinationAccount: connectId!,
                applicationFeePence: depositFeePence,
                metadata: {
                  shopId: shop.id,
                  bookingId: id,
                  type: "booking_deposit",
                },
                successUrl: `${webUrl}/${shop.slug}/confirm?id=${id}&paid=1`,
                cancelUrl: `${webUrl}/${shop.slug}/book?payment=cancelled&booking=${id}`,
                idempotencyKey: `deposit:${id}`,
                // Stripe minimum is 30 min from creation; 31 keeps clock skew safe.
                expiresAtEpochS: Math.floor(Date.now() / 1000) + 31 * 60,
              });
            } catch (e) {
              // No session, no booking: release the slot instead of stranding a
              // pending row the customer can never pay for.
              reportError("booking.deposit_session_create", e, {
                shopId: shop.id,
                bookingId: id,
              });
              await c.env.DB.prepare(
                "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
              )
                .bind(id)
                .run();
              return c.json(
                { success: false, error: "Could not start the deposit payment" },
                502,
              );
            }

            const nowIso = new Date().toISOString();
            await c.env.DB.batch([
              c.env.DB.prepare(
                `INSERT INTO bw_booking_state (booking_id, shop_id, booking_type, deposit_amount_pence,
                   stripe_checkout_session_id, deposit_application_fee_pence, slot_time, updated_at)
                 VALUES (?, ?, 'online', ?, ?, ?, ?, ?)`,
              ).bind(
                id,
                shop.id,
                depositPence,
                session.id,
                depositFeePence,
                startISO.slice(11, 16),
                nowIso,
              ),
              c.env.DB.prepare(
                `INSERT INTO bw_transactions (id, booking_id, shop_id, type, amount_pence, status, stripe_id)
                 VALUES (?, ?, ?, 'deposit', ?, 'pending', ?)`,
              ).bind(crypto.randomUUID(), id, shop.id, depositPence, session.id),
            ]);

            // No confirmation email / reminder yet — the webhook sends them once
            // the deposit settles.
            return c.json(
              {
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
                  deposit_pence: depositPence,
                  checkout_url: session.url,
                },
              },
              201,
            );
          }
        }

        // Free booking (no deposit): side effects run immediately, as before.
        await runBookingSideEffects(c.env, {
          bookingId: id,
          shopId: shop.id,
          shopName: shop.name,
          shopSlug: shop.slug,
          customerName: customer_name,
          customerEmail: customer_email,
          serviceName: service.name,
          staffName: bookedStaff.display_name ?? "your specialist",
          bookingDate,
          startISO,
          timezone: shop.timezone ?? "Europe/London",
          durationMin: service.duration_min,
          amountPence: service.price_pence,
        });

        return c.json(
          {
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
          },
          201,
        );
        },
        statusOutcome((res) =>
          res.status < 400
            ? {
                changes: { status: [null, "pending"] },
                details: { channel: "online", deposit_required: depositRequired },
              }
            : {}
        )
      );
    } catch (e) {
      if (e instanceof AuditWriteError) return auditRefused(c);
      throw e;
    }
  },
);

// ─── GET /public/bookings/:bookingId — minimal status for the confirm page ───
// Knowing the UUID ≈ having created the booking; still, only non-PII fields.

publicRoutes.get("/bookings/:bookingId", async (c) => {
  const bookingId = c.req.param("bookingId");
  const row = await c.env.DB.prepare(
    `SELECT b.id, b.status, b.booking_date, b.start_time,
              st.deposit_amount_pence, st.deposit_paid_at
       FROM bookings b LEFT JOIN bw_booking_state st ON st.booking_id = b.id
       WHERE b.id = ? LIMIT 1`,
  )
    .bind(bookingId)
    .first<{
      id: string;
      status: string;
      booking_date: string;
      start_time: string;
      deposit_amount_pence: number | null;
      deposit_paid_at: string | null;
    }>();
  if (!row) return c.json({ success: false, error: "Booking not found" }, 404);
  return c.json({
    success: true,
    data: {
      id: row.id,
      status: row.status,
      booking_date: row.booking_date,
      start_time: row.start_time,
      deposit_pence: row.deposit_amount_pence ?? 0,
      deposit_paid: Boolean(row.deposit_paid_at),
    },
  });
});

// ─── POST /public/bookings/:bookingId/abandon — cancel an unpaid deposit booking ─
// Backs the Stripe cancel_url so the slot frees immediately instead of
// waiting for session expiry. Deliberately narrow: only a still-pending,
// deposit-gated, unpaid booking can be cancelled this way.

publicRoutes.post(
  "/bookings/:bookingId/abandon",
  rateLimit({
    name: "public-booking-abandon",
    limit: 30,
    windowS: 3600,
    key: clientIp,
  }),
  async (c) => {
    const bookingId = c.req.param("bookingId");
    const st = await c.env.DB.prepare(
      `SELECT booking_id, shop_id FROM bw_booking_state
         WHERE booking_id = ? AND stripe_checkout_session_id IS NOT NULL AND deposit_paid_at IS NULL LIMIT 1`,
    )
      .bind(bookingId)
      .first<{ booking_id: string; shop_id: string }>();
    if (!st) return c.json({ success: false, error: "Booking not found" }, 404);

    // Guarded batch: the cancel and its entry commit together, and only while
    // the booking is still pending. If the sweep or the expiry webhook won the
    // race the guard rolls the batch back, the answer stays what it always
    // was, and the trail records the refused attempt.
    const entity = { shopId: st.shop_id, entityType: "booking", entityId: bookingId };
    try {
      await auditFor(c).batch(cancelPendingBookingStmts(c.env.DB, bookingId), {
        action: "booking.cancel",
        outcome: "succeeded",
        ...entity,
        changes: { status: ["pending", "cancelled"] },
        details: { reason: "abandoned" },
      });
    } catch (e) {
      if (e instanceof AuditWriteError) return auditRefused(c);
      const now = await c.env.DB.prepare("SELECT status FROM bookings WHERE id = ?")
        .bind(bookingId)
        .first<{ status: string }>();
      if (now?.status === "pending") throw e;
      try {
        await auditFor(c).write({ action: "booking.cancel", outcome: "refused", reason: "not_pending", ...entity });
      } catch {
        // Best effort: a failure to record the refusal never changes the answer.
      }
    }
    return c.json({ success: true });
  },
);

export default publicRoutes;
