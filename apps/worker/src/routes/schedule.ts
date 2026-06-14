import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getScheduleByShop, getScheduleByStaff, upsertSchedule, deactivateScheduleDay,
  getStaffById,
} from "../db/queries.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShop } from "../middleware/rbac.js";

const schedule = new Hono<{ Bindings: Bindings }>();

schedule.use("*", authMiddleware, requireShop());

// ─── GET /api/shops/:shopId/schedule ─────────────────────────────────────────
// Returns all schedules for the shop, keyed by staffId

schedule.get("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const rows = await getScheduleByShop(c.env.DB, shopId);

  // Group by staff_id for convenient frontend use
  const grouped: Record<string, typeof rows> = {};
  for (const row of rows) {
    (grouped[row.staff_id] ??= []).push(row);
  }
  return c.json({ success: true, data: { schedules: rows, by_staff: grouped } });
});

// ─── GET /api/shops/:shopId/schedule/:staffId ─────────────────────────────────

schedule.get("/:staffId", async (c) => {
  const shopId = c.req.param("shopId")!;
  const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }
  const rows = await getScheduleByStaff(c.env.DB, staffId);
  return c.json({ success: true, data: rows });
});

// ─── PUT /api/shops/:shopId/schedule ─────────────────────────────────────────
// Body: { entries: Array<{ staff_id, day_of_week, start_time, end_time, off? }> }
// Upserts all provided entries; sets is_active=0 for entries with off=true

schedule.put("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await c.req.json<{
    entries?: Array<{
      staff_id: string;
      day_of_week: number;
      start_time: string;
      end_time: string;
      off?: boolean;
    }>;
  }>();

  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    return c.json({ success: false, error: "entries array is required" }, 400);
  }

  // Every staff_id in the payload must belong to the shop in the URL.
  const staffIds = [...new Set(body.entries.map((e) => e.staff_id).filter(Boolean))];
  for (const staffId of staffIds) {
    const member = await getStaffById(c.env.DB, staffId);
    if (!member || member.shop_id !== shopId) {
      return c.json({ success: false, error: "staff_id does not belong to this shop" }, 400);
    }
  }

  const DAYS = [0, 1, 2, 3, 4, 5, 6];

  await Promise.all(
    body.entries.map(async (entry) => {
      if (!DAYS.includes(entry.day_of_week) || !entry.staff_id) return;

      if (entry.off) {
        await deactivateScheduleDay(c.env.DB, entry.staff_id, entry.day_of_week);
        return;
      }

      if (!entry.start_time || !entry.end_time) return;

      // Check for existing row to reuse ID, or create new
      const existing = await c.env.DB
        .prepare("SELECT id FROM schedules WHERE staff_id = ? AND day_of_week = ? LIMIT 1")
        .bind(entry.staff_id, entry.day_of_week)
        .first<{ id: string }>();

      const id = existing?.id ?? crypto.randomUUID();

      await upsertSchedule(c.env.DB, {
        id,
        shop_id: shopId,
        staff_id: entry.staff_id,
        day_of_week: entry.day_of_week,
        start_time: entry.start_time,
        end_time: entry.end_time,
      });
    })
  );

  const updated = await getScheduleByShop(c.env.DB, shopId);
  return c.json({ success: true, data: updated });
});

export default schedule;
