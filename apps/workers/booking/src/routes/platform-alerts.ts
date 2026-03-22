import { Hono } from "hono";
import type { Env } from "../types.js";
import { d1Rows } from "../lib/d1-helpers.js";

const r = new Hono<{ Bindings: Env }>();

r.get("/alerts", async (c) => {
  const severity = c.req.query("severity");
  const shopId = c.req.query("shop_id");
  const parts = ["SELECT * FROM bw_platform_alerts WHERE resolved = 0"];
  const binds: string[] = [];
  if (severity) {
    if (!["critical", "warning", "info"].includes(severity)) {
      return c.json({ success: false, error: "Invalid severity" }, 400);
    }
    parts.push("AND severity = ?");
    binds.push(severity);
  }
  if (shopId) {
    parts.push("AND shop_id = ?");
    binds.push(shopId);
  }
  parts.push("ORDER BY created_at DESC");
  const sql = parts.join(" ");
  const stmt = c.env.DB.prepare(sql);
  const res = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
  return c.json({ success: true, alerts: d1Rows<Record<string, unknown>>(res) });
});

r.post("/alerts/:alertId/resolve", async (c) => {
  const alertId = c.req.param("alertId");
  const existing = await c.env.DB
    .prepare("SELECT id FROM bw_platform_alerts WHERE id = ? AND resolved = 0 LIMIT 1")
    .bind(alertId)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Alert not found or already resolved" }, 404);
  }
  const now = new Date().toISOString();
  await c.env.DB
    .prepare("UPDATE bw_platform_alerts SET resolved = 1, resolved_at = ? WHERE id = ?")
    .bind(now, alertId)
    .run();
  return c.json({ success: true, alertId, resolvedAt: now });
});

export default r;
