import { Hono } from "hono";
import type { Env } from "../types.js";
import { shopExists } from "../middleware/shop-access.js";
import { generateSlotTimes, todayUtcYmd } from "../lib/time.js";
import { d1Rows } from "../lib/d1-helpers.js";

const r = new Hono<{ Bindings: Env }>();

r.post("/:shopId/open", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const setup = await db
    .prepare("SELECT setup_completed FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ setup_completed: number | null }>();
  if (Number(setup?.setup_completed ?? 0) !== 1) {
    return c.json({ success: false, error: "Setup not complete" }, 400);
  }

  const date = todayUtcYmd();
  const existing = await db
    .prepare("SELECT id FROM bw_business_days WHERE shop_id = ? AND date = ? AND status = 'open' LIMIT 1")
    .bind(shopId, date)
    .first<{ id: string }>();
  if (existing?.id) {
    return c.json({ success: false, error: "Shop already open for today" }, 400);
  }

  const businessDayId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO bw_business_days (id, shop_id, date, status, opened_at) VALUES (?, ?, ?, 'open', ?)`
    )
    .bind(businessDayId, shopId, date, now)
    .run();

  // schedules.day_of_week is Monday-first (0=Mon..6=Sun, written by the admin
  // editor); getUTCDay() is Sunday-first, so convert or the wrong day is read.
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const schedRes = await db
    .prepare(
      "SELECT staff_id, start_time, end_time FROM schedules WHERE shop_id = ? AND day_of_week = ? AND is_active = 1"
    )
    .bind(shopId, dow)
    .all();
  const schedules = d1Rows<{ staff_id: string; start_time: string; end_time: string }>(schedRes);

  for (const row of schedules) {
    const slots = generateSlotTimes(row.start_time, row.end_time, 30);
    for (const slotTime of slots) {
      const id = crypto.randomUUID();
      await db
        .prepare(
          `INSERT OR IGNORE INTO bw_availability (id, shop_id, staff_id, slot_date, slot_time, is_booked, booking_id)
           VALUES (?, ?, ?, ?, ?, 0, NULL)`
        )
        .bind(id, shopId, row.staff_id, date, slotTime)
        .run();
    }
  }

  const slotCount = await db
    .prepare("SELECT COUNT(*) AS n FROM bw_availability WHERE shop_id = ? AND slot_date = ?")
    .bind(shopId, date)
    .first<{ n: number }>();
  const slotsGenerated = Number(slotCount?.n ?? 0);

  await db.prepare("UPDATE shops SET operational_status = 'open' WHERE id = ?").bind(shopId).run();

  return c.json({ success: true, businessDayId, slotsGenerated, date });
});

r.post("/:shopId/close", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const date = todayUtcYmd();
  const bd = await db
    .prepare("SELECT * FROM bw_business_days WHERE shop_id = ? AND date = ? AND status = 'open' LIMIT 1")
    .bind(shopId, date)
    .first<Record<string, unknown>>();
  if (!bd?.id) {
    return c.json({ success: false, error: "No open business day for today" }, 400);
  }
  const businessDayId = String(bd.id);

  await db
    .prepare(
      `UPDATE bookings SET status = 'no_show'
       WHERE shop_id = ? AND booking_date = ? AND status = 'confirmed'
         AND id NOT IN (SELECT booking_id FROM bw_booking_state WHERE checked_in_at IS NOT NULL)`
    )
    .bind(shopId, date)
    .run();

  await db
    .prepare(
      `UPDATE bw_booking_state SET workflow_flag = 'flagged', updated_at = ?
       WHERE shop_id = ? AND checked_in_at IS NOT NULL
         AND booking_id IN (
           SELECT id FROM bookings WHERE shop_id = ? AND booking_date = ? AND status = 'confirmed'
         )`
    )
    .bind(new Date().toISOString(), shopId, shopId, date)
    .run();

  await db
    .prepare("DELETE FROM bw_availability WHERE shop_id = ? AND slot_date = ?")
    .bind(shopId, date)
    .run();

  const completedBookings = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ? AND booking_date = ? AND status = 'completed'"
    )
    .bind(shopId, date)
    .first<{ n: number }>();

  const walkInCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings b
       INNER JOIN bw_booking_state s ON s.booking_id = b.id
       WHERE b.shop_id = ? AND b.booking_date = ? AND b.status = 'completed' AND s.booking_type = 'walk_in'`
    )
    .bind(shopId, date)
    .first<{ n: number }>();

  const noShowCount = await db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ? AND booking_date = ? AND status = 'no_show'")
    .bind(shopId, date)
    .first<{ n: number }>();

  const cancellationCount = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE shop_id = ? AND booking_date = ? AND status = 'cancelled'"
    )
    .bind(shopId, date)
    .first<{ n: number }>();

  const revSvc = await db
    .prepare(
      `SELECT COALESCE(SUM(bi.total_price), 0) AS s FROM bw_booking_items bi
       INNER JOIN bookings b ON b.id = bi.booking_id
       WHERE bi.shop_id = ? AND bi.item_type = 'service' AND b.booking_date = ?`
    )
    .bind(shopId, date)
    .first<{ s: number }>();

  const revProd = await db
    .prepare(
      `SELECT COALESCE(SUM(bi.total_price), 0) AS s FROM bw_booking_items bi
       INNER JOIN bookings b ON b.id = bi.booking_id
       WHERE bi.shop_id = ? AND bi.item_type = 'product' AND b.booking_date = ?`
    )
    .bind(shopId, date)
    .first<{ s: number }>();

  const revTips = await db
    .prepare(
      `SELECT COALESCE(SUM(bi.total_price), 0) AS s FROM bw_booking_items bi
       INNER JOIN bookings b ON b.id = bi.booking_id
       WHERE bi.shop_id = ? AND bi.item_type = 'tip' AND b.booking_date = ?`
    )
    .bind(shopId, date)
    .first<{ s: number }>();

  const servicesRevenue = Number(revSvc?.s ?? 0);
  const productsRevenue = Number(revProd?.s ?? 0);
  const tipsCollected = Number(revTips?.s ?? 0);
  const totalRevenue = servicesRevenue + productsRevenue + tipsCollected;

  const commissionTotal = await db
    .prepare(
      "SELECT COALESCE(SUM(commission_amount), 0) AS s FROM bw_commission_ledger WHERE business_day_id = ?"
    )
    .bind(businessDayId)
    .first<{ s: number }>();

  const staffRows = await db
    .prepare(
      `SELECT b.staff_id, st.display_name AS staff_name, COUNT(*) AS cnt, COALESCE(SUM(b.amount), 0) AS revenue
       FROM bookings b
       INNER JOIN staff st ON st.id = b.staff_id
       WHERE b.shop_id = ? AND b.booking_date = ? AND b.status = 'completed'
       GROUP BY b.staff_id`
    )
    .bind(shopId, date)
    .all();
  const staffBreakdown = d1Rows<{ staff_id: string; staff_name: string; cnt: number; revenue: number }>(staffRows);

  const topSvc = await db
    .prepare(
      `SELECT b.service_id, s.name AS service_name, COUNT(*) AS cnt
       FROM bookings b
       INNER JOIN services s ON s.id = b.service_id
       WHERE b.shop_id = ? AND b.booking_date = ? AND b.status = 'completed'
       GROUP BY b.service_id
       ORDER BY cnt DESC
       LIMIT 1`
    )
    .bind(shopId, date)
    .first<{ service_id: string; service_name: string; cnt: number }>();

  const prev = await db
    .prepare(
      "SELECT summary_json FROM bw_business_days WHERE shop_id = ? AND date < ? AND summary_json IS NOT NULL ORDER BY date DESC LIMIT 1"
    )
    .bind(shopId, date)
    .first<{ summary_json: string }>();

  let prevSummary: { totalRevenue?: number; noShowCount?: number } = {};
  try {
    if (prev?.summary_json) prevSummary = JSON.parse(prev.summary_json) as typeof prevSummary;
  } catch {
    /* ignore */
  }

  const signals: Array<{ type: string; metric: string; message: string; recommendation: string }> = [];
  const prevRev = Number(prevSummary.totalRevenue ?? 0);
  if (prevRev > 0 && totalRevenue > prevRev * 1.1) {
    signals.push({
      type: "improved",
      metric: "revenue",
      message: "Revenue up more than 10% vs yesterday",
      recommendation: "Keep momentum with same promotions.",
    });
  }
  const totalBookingsToday =
    Number(completedBookings?.n ?? 0) + Number(noShowCount?.n ?? 0) + Number(cancellationCount?.n ?? 0) || 1;
  const noShowRate = Number(noShowCount?.n ?? 0) / totalBookingsToday;
  if (noShowRate > 0.15) {
    signals.push({
      type: "warning",
      metric: "no_show_rate",
      message: `No-show rate ${(noShowRate * 100).toFixed(1)}%`,
      recommendation: "Consider enabling deposits",
    });
  }
  if (prevSummary.noShowCount !== undefined && Number(noShowCount?.n ?? 0) > Number(prevSummary.noShowCount)) {
    signals.push({
      type: "warning",
      metric: "no_shows",
      message: "No-shows increased vs yesterday",
      recommendation: "Review reminders and deposit policy.",
    });
  }
  if (prevRev > 0 && totalRevenue < prevRev * 0.8) {
    signals.push({
      type: "action",
      metric: "revenue",
      message: "Revenue down more than 20% vs yesterday",
      recommendation: "Run a targeted promo or extend hours.",
    });
  }

  for (const row of staffBreakdown) {
    const util = row.cnt / Math.max(1, Number(completedBookings?.n ?? 1));
    if (util < 0.5 && Number(completedBookings?.n ?? 0) >= 4) {
      signals.push({
        type: "warning",
        metric: "staff_utilisation",
        message: `Low utilisation for ${row.staff_name}`,
        recommendation: "Rebalance walk-in routing or adjust schedule.",
      });
    }
  }

  const eodSummary = {
    completedBookings: Number(completedBookings?.n ?? 0),
    walkInCount: Number(walkInCount?.n ?? 0),
    noShowCount: Number(noShowCount?.n ?? 0),
    cancellationCount: Number(cancellationCount?.n ?? 0),
    servicesRevenue,
    productsRevenue,
    tipsCollected,
    totalRevenue,
    commissionTotal: Number(commissionTotal?.s ?? 0),
    staffBreakdown,
    topService: topSvc ?? null,
  };

  const closedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE bw_business_days SET status = 'closed', closed_at = ?, summary_json = ?, performance_json = ? WHERE id = ?`
    )
    .bind(closedAt, JSON.stringify(eodSummary), JSON.stringify(signals), businessDayId)
    .run();

  await db.prepare("UPDATE shops SET operational_status = 'closed' WHERE id = ?").bind(shopId).run();

  const shopNameRow = await db.prepare("SELECT name FROM shops WHERE id = ?").bind(shopId).first<{ name: string }>();
  const shopName = shopNameRow?.name ?? "Shop";
  const alertId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO bw_platform_alerts (id, type, severity, title, message, shop_id, resolved, created_at)
       VALUES (?, 'eod_commission', 'info', 'Commission processed', ?, ?, 0, ?)`
    )
    .bind(
      alertId,
      `Commission processed for ${Number(completedBookings?.n ?? 0)} completed service bookings today from ${shopName}`,
      shopId,
      closedAt
    )
    .run();

  return c.json({ success: true, summary: eodSummary, signals, businessDayId });
});

export default r;
