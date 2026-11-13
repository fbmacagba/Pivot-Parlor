// ─── Worker route: /api/dev/* and /api/me/* and /api/staff/me/* ──────────────
// Adds the missing dashboard endpoints identified in DASHBOARD_SPEC.md

import { Hono, type Context } from "hono";
import { AuditWriteError } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { auditFor, auditRefused, batchWithAudit, statusOutcome } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import {
  getBookingById,
  getPlatformRevenueByMonth,
  getRevenueByShop,
  getShopById,
  getShopTimezone,
} from "../db/queries.js";
import {
  PLATFORM_TIME_ZONE,
  START_HOUR_BUCKET_SQL,
  peakHoursInShopTime,
  scheduleDayOf,
  shopMonthStart,
  shopToday,
} from "../lib/shopTime.js";
import { notifyWaitlistForOpenedSlot } from "../services/waitlist-notify.js";
import { reportError } from "../services/report-error.js";

// ─────────────────────────────────────────────────────────────────────────────
// /api/dev  — Developer-only platform stats
// ─────────────────────────────────────────────────────────────────────────────

export const devRouter = new Hono<{ Bindings: Bindings }>();
devRouter.use("*", authMiddleware, requireRole("developer"));

/**
 * GET /api/dev/stats
 * Platform summary for developer overview dashboard.
 */
devRouter.get("/stats", async (c) => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const [shopRow, bookingRow, enquiryRow] = await Promise.all([
    c.env.DB
      .prepare("SELECT COUNT(*) AS total FROM shops WHERE status = 'active'")
      .first<{ total: number }>(),
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS bookings_count,
                COALESCE(SUM(commission_pence), 0) AS commission_total_pence
         FROM bookings
         WHERE booking_date >= ? AND booking_date <= ?
           AND status = 'completed'`
      )
      .bind(
        `${year}-${String(month).padStart(2, "0")}-01`,
        `${year}-${String(month).padStart(2, "0")}-31`
      )
      .first<{ bookings_count: number; commission_total_pence: number }>(),
    c.env.DB
      .prepare("SELECT COUNT(*) AS total FROM contacts WHERE onboarded_at IS NULL")
      .first<{ total: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      total_shops: shopRow?.total ?? 0,
      bookings_this_month: bookingRow?.bookings_count ?? 0,
      platform_commission_pence: bookingRow?.commission_total_pence ?? 0,
      pending_enquiries: enquiryRow?.total ?? 0,
    },
  });
});

/**
 * GET /api/dev/revenue?year=YYYY&month=MM
 * Per-shop revenue breakdown for the developer revenue page.
 */
devRouter.get("/revenue", async (c) => {
  const now = new Date();
  const year = Number(c.req.query("year") ?? now.getUTCFullYear());
  const month = Number(c.req.query("month") ?? (now.getUTCMonth() + 1));

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ success: false, error: "Invalid year or month" }, 400);
  }

  const rows = await getPlatformRevenueByMonth(c.env.DB, year, month);

  const totals = rows.reduce(
    (acc, r) => {
      acc.total_bookings += r.booking_count;
      acc.total_gross_pence += r.gross_pence;
      acc.total_commission_pence += r.commission_pence;
      return acc;
    },
    { total_bookings: 0, total_gross_pence: 0, total_commission_pence: 0 }
  );

  return c.json({
    success: true,
    data: {
      year,
      month,
      totals,
      shops: rows,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/shops/:shopId/stats  — Admin shop stats (mounted under shopsRouter via index.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const shopStatsRouter = new Hono<{ Bindings: Bindings }>();
shopStatsRouter.use("*", authMiddleware);

/**
 * GET /api/shops/:shopId/stats?date=YYYY-MM-DD
 * Today's summary for the admin overview dashboard.
 * Developer can access any shop; admin restricted to their own shop_id.
 */
shopStatsRouter.get("/", async (c) => {
  const user = getUser(c);
  const shopId = c.req.param("shopId")!;

  // RBAC: developer sees any shop; admin sees only their own
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shopId)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const dateParam = c.req.query("date");
  const today = dateParam ?? shopToday(await getShopTimezone(c.env.DB, shopId));

  const [todayRow, activeStaffRow, waitlistRow] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS bookings_count,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_pence ELSE 0 END), 0) AS revenue_pence
         FROM bookings
         WHERE shop_id = ? AND booking_date = ?`
      )
      .bind(shopId, today)
      .first<{ bookings_count: number; revenue_pence: number }>(),

    // "Staff on shift" = active staff scheduled for today's weekday, plus
    // anyone with a live booking today; UNION counts each person once.
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS active FROM (
           SELECT sc.staff_id
           FROM schedules sc
           JOIN staff s ON s.id = sc.staff_id
           WHERE sc.shop_id = ? AND s.shop_id = ? AND s.is_active = 1
             AND sc.day_of_week = ? AND sc.is_active = 1
           UNION
           SELECT staff_id
           FROM bookings
           WHERE shop_id = ? AND booking_date = ?
             AND status NOT IN ('cancelled', 'no_show')
         )`
      )
      .bind(shopId, shopId, scheduleDayOf(today), shopId, today)
      .first<{ active: number }>(),

    c.env.DB
      .prepare(
        "SELECT COUNT(*) AS total FROM waitlist WHERE shop_id = ? AND status = 'waiting'"
      )
      .bind(shopId)
      .first<{ total: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      date: today,
      todays_bookings: todayRow?.bookings_count ?? 0,
      todays_revenue_pence: todayRow?.revenue_pence ?? 0,
      active_staff: activeStaffRow?.active ?? 0,
      waitlist_count: waitlistRow?.total ?? 0,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/shops/:shopId/revenue  — Admin revenue breakdown
// ─────────────────────────────────────────────────────────────────────────────

export const shopRevenueRouter = new Hono<{ Bindings: Bindings }>();
shopRevenueRouter.use("*", authMiddleware);

/**
 * GET /api/shops/:shopId/revenue?year=YYYY&month=MM
 * Monthly revenue summary + per-staff + per-service breakdown.
 */
shopRevenueRouter.get("/", async (c) => {
  const user = getUser(c);
  const shopId = c.req.param("shopId")!;

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shopId)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const now = new Date();
  const year = Number(c.req.query("year") ?? now.getUTCFullYear());
  const month = Number(c.req.query("month") ?? (now.getUTCMonth() + 1));

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return c.json({ success: false, error: "Invalid year or month" }, 400);
  }

  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;

  const [summary, byStaff, byService, daily] = await Promise.all([
    getRevenueByShop(c.env.DB, shopId, year, month),

    // Per-staff breakdown
    c.env.DB
      .prepare(
        `SELECT st.id AS staff_id, st.display_name,
                COUNT(b.id) AS booking_count,
                COALESCE(SUM(b.amount_pence), 0) AS gross_pence,
                COALESCE(SUM(b.commission_pence), 0) AS commission_pence
         FROM staff st
         LEFT JOIN bookings b ON b.staff_id = st.id
           AND b.shop_id = ? AND b.booking_date >= ? AND b.booking_date <= ?
           AND b.status = 'completed'
         WHERE st.shop_id = ? AND st.is_active = 1
         GROUP BY st.id
         ORDER BY gross_pence DESC`
      )
      .bind(shopId, from, to, shopId)
      .all<{
        staff_id: string;
        display_name: string;
        booking_count: number;
        gross_pence: number;
        commission_pence: number;
      }>(),

    // Per-service breakdown
    c.env.DB
      .prepare(
        `SELECT sv.id AS service_id, sv.name AS service_name,
                COUNT(b.id) AS booking_count,
                COALESCE(SUM(b.amount_pence), 0) AS gross_pence
         FROM services sv
         LEFT JOIN bookings b ON b.service_id = sv.id
           AND b.shop_id = ? AND b.booking_date >= ? AND b.booking_date <= ?
           AND b.status = 'completed'
         WHERE sv.shop_id = ? AND sv.is_active = 1
         GROUP BY sv.id
         ORDER BY gross_pence DESC`
      )
      .bind(shopId, from, to, shopId)
      .all<{
        service_id: string;
        service_name: string;
        booking_count: number;
        gross_pence: number;
      }>(),

    // Daily totals for chart (all days in month)
    c.env.DB
      .prepare(
        `SELECT booking_date,
                COUNT(*) AS booking_count,
                COALESCE(SUM(amount_pence), 0) AS gross_pence,
                COALESCE(SUM(commission_pence), 0) AS commission_pence
         FROM bookings
         WHERE shop_id = ? AND booking_date >= ? AND booking_date <= ?
           AND status = 'completed'
         GROUP BY booking_date
         ORDER BY booking_date`
      )
      .bind(shopId, from, to)
      .all<{
        booking_date: string;
        booking_count: number;
        gross_pence: number;
        commission_pence: number;
      }>(),
  ]);

  return c.json({
    success: true,
    data: {
      year,
      month,
      summary,
      by_staff: byStaff.results,
      by_service: byService.results,
      daily: daily.results,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/staff/me/*  — Staff member's own data (scoped to their staff record)
// ─────────────────────────────────────────────────────────────────────────────

export const staffMeRouter = new Hono<{ Bindings: Bindings }>();
staffMeRouter.use("*", authMiddleware, requireRole("staff", "developer", "admin"));

/**
 * Resolves the staff record for the authenticated user.
 * Staff have user_id in JWT sub; we look up their staff row by user_id + shop_id.
 */
async function resolveMyStaffId(
  db: Bindings["DB"],
  userId: string,
  shopId: string | undefined
): Promise<string | null> {
  if (!shopId) return null;
  const row = await db
    .prepare(
      "SELECT id FROM staff WHERE user_id = ? AND shop_id = ? AND is_active = 1 LIMIT 1"
    )
    .bind(userId, shopId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The staff record a /me READ shows. Staff (and admins who are on the team)
 * always get their own, whatever the query string says. A developer has no
 * staff record: Staff View names the person with ?staffId= and shows exactly
 * their screens, read-only (the writes below refuse a developer).
 */
async function resolveViewedStaff(
  c: Context<{ Bindings: Bindings }>
): Promise<{ staffId: string; shopId: string } | null> {
  const user = getUser(c);
  if (user.role === "developer") {
    const requested = c.req.query("staffId")?.trim();
    if (!requested) return null;
    const row = await c.env.DB
      .prepare("SELECT id, shop_id FROM staff WHERE id = ? AND is_active = 1 LIMIT 1")
      .bind(requested)
      .first<{ id: string; shop_id: string }>();
    return row ? { staffId: row.id, shopId: row.shop_id } : null;
  }
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, user.shop_id);
  return staffId && user.shop_id ? { staffId, shopId: user.shop_id } : null;
}

const DEVELOPER_READ_ONLY = "Developers can view staff screens but not act for staff.";

/**
 * GET /api/staff/me/today
 * Today's bookings for the authenticated staff member.
 * Returns bookings with customer name (NOT email/phone in list — detail view only).
 */
staffMeRouter.get("/today", async (c) => {
  const viewed = await resolveViewedStaff(c);
  if (!viewed) {
    return c.json({ success: true, data: [] });
  }
  const { staffId, shopId } = viewed;

  const today = shopToday(await getShopTimezone(c.env.DB, shopId));

  const { results } = await c.env.DB
    .prepare(
      `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
              b.customer_name,
              sv.name AS service_name, sv.duration_min,
              sv.price_pence AS amount_pence
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       WHERE b.staff_id = ? AND b.booking_date = ?
         AND b.status NOT IN ('cancelled', 'no_show')
       ORDER BY b.start_time`
    )
    .bind(staffId, today)
    .all<{
      id: string;
      booking_date: string;
      start_time: string;
      end_time: string;
      status: string;
      notes: string | null;
      customer_name: string;
      service_name: string;
      duration_min: number;
      amount_pence: number;
    }>();

  return c.json({ success: true, data: results });
});

/**
 * GET /api/staff/me/bookings?filter=upcoming|past&limit=20&offset=0
 * Staff member's own booking list.
 * GDPR note: customer email/phone NOT returned in list — available only in detail endpoint.
 */
staffMeRouter.get("/bookings", async (c) => {
  const viewed = await resolveViewedStaff(c);
  if (!viewed) {
    return c.json({ success: true, data: [] });
  }
  const { staffId, shopId } = viewed;

  const filter = c.req.query("filter") ?? "upcoming";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const offset = Number(c.req.query("offset") ?? 0);
  const today = shopToday(await getShopTimezone(c.env.DB, shopId));

  // The operator is fixed SQL; the date is bound below, never interpolated.
  const dateCond = filter === "past" ? "b.booking_date < ?" : "b.booking_date >= ?";

  const orderDir = filter === "past" ? "DESC" : "ASC";

  const { results } = await c.env.DB
    .prepare(
      `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status,
              b.customer_name,
              sv.name AS service_name, sv.duration_min
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       WHERE b.staff_id = ? AND ${dateCond}
       ORDER BY b.booking_date ${orderDir}, b.start_time ${orderDir}
       LIMIT ? OFFSET ?`
    )
    .bind(staffId, today, limit, offset)
    .all<{
      id: string;
      booking_date: string;
      start_time: string;
      end_time: string;
      status: string;
      customer_name: string;
      service_name: string;
      duration_min: number;
    }>();

  return c.json({ success: true, data: results });
});

/**
 * GET /api/staff/me/bookings/:bookingId
 * Full booking detail for a single booking — includes customer contact details.
 * Only accessible if the booking belongs to this staff member.
 */
staffMeRouter.get("/bookings/:bookingId", async (c) => {
  const viewed = await resolveViewedStaff(c);
  const bookingId = c.req.param("bookingId");

  if (!viewed) {
    return c.json({ success: false, error: "Staff record not found" }, 404);
  }
  const { staffId } = viewed;

  const booking = await c.env.DB
    .prepare(
      `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
              b.customer_name, b.customer_email, b.customer_phone,
              sv.name AS service_name, sv.duration_min, sv.price_pence AS amount_pence
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       WHERE b.id = ? AND b.staff_id = ?
       LIMIT 1`
    )
    .bind(bookingId, staffId)
    .first<{
      id: string;
      booking_date: string;
      start_time: string;
      end_time: string;
      status: string;
      notes: string | null;
      customer_name: string;
      customer_email: string;
      customer_phone: string | null;
      service_name: string;
      duration_min: number;
      amount_pence: number;
    }>();

  if (!booking) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }

  return c.json({ success: true, data: booking });
});

/**
 * PUT /api/staff/me/bookings/:bookingId/status
 * Staff can mark their own bookings as in_progress or completed.
 */
staffMeRouter.put("/bookings/:bookingId/status", async (c) => {
  const user = getUser(c);
  if (user.role === "developer") {
    return c.json({ success: false, error: DEVELOPER_READ_ONLY }, 403);
  }
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);
  const bookingId = c.req.param("bookingId");

  if (!staffId) {
    return c.json({ success: false, error: "Staff record not found" }, 404);
  }

  const body = await c.req.json<{ status?: string }>();
  const allowed = ["in_progress", "completed"];
  if (!body.status || !allowed.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${allowed.join(", ")}` }, 400);
  }

  // Verify booking belongs to this staff member
  const existing = await c.env.DB
    .prepare("SELECT id, status FROM bookings WHERE id = ? AND staff_id = ? LIMIT 1")
    .bind(bookingId, staffId)
    .first<{ id: string; status: string }>();

  if (!existing) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }

  // Unconditional UPDATE, so Pattern B: the entry joins the same batch.
  const refused = await batchWithAudit(
    c,
    [c.env.DB.prepare("UPDATE bookings SET status = ? WHERE id = ?").bind(body.status, bookingId)],
    {
      action: "booking.status",
      outcome: "succeeded",
      shopId,
      entityType: "booking",
      entityId: bookingId,
      changes: fieldChanges(existing, { status: body.status }).changes,
    },
  );
  if (refused) return refused;

  return c.json({ success: true });
});

/**
 * GET /api/staff/me/schedule
 * Staff member's own weekly schedule.
 */
staffMeRouter.get("/schedule", async (c) => {
  const viewed = await resolveViewedStaff(c);
  if (!viewed) {
    return c.json({ success: true, data: [] });
  }
  const { staffId } = viewed;

  const { results } = await c.env.DB
    .prepare(
      "SELECT day_of_week, start_time, end_time, is_active FROM schedules WHERE staff_id = ? ORDER BY day_of_week"
    )
    .bind(staffId)
    .all<{ day_of_week: number; start_time: string; end_time: string; is_active: number }>();

  return c.json({ success: true, data: results });
});

/** UTC midnight of a YYYY-MM-DD date, or null when it is not a real calendar
 *  date (month 13, Feb 30): the parsed date must print back as the input. */
function calendarDateMs(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

/**
 * POST /api/staff/me/time-off
 * Staff submits a time-off request.
 */
staffMeRouter.post("/time-off", async (c) => {
  const user = getUser(c);
  if (user.role === "developer") {
    return c.json({ success: false, error: DEVELOPER_READ_ONLY }, 403);
  }
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);

  if (!staffId || !shopId) {
    return c.json({ success: false, error: "Staff record not found" }, 404);
  }

  const body = await c.req.json<{
    from_date?: string;
    to_date?: string;
    reason?: string;
  }>();

  if (!body.from_date || !body.to_date) {
    return c.json({ success: false, error: "from_date and to_date are required" }, 400);
  }

  // Validate ISO date format
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(body.from_date) || !dateRe.test(body.to_date)) {
    return c.json({ success: false, error: "Dates must be in YYYY-MM-DD format" }, 400);
  }

  if (body.from_date > body.to_date) {
    return c.json({ success: false, error: "from_date must be before or equal to to_date" }, 400);
  }

  const id = crypto.randomUUID();
  // Inclusive day count (a one-day request is 1); dates and reason stay out of the entry.
  // Only for real calendar dates: the format check above passes 2027-13-01
  // and 2027-02-30 (which Date.parse rolls over to March), so the count is
  // null unless both dates round-trip. The response is unchanged either way.
  const fromMs = calendarDateMs(body.from_date);
  const toMs = calendarDateMs(body.to_date);
  const days = fromMs !== null && toMs !== null ? Math.round((toMs - fromMs) / 86_400_000) + 1 : null;

  const refused = await batchWithAudit(
    c,
    [
      c.env.DB
        .prepare(
          `INSERT INTO staff_time_off (id, shop_id, staff_id, from_date, to_date, reason)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(id, shopId, staffId, body.from_date, body.to_date, body.reason ?? null),
    ],
    {
      action: "staff.time_off.request",
      outcome: "succeeded",
      shopId,
      entityType: "staff_time_off",
      entityId: id,
      details: { days },
    },
  );
  if (refused) return refused;

  return c.json({ success: true, data: { id } }, 201);
});

/**
 * GET /api/staff/me/time-off
 * Staff views their own time-off requests.
 */
staffMeRouter.get("/time-off", async (c) => {
  const viewed = await resolveViewedStaff(c);
  if (!viewed) {
    return c.json({ success: true, data: [] });
  }
  const { staffId } = viewed;

  const { results } = await c.env.DB
    .prepare(
      `SELECT id, from_date, to_date, reason, status, created_at
       FROM staff_time_off
       WHERE staff_id = ?
       ORDER BY from_date DESC`
    )
    .bind(staffId)
    .all<{
      id: string;
      from_date: string;
      to_date: string;
      reason: string | null;
      status: string;
      created_at: string;
    }>();

  return c.json({ success: true, data: results });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/me/*  — Customer's own data
// ─────────────────────────────────────────────────────────────────────────────

export const meRouter = new Hono<{ Bindings: Bindings }>();
meRouter.use("*", authMiddleware);

/**
 * GET /api/me/bookings
 * All bookings for the authenticated customer, identified by their user_id from JWT.
 * Returns upcoming (ASC) and past (DESC), joined with shop + service + staff names.
 * GDPR: returns only this user's bookings — identified by customer_email matched
 * to their platform_users.email (since public booking doesn't require account).
 */
meRouter.get("/bookings", async (c) => {
  const user = getUser(c);

  // Get user email from DB (customer may have booked without an account, matched by email)
  const userRow = await c.env.DB
    .prepare("SELECT email, email_verified FROM platform_users WHERE id = ? LIMIT 1")
    .bind(user.sub)
    .first<{ email: string; email_verified: number }>();

  if (!userRow) {
    return c.json({ success: true, data: { upcoming: [], past: [] } });
  }

  // SEC-3: bookings are matched purely on customer_email, so an unproven
  // address must not unlock them — registering with someone else's email
  // would disclose their booking history.
  if (userRow.email_verified !== 1) {
    return c.json(
      {
        success: false,
        error: "Please verify your email address to view your bookings.",
        code: "email_unverified",
      },
      403
    );
  }

  // A customer's list spans shops, so it splits on the platform's day: every
  // shop is on London time (shops.timezone is never written; src/lib/shopTime.ts).
  const today = shopToday(PLATFORM_TIME_ZONE);

  const [upcoming, past] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
                b.amount_pence, b.customer_name,
                sv.name AS service_name, sv.duration_min,
                st.display_name AS staff_name,
                sh.name AS shop_name, sh.slug AS shop_slug
         FROM bookings b
         JOIN services sv ON sv.id = b.service_id
         JOIN staff st ON st.id = b.staff_id
         JOIN shops sh ON sh.id = b.shop_id
         WHERE b.customer_email = ? AND b.booking_date >= ?
           AND b.status NOT IN ('cancelled', 'no_show')
         ORDER BY b.booking_date ASC, b.start_time ASC
         LIMIT 20`
      )
      .bind(userRow.email, today)
      .all<{
        id: string;
        booking_date: string;
        start_time: string;
        end_time: string;
        status: string;
        notes: string | null;
        amount_pence: number;
        customer_name: string;
        service_name: string;
        duration_min: number;
        staff_name: string;
        shop_name: string;
        shop_slug: string;
      }>(),

    c.env.DB
      .prepare(
        `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status,
                b.amount_pence, b.customer_name,
                sv.name AS service_name,
                st.display_name AS staff_name,
                sh.name AS shop_name, sh.slug AS shop_slug
         FROM bookings b
         JOIN services sv ON sv.id = b.service_id
         JOIN staff st ON st.id = b.staff_id
         JOIN shops sh ON sh.id = b.shop_id
         WHERE b.customer_email = ? AND b.booking_date < ?
         ORDER BY b.booking_date DESC, b.start_time DESC
         LIMIT 20`
      )
      .bind(userRow.email, today)
      .all<{
        id: string;
        booking_date: string;
        start_time: string;
        end_time: string;
        status: string;
        amount_pence: number;
        customer_name: string;
        service_name: string;
        staff_name: string;
        shop_name: string;
        shop_slug: string;
      }>(),
  ]);

  return c.json({
    success: true,
    data: {
      upcoming: upcoming.results,
      past: past.results,
    },
  });
});

const CANCEL_MIN_MS = 2 * 60 * 60 * 1000;

function emailsMatch(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * POST /api/me/bookings/:bookingId/cancel
 * Customer cancels own booking if it starts more than 2 hours from now.
 */
meRouter.post("/bookings/:bookingId/cancel", async (c) => {
  const user = getUser(c);
  const bookingId = c.req.param("bookingId")!;

  const userRow = await c.env.DB
    .prepare("SELECT email, email_verified FROM platform_users WHERE id = ? LIMIT 1")
    .bind(user.sub)
    .first<{ email: string; email_verified: number }>();
  if (!userRow) {
    return c.json({ success: false, error: "Account not found" }, 404);
  }

  // SEC-3: same email-claim rule as GET /bookings — an unverified address
  // must not be able to cancel someone else's appointments.
  if (userRow.email_verified !== 1) {
    return c.json(
      {
        success: false,
        error: "Please verify your email address to manage your bookings.",
        code: "email_unverified",
      },
      403
    );
  }

  const booking = await getBookingById(c.env.DB, bookingId);
  if (!booking) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }

  if (!emailsMatch(booking.customer_email, userRow.email)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  if (booking.status === "cancelled" || booking.status === "no_show") {
    return c.json({ success: false, error: "This booking is already closed" }, 400);
  }

  const startMs = new Date(booking.start_time).getTime();
  if (Number.isNaN(startMs)) {
    return c.json({ success: false, error: "Invalid booking time" }, 400);
  }

  if (startMs - Date.now() < CANCEL_MIN_MS) {
    return c.json(
      {
        success: false,
        error: "Bookings within 2 hours of the start time cannot be cancelled online.",
        code: "inside_cancel_window",
      },
      400
    );
  }

  // Pattern G: the atomic UPDATE is the only gate, so a racing second cancel
  // that reaches it records `refused` (its 409); the pre-checks above change
  // nothing and record nothing.
  let res: Response;
  try {
    res = await auditFor(c).run(
      { action: "booking.cancel", shopId: booking.shop_id, entityType: "booking", entityId: bookingId },
      async (): Promise<Response> => {
        const atomicResult = await c.env.DB
          .prepare(
            "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'confirmed')"
          )
          .bind(bookingId)
          .run();

        if (!atomicResult.success || atomicResult.meta?.changes === 0) {
          return c.json(
            {
              success: false,
              error:
                "This booking was modified by another request and could not be cancelled. Please refresh and try again.",
            },
            409
          );
        }
        return c.json({ success: true });
      },
      statusOutcome((r) =>
        r.status < 400
          ? { changes: fieldChanges(booking as unknown as Record<string, unknown>, { status: "cancelled" }).changes }
          : {}
      ),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
  if (res.status >= 400) return res;

  // The freed slot may match waiting waitlist entries. Non-fatal: the
  // cancellation stands even if the notification emails fail. Each email is
  // recorded with this customer as the actor.
  if (c.env.RESEND_API_KEY) {
    try {
      const shop = await getShopById(c.env.DB, booking.shop_id);
      if (shop) {
        await notifyWaitlistForOpenedSlot(
          c.env.DB,
          c.env.RESEND_API_KEY,
          shop,
          { bookingDate: booking.booking_date, staffId: booking.staff_id },
          auditFor(c),
        );
      }
    } catch (err) {
      reportError("me.cancel_waitlist_notify", err, { bookingId });
    }
  }

  return res;
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/shops/:shopId/setup-status  — Setup gate checks for admin dashboard
// ─────────────────────────────────────────────────────────────────────────────

export const shopSetupStatusRouter = new Hono<{ Bindings: Bindings }>();
shopSetupStatusRouter.use("*", authMiddleware);

/**
 * GET /api/shops/:shopId/setup-status
 * Returns the 4 setup gate checks needed before a shop can go live.
 * Developer can access any shop; admin restricted to their own.
 */
shopSetupStatusRouter.get("/", async (c) => {
  const user = getUser(c);
  const shopId = c.req.param("shopId")!;

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shopId)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const [staffRow, serviceRow, settingsRow, shopRow] = await Promise.all([
    c.env.DB
      .prepare("SELECT COUNT(*) AS total FROM staff WHERE shop_id = ? AND is_active = 1")
      .bind(shopId)
      .first<{ total: number }>(),

    c.env.DB
      .prepare("SELECT COUNT(*) AS total FROM services WHERE shop_id = ? AND is_active = 1")
      .bind(shopId)
      .first<{ total: number }>(),

    c.env.DB
      .prepare("SELECT address FROM shop_settings WHERE shop_id = ? LIMIT 1")
      .bind(shopId)
      .first<{ address: string | null }>(),

    c.env.DB
      .prepare("SELECT stripe_payment_status, status FROM shops WHERE id = ? LIMIT 1")
      .bind(shopId)
      .first<{ stripe_payment_status: string | null; status: string }>(),
  ]);

  const staffOk    = (staffRow?.total ?? 0) > 0;
  const servicesOk = (serviceRow?.total ?? 0) > 0;
  const addressOk  = !!(settingsRow?.address?.trim());
  const stripeOk   = shopRow?.stripe_payment_status === "paid";
  const allDone    = staffOk && servicesOk && addressOk && stripeOk;

  return c.json({
    success: true,
    data: {
      staff:    { done: staffOk,    count: staffRow?.total ?? 0 },
      services: { done: servicesOk, count: serviceRow?.total ?? 0 },
      address:  { done: addressOk },
      stripe:   { done: stripeOk,   status: shopRow?.stripe_payment_status ?? "unpaid" },
      all_done: allDone,
      shop_status: shopRow?.status ?? "pending",
    },
  });
});

// ─── PATCH /api/me/profile — customer: update own name and phone ──────────────

meRouter.patch("/profile", async (c) => {
  const user = getUser(c);

  const body = await c.req
    .json<{ name?: string; phone?: string }>()
    .catch((): { name?: string; phone?: string } => ({}));

  const name  = typeof body.name  === "string" ? body.name.trim()  : undefined;
  const phone = typeof body.phone === "string" ? body.phone.trim() : undefined;

  if (name === undefined && phone === undefined) {
    return c.json({ success: false, error: "No fields to update" }, 400);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (name  !== undefined) { sets.push("name = ?");  vals.push(name  || null); }
  if (phone !== undefined) { sets.push("phone = ?"); vals.push(phone || null); }
  vals.push(user.sub);

  // Only the columns this handler writes, with the values it writes, so a
  // stray body key never shows and "" over a stored null is no change. Both
  // are personal: the entry names the changed fields, never their values.
  const before = await c.env.DB
    .prepare("SELECT name, phone FROM platform_users WHERE id = ? LIMIT 1")
    .bind(user.sub)
    .first<{ name: string | null; phone: string | null }>();
  const { fields } = fieldChanges(before, {
    name: name === undefined ? undefined : name || null,
    phone: phone === undefined ? undefined : phone || null,
  });

  const refused = await batchWithAudit(
    c,
    [c.env.DB.prepare(`UPDATE platform_users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals)],
    {
      action: "account.update",
      outcome: "succeeded",
      entityType: "platform_user",
      entityId: user.sub,
      details: fields.length > 0 ? { fields } : null,
    },
  );
  if (refused) return refused;

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/shops/:shopId/analytics  — Admin analytics dashboard
// ─────────────────────────────────────────────────────────────────────────────

export const shopAnalyticsRouter = new Hono<{ Bindings: Bindings }>();
shopAnalyticsRouter.use("*", authMiddleware);

/**
 * GET /api/shops/:shopId/analytics
 * Returns booking trends, peak hours, peak days, status breakdown,
 * and top services/staff for the last 12 months.
 */
shopAnalyticsRouter.get("/", async (c) => {
  const user = getUser(c);
  const shopId = c.req.param("shopId")!;

  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shopId)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  // The last 12 months of the shop's calendar, ending on its today: the same
  // months the website's chart draws (London time).
  const timeZone = await getShopTimezone(c.env.DB, shopId);
  const toDate = shopToday(timeZone);
  const fromDate = shopMonthStart(11, timeZone);

  const [
    monthlyRows,
    peakHourRows,
    peakDayRows,
    statusRows,
    topServiceRows,
    topStaffRows,
    totalsRow,
  ] = await Promise.all([

    // Monthly booking + revenue trend (last 12 months)
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m', booking_date) AS month,
              COUNT(*) AS booking_count,
              COALESCE(SUM(amount_pence), 0) AS gross_pence
       FROM bookings
       WHERE shop_id = ? AND booking_date >= ? AND booking_date <= ?
         AND status = 'completed'
       GROUP BY month
       ORDER BY month ASC`
    ).bind(shopId, fromDate, toDate).all<{ month: string; booking_count: number; gross_pence: number }>(),

    // Peak hours (0-23) of the shop's day, all time. Counted per UTC date and
    // hour (or a walk-in's own clock hour) here, then moved to the shop's
    // clock by peakHoursInShopTime: SQLite has no time zones.
    c.env.DB.prepare(
      `SELECT ${START_HOUR_BUCKET_SQL} AS bucket,
              COUNT(*) AS booking_count
       FROM bookings
       WHERE shop_id = ? AND status NOT IN ('cancelled','no_show')
       GROUP BY bucket`
    ).bind(shopId).all<{ bucket: string | null; booking_count: number }>(),

    // Peak days of week (0=Sun,1=Mon…6=Sat) — all time
    c.env.DB.prepare(
      `SELECT CAST(strftime('%w', booking_date) AS INTEGER) AS dow,
              COUNT(*) AS booking_count
       FROM bookings
       WHERE shop_id = ? AND status NOT IN ('cancelled','no_show')
       GROUP BY dow
       ORDER BY dow ASC`
    ).bind(shopId).all<{ dow: number; booking_count: number }>(),

    // Status breakdown (last 12 months)
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS count
       FROM bookings
       WHERE shop_id = ? AND booking_date >= ?
       GROUP BY status`
    ).bind(shopId, fromDate).all<{ status: string; count: number }>(),

    // Top 5 services by booking count (last 12 months)
    c.env.DB.prepare(
      `SELECT sv.name AS service_name,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(b.amount_pence), 0) AS gross_pence
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       WHERE b.shop_id = ? AND b.booking_date >= ? AND b.status = 'completed'
       GROUP BY b.service_id
       ORDER BY booking_count DESC
       LIMIT 5`
    ).bind(shopId, fromDate).all<{ service_name: string; booking_count: number; gross_pence: number }>(),

    // Top staff by booking count (last 12 months)
    c.env.DB.prepare(
      `SELECT st.display_name,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(b.amount_pence), 0) AS gross_pence
       FROM bookings b
       JOIN staff st ON st.id = b.staff_id
       WHERE b.shop_id = ? AND b.booking_date >= ? AND b.status = 'completed'
       GROUP BY b.staff_id
       ORDER BY booking_count DESC
       LIMIT 5`
    ).bind(shopId, fromDate).all<{ display_name: string; booking_count: number; gross_pence: number }>(),

    // All-time totals
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total_bookings,
              COALESCE(SUM(CASE WHEN status='completed' THEN amount_pence ELSE 0 END), 0) AS total_revenue_pence,
              COALESCE(SUM(CASE WHEN status='completed' THEN commission_pence ELSE 0 END), 0) AS total_commission_pence,
              COUNT(DISTINCT customer_email) AS unique_customers
       FROM bookings WHERE shop_id = ?`
    ).bind(shopId).first<{
      total_bookings: number;
      total_revenue_pence: number;
      total_commission_pence: number;
      unique_customers: number;
    }>(),
  ]);

  return c.json({
    success: true,
    data: {
      period: { from: fromDate, to: toDate },
      totals: totalsRow,
      monthly: monthlyRows.results ?? [],
      peak_hours: peakHoursInShopTime(peakHourRows.results ?? [], timeZone),
      peak_days: peakDayRows.results ?? [],
      status_breakdown: statusRows.results ?? [],
      top_services: topServiceRows.results ?? [],
      top_staff: topStaffRows.results ?? [],
    },
  });
});
