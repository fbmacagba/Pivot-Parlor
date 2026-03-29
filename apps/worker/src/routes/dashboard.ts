// ─── Worker route: /api/dev/* and /api/me/* and /api/staff/me/* ──────────────
// Adds the missing dashboard endpoints identified in DASHBOARD_SPEC.md

import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getBookingsByShop,
  getPlatformRevenueByMonth,
  getRevenueByShop,
  getStaffByShop,
  getWaitlistByShop,
} from "../db/queries.js";

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
                COALESCE(SUM(commission), 0) AS commission_total
         FROM bookings
         WHERE booking_date >= ? AND booking_date <= ?
           AND status = 'completed'`
      )
      .bind(
        `${year}-${String(month).padStart(2, "0")}-01`,
        `${year}-${String(month).padStart(2, "0")}-31`
      )
      .first<{ bookings_count: number; commission_total: number }>(),
    c.env.DB
      .prepare("SELECT COUNT(*) AS total FROM contacts WHERE onboarded_at IS NULL")
      .first<{ total: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      total_shops: shopRow?.total ?? 0,
      bookings_this_month: bookingRow?.bookings_count ?? 0,
      platform_commission: bookingRow?.commission_total ?? 0,
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
      acc.total_gross += r.gross;
      acc.total_commission += r.commission;
      return acc;
    },
    { total_bookings: 0, total_gross: 0, total_commission: 0 }
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
  const today = dateParam ?? new Date().toISOString().slice(0, 10);

  const [todayRow, activeStaffRow, waitlistRow] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT COUNT(*) AS bookings_count,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS revenue
         FROM bookings
         WHERE shop_id = ? AND booking_date = ?`
      )
      .bind(shopId, today)
      .first<{ bookings_count: number; revenue: number }>(),

    // "Active staff" = staff with at least one booking today OR a schedule entry for today's DOW
    c.env.DB
      .prepare(
        `SELECT COUNT(DISTINCT staff_id) AS active
         FROM bookings
         WHERE shop_id = ? AND booking_date = ?
           AND status NOT IN ('cancelled', 'no_show')`
      )
      .bind(shopId, today)
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
      todays_revenue: todayRow?.revenue ?? 0,
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
                COALESCE(SUM(b.amount), 0) AS gross,
                COALESCE(SUM(b.commission), 0) AS commission
         FROM staff st
         LEFT JOIN bookings b ON b.staff_id = st.id
           AND b.shop_id = ? AND b.booking_date >= ? AND b.booking_date <= ?
           AND b.status = 'completed'
         WHERE st.shop_id = ? AND st.is_active = 1
         GROUP BY st.id
         ORDER BY gross DESC`
      )
      .bind(shopId, from, to, shopId)
      .all<{
        staff_id: string;
        display_name: string;
        booking_count: number;
        gross: number;
        commission: number;
      }>(),

    // Per-service breakdown
    c.env.DB
      .prepare(
        `SELECT sv.id AS service_id, sv.name AS service_name,
                COUNT(b.id) AS booking_count,
                COALESCE(SUM(b.amount), 0) AS gross
         FROM services sv
         LEFT JOIN bookings b ON b.service_id = sv.id
           AND b.shop_id = ? AND b.booking_date >= ? AND b.booking_date <= ?
           AND b.status = 'completed'
         WHERE sv.shop_id = ? AND sv.is_active = 1
         GROUP BY sv.id
         ORDER BY gross DESC`
      )
      .bind(shopId, from, to, shopId)
      .all<{
        service_id: string;
        service_name: string;
        booking_count: number;
        gross: number;
      }>(),

    // Daily totals for chart (all days in month)
    c.env.DB
      .prepare(
        `SELECT booking_date,
                COUNT(*) AS booking_count,
                COALESCE(SUM(amount), 0) AS gross,
                COALESCE(SUM(commission), 0) AS commission
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
        gross: number;
        commission: number;
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
 * GET /api/staff/me/today
 * Today's bookings for the authenticated staff member.
 * Returns bookings with customer name (NOT email/phone in list — detail view only).
 */
staffMeRouter.get("/today", async (c) => {
  const user = getUser(c);
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);

  if (!staffId) {
    return c.json({ success: true, data: [] });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { results } = await c.env.DB
    .prepare(
      `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
              b.customer_name,
              sv.name AS service_name, sv.duration_min,
              sv.price AS amount
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
      amount: number;
    }>();

  return c.json({ success: true, data: results });
});

/**
 * GET /api/staff/me/bookings?filter=upcoming|past&limit=20&offset=0
 * Staff member's own booking list.
 * GDPR note: customer email/phone NOT returned in list — available only in detail endpoint.
 */
staffMeRouter.get("/bookings", async (c) => {
  const user = getUser(c);
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);

  if (!staffId) {
    return c.json({ success: true, data: [] });
  }

  const filter = c.req.query("filter") ?? "upcoming";
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const offset = Number(c.req.query("offset") ?? 0);
  const today = new Date().toISOString().slice(0, 10);

  const dateCond = filter === "past"
    ? `b.booking_date < '${today}'`
    : `b.booking_date >= '${today}'`;

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
    .bind(staffId, limit, offset)
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
  const user = getUser(c);
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);
  const bookingId = c.req.param("bookingId");

  if (!staffId) {
    return c.json({ success: false, error: "Staff record not found" }, 404);
  }

  const booking = await c.env.DB
    .prepare(
      `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
              b.customer_name, b.customer_email, b.customer_phone,
              sv.name AS service_name, sv.duration_min, sv.price AS amount
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
      amount: number;
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
    .prepare("SELECT id FROM bookings WHERE id = ? AND staff_id = ? LIMIT 1")
    .bind(bookingId, staffId)
    .first<{ id: string }>();

  if (!existing) {
    return c.json({ success: false, error: "Booking not found" }, 404);
  }

  await c.env.DB
    .prepare("UPDATE bookings SET status = ? WHERE id = ?")
    .bind(body.status, bookingId)
    .run();

  return c.json({ success: true });
});

/**
 * GET /api/staff/me/schedule
 * Staff member's own weekly schedule.
 */
staffMeRouter.get("/schedule", async (c) => {
  const user = getUser(c);
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);

  if (!staffId) {
    return c.json({ success: true, data: [] });
  }

  const { results } = await c.env.DB
    .prepare(
      "SELECT day_of_week, start_time, end_time, is_active FROM schedules WHERE staff_id = ? ORDER BY day_of_week"
    )
    .bind(staffId)
    .all<{ day_of_week: number; start_time: string; end_time: string; is_active: number }>();

  return c.json({ success: true, data: results });
});

/**
 * POST /api/staff/me/time-off
 * Staff submits a time-off request.
 */
staffMeRouter.post("/time-off", async (c) => {
  const user = getUser(c);
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

  await c.env.DB
    .prepare(
      `INSERT INTO staff_time_off (id, shop_id, staff_id, from_date, to_date, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, shopId, staffId, body.from_date, body.to_date, body.reason ?? null)
    .run();

  return c.json({ success: true, data: { id } }, 201);
});

/**
 * GET /api/staff/me/time-off
 * Staff views their own time-off requests.
 */
staffMeRouter.get("/time-off", async (c) => {
  const user = getUser(c);
  const shopId = user.shop_id;
  const staffId = await resolveMyStaffId(c.env.DB, user.sub, shopId);

  if (!staffId) {
    return c.json({ success: true, data: [] });
  }

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
    .prepare("SELECT email FROM platform_users WHERE id = ? LIMIT 1")
    .bind(user.sub)
    .first<{ email: string }>();

  if (!userRow) {
    return c.json({ success: true, data: { upcoming: [], past: [] } });
  }

  const today = new Date().toISOString().slice(0, 10);

  const [upcoming, past] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT b.id, b.booking_date, b.start_time, b.end_time, b.status, b.notes,
                b.amount, b.customer_name,
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
        amount: number;
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
                b.amount, b.customer_name,
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
        amount: number;
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

  const body = await c.req.json<{ name?: string; phone?: string }>().catch(() => ({}));

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

  await c.env.DB
    .prepare(`UPDATE platform_users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();

  return c.json({ success: true });
});
