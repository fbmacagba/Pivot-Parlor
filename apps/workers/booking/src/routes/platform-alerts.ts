import { Hono } from "hono";
import type { Env } from "../types.js";
import { d1Rows } from "../lib/d1-helpers.js";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, statusOutcome } from "../audit/context.js";

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
    .prepare("SELECT id, shop_id FROM bw_platform_alerts WHERE id = ? LIMIT 1")
    .bind(alertId)
    .first<{ id: string; shop_id: string | null }>();
  if (!existing) {
    // Unknown id: the 404 stays outside run(), so it writes no entry and the
    // URL param never reaches an audit column.
    return c.json({ success: false, error: "Alert not found or already resolved" }, 404);
  }
  let changes: Record<string, [unknown, unknown]> | null = null;
  try {
    return await auditFor(c).run(
      {
        action: "platform.alert.resolve",
        shopId: existing.shop_id,
        entityType: "platform_alert",
        entityId: existing.id,
      },
      async (): Promise<Response> => {
        const now = new Date().toISOString();
        const res = await c.env.DB
          .prepare("UPDATE bw_platform_alerts SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0")
          .bind(now, existing.id)
          .run();
        if (Number(res.meta?.changes ?? 0) === 0) {
          // Already resolved (earlier, or by a concurrent request): same 404, refused.
          return c.json({ success: false, error: "Alert not found or already resolved" }, 404);
        }
        changes = { resolved: [0, 1] };
        return c.json({ success: true, alertId, resolvedAt: now });
      },
      statusOutcome(() => ({ changes }))
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default r;
