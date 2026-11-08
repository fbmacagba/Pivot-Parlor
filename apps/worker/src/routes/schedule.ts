import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getScheduleByShop, getScheduleByStaff, upsertScheduleStmt, deactivateScheduleDayStmt,
  getStaffById,
} from "../db/queries.js";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { batchWithAudit } from "../audit/context.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";

const schedule = new Hono<{ Bindings: Bindings }>();

// Auth for all; reads are admin+staff, schedule edits are admin-only.
schedule.use("*", authMiddleware);

// ─── GET /api/shops/:shopId/schedule ─────────────────────────────────────────
// Returns all schedules for the shop, keyed by staffId

schedule.get("/", requireShopRole("admin", "staff"), async (c) => {
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

schedule.get("/:staffId", requireShopRole("admin", "staff"), async (c) => {
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

schedule.put("/", requireShopRole("admin"), async (c) => {
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

  // Read the existing (staff, day) rows first, then build every statement and
  // commit them with the audit entry in one batch.
  const existingIds = new Map<string, string>();
  const placeholders = staffIds.map(() => "?").join(", ");
  if (staffIds.length > 0) {
    const { results } = await c.env.DB
      .prepare(`SELECT id, staff_id, day_of_week FROM schedules WHERE staff_id IN (${placeholders}) ORDER BY rowid`)
      .bind(...staffIds)
      .all<{ id: string; staff_id: string; day_of_week: number }>();
    for (const r of results) {
      const key = `${r.staff_id}:${r.day_of_week}`;
      if (!existingIds.has(key)) existingIds.set(key, r.id);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  let upserts = 0;
  let daysOff = 0;
  for (const entry of body.entries) {
    if (!DAYS.includes(entry.day_of_week) || !entry.staff_id) continue;

    if (entry.off) {
      stmts.push(deactivateScheduleDayStmt(c.env.DB, entry.staff_id, entry.day_of_week));
      daysOff++;
      continue;
    }

    if (!entry.start_time || !entry.end_time) continue;

    // Reuse the existing row id, or create one (shared by a repeat of the same day).
    const key = `${entry.staff_id}:${entry.day_of_week}`;
    let id = existingIds.get(key);
    if (!id) {
      id = crypto.randomUUID();
      existingIds.set(key, id);
    }

    stmts.push(
      upsertScheduleStmt(c.env.DB, {
        id,
        shop_id: shopId,
        staff_id: entry.staff_id,
        day_of_week: entry.day_of_week,
        start_time: entry.start_time,
        end_time: entry.end_time,
      }),
    );
    upserts++;
  }

  const refused = await batchWithAudit(c, stmts, {
    action: "schedule.update",
    outcome: "succeeded",
    shopId,
    entityType: "schedule",
    entityId: shopId,
    details: { entries: upserts, staff_ids: [...staffIds].sort(), days_off: daysOff },
  });
  if (refused) return refused;

  const updated = await getScheduleByShop(c.env.DB, shopId);
  return c.json({ success: true, data: updated });
});

export default schedule;
