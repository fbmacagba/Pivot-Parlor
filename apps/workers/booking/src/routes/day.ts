import { Hono } from "hono";
import type { Env } from "../types.js";
import { shopExists } from "../middleware/shop-access.js";
import { generateSlotTimes, todayUtcYmd } from "../lib/time.js";
import { d1Rows } from "../lib/d1-helpers.js";
import { capturePaymentIntent } from "../lib/stripe.js";
import { reportError } from "../services/report-error.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, statusOutcome } from "../audit/context.js";

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

  let slotsGenerated = 0;
  const businessDayId = crypto.randomUUID();
  try {
    return await auditFor(c).run(
      { action: "day.open", shopId, entityType: "business_day", entityId: businessDayId },
      async (): Promise<Response> => {
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
        slotsGenerated = Number(slotCount?.n ?? 0);

        await db.prepare("UPDATE shops SET operational_status = 'open' WHERE id = ?").bind(shopId).run();

        return c.json({ success: true, businessDayId, slotsGenerated, date });
      },
      statusOutcome((res) =>
        res.status < 400
          ? { changes: { status: [null, "open"] }, details: { date, slots_generated: slotsGenerated } }
          : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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

  let holdsCaptured = 0;
  let holdsFailed = 0;
  let closeDetails: Record<string, number> | undefined;
  try {
    return await auditFor(c).run(
      { action: "day.close", shopId, entityType: "business_day", entityId: businessDayId },
      async (): Promise<Response> => {
        await db
          .prepare(
            `UPDATE bookings SET status = 'no_show'
             WHERE shop_id = ? AND booking_date = ? AND status = 'confirmed'
               AND id NOT IN (SELECT booking_id FROM bw_booking_state WHERE checked_in_at IS NOT NULL)`
          )
          .bind(shopId, date)
          .run();

        // WS-2: capture the deposit hold of every no-show (deposit forfeiture).
        // Manual-capture holds expire after ~7 days if never captured, which used
        // to mean no-shows cost the shop nothing. A hold the customer never
        // confirmed cannot be captured — reported and skipped, never fatal to close.
        const holdRows = await db
          .prepare(
            `SELECT b.id AS booking_id, s.stripe_payment_intent_id AS pi_id
             FROM bookings b
             INNER JOIN bw_booking_state s ON s.booking_id = b.id
             INNER JOIN bw_transactions t ON t.booking_id = b.id AND t.type = 'deposit' AND t.status = 'pending'
             WHERE b.shop_id = ? AND b.booking_date = ? AND b.status = 'no_show'
               AND s.stripe_payment_intent_id IS NOT NULL AND s.deposit_amount_pence > 0`
          )
          .bind(shopId, date)
          .all();
        for (const hold of d1Rows<{ booking_id: string; pi_id: string }>(holdRows)) {
          try {
            await capturePaymentIntent(c.env.STRIPE_SECRET_KEY, hold.pi_id, {
              idempotencyKey: `noshow:${hold.booking_id}`,
            });
            await db
              .prepare(
                "UPDATE bw_transactions SET type = 'no_show_capture', status = 'captured' WHERE booking_id = ? AND type = 'deposit' AND stripe_id = ?"
              )
              .bind(hold.booking_id, hold.pi_id)
              .run();
            holdsCaptured += 1;
          } catch (err) {
            holdsFailed += 1;
            reportError("day.close_noshow_capture", err, {
              shopId,
              bookingId: hold.booking_id,
              paymentIntentId: hold.pi_id,
            });
          }
        }

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

        // Revenue reads from the unified sales spine (WS-3): appointment checkouts
        // AND counter sales, voided ones excluded. Tips live on the sale header.
        const revSvc = await db
          .prepare(
            `SELECT COALESCE(SUM(si.line_total_pence), 0) AS s
             FROM sale_items si
             INNER JOIN sales sa ON sa.id = si.sale_id
             WHERE si.shop_id = ? AND si.item_type = 'service'
               AND substr(sa.created_at, 1, 10) = ? AND sa.status != 'voided'`
          )
          .bind(shopId, date)
          .first<{ s: number }>();

        const revProd = await db
          .prepare(
            `SELECT COALESCE(SUM(si.line_total_pence), 0) AS s
             FROM sale_items si
             INNER JOIN sales sa ON sa.id = si.sale_id
             WHERE si.shop_id = ? AND si.item_type = 'product'
               AND substr(sa.created_at, 1, 10) = ? AND sa.status != 'voided'`
          )
          .bind(shopId, date)
          .first<{ s: number }>();

        const revTips = await db
          .prepare(
            `SELECT COALESCE(SUM(tip_pence), 0) AS s FROM sales
             WHERE shop_id = ? AND substr(created_at, 1, 10) = ? AND status != 'voided'`
          )
          .bind(shopId, date)
          .first<{ s: number }>();

        const servicesRevenuePence = Number(revSvc?.s ?? 0);
        const productsRevenuePence = Number(revProd?.s ?? 0);
        const tipsCollectedPence = Number(revTips?.s ?? 0);
        const totalRevenuePence = servicesRevenuePence + productsRevenuePence + tipsCollectedPence;

        const commissionTotal = await db
          .prepare(
            "SELECT COALESCE(SUM(commission_amount_pence), 0) AS s FROM bw_commission_ledger WHERE business_day_id = ?"
          )
          .bind(businessDayId)
          .first<{ s: number }>();

        const staffRows = await db
          .prepare(
            `SELECT b.staff_id, st.display_name AS staff_name, COUNT(*) AS cnt, COALESCE(SUM(b.amount_pence), 0) AS revenue_pence
             FROM bookings b
             INNER JOIN staff st ON st.id = b.staff_id
             WHERE b.shop_id = ? AND b.booking_date = ? AND b.status = 'completed'
             GROUP BY b.staff_id`
          )
          .bind(shopId, date)
          .all();
        const staffBreakdown = d1Rows<{ staff_id: string; staff_name: string; cnt: number; revenue_pence: number }>(staffRows);

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

        let prevSummary: { totalRevenuePence?: number; totalRevenue?: number; noShowCount?: number } = {};
        try {
          if (prev?.summary_json) prevSummary = JSON.parse(prev.summary_json) as typeof prevSummary;
        } catch {
          /* ignore */
        }

        const signals: Array<{ type: string; metric: string; message: string; recommendation: string }> = [];
        // Summaries written before WS-4 stored pounds under totalRevenue.
        const prevRev =
          prevSummary.totalRevenuePence != null
            ? Number(prevSummary.totalRevenuePence)
            : Math.round(Number(prevSummary.totalRevenue ?? 0) * 100);
        if (prevRev > 0 && totalRevenuePence > prevRev * 1.1) {
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
        if (prevRev > 0 && totalRevenuePence < prevRev * 0.8) {
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
          servicesRevenuePence,
          productsRevenuePence,
          tipsCollectedPence,
          totalRevenuePence,
          commissionTotalPence: Number(commissionTotal?.s ?? 0),
          staffBreakdown,
          topService: topSvc ?? null,
        };
      closeDetails = {
        no_shows: eodSummary.noShowCount,
        completed: eodSummary.completedBookings,
        walk_ins: eodSummary.walkInCount,
        holds_captured: holdsCaptured,
        holds_failed: holdsFailed,
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
      },
      statusOutcome((res) =>
        res.status < 400 ? { changes: { status: ["open", "closed"] }, details: closeDetails } : {}
      )
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default r;
