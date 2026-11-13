// apps/worker/src/routes/walkin.ts
import { Hono } from "hono";
import { AuditWriteError } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { auditFor, auditRefused, batchWithAudit, statusOutcome } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { getShopById, getShopBySlug } from "../db/queries.js";
import { isPortfolioDemoShopRecord, PORTFOLIO_DEMO_ERROR, readJsonObject } from "@repo/utils";

const walkin = new Hono<{ Bindings: Bindings }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getNextPosition(db: D1Database, shopId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM walkin_queue WHERE shop_id = ? AND status = 'waiting'")
    .bind(shopId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

async function reorderQueue(db: D1Database, shopId: string): Promise<void> {
  const { results } = await db
    .prepare("SELECT id FROM walkin_queue WHERE shop_id = ? AND status = 'waiting' ORDER BY position ASC, created_at ASC")
    .bind(shopId)
    .all<{ id: string }>();
  if (!results?.length) return;
  await Promise.all(
    results.map((row, i) =>
      db.prepare("UPDATE walkin_queue SET position = ? WHERE id = ?").bind(i + 1, row.id).run()
    )
  );
}

// ─── PUBLIC: POST /api/walkin/:shopSlug/join ──────────────────────────────────

// 20/hour per IP: a whole party joining from shared shop Wi-Fi fits, a
// queue-flooding script does not.
walkin.post(
  "/:shopSlug/join",
  rateLimit({ name: "walkin-join", limit: 20, windowS: 3600, key: clientIp }),
  async (c) => {
  const slug = c.req.param("shopSlug");
  const shop = (await getShopBySlug(c.env.DB, slug)) ?? (await getShopById(c.env.DB, slug));
  if (!shop || !shop.is_active) return c.json({ success: false, error: "Shop not found" }, 404);
  if (isPortfolioDemoShopRecord(shop)) return c.json({ success: false, error: PORTFOLIO_DEMO_ERROR }, 403);

  const body: { name?: string; phone?: string; service?: string; notes?: string } =
    (await readJsonObject(c.req)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const service = typeof body.service === "string" ? body.service.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (!name) return c.json({ success: false, error: "Name is required" }, 400);
  if (name.length > 120) return c.json({ success: false, error: "Name is too long" }, 400);
  if (phone.length > 40) return c.json({ success: false, error: "Phone number is too long" }, 400);
  if (service.length > 120) return c.json({ success: false, error: "Service is too long" }, 400);
  if (notes.length > 500) return c.json({ success: false, error: "Notes are too long" }, 400);

  const position = await getNextPosition(c.env.DB, shop.id);
  const id = crypto.randomUUID();

  // Pattern B: the entry joins the insert's batch. Anonymous actor + IP;
  // name, phone, service and notes are personal or free text, so the entry
  // carries none of them.
  const refused = await batchWithAudit(
    c,
    [
      c.env.DB.prepare(
        `INSERT INTO walkin_queue (id, shop_id, name, phone, service, status, position, notes)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`
      ).bind(id, shop.id, name, phone || null, service || null, position, notes || null),
    ],
    {
      action: "walkin.join",
      outcome: "succeeded",
      shopId: shop.id,
      entityType: "walkin_entry",
      entityId: id,
      changes: fieldChanges(null, { status: "waiting" }).changes,
    },
  );
  if (refused) return refused;

  // Cache bust queue KV
  await c.env.KV.delete(`walkin:queue:${shop.id}`);

  return c.json({ success: true, data: { id, position, shop_name: shop.name } }, 201);
});

// ─── PUBLIC: GET /api/walkin/:shopSlug/status/:entryId ───────────────────────

walkin.get("/:shopSlug/status/:entryId", async (c) => {
  const slug = c.req.param("shopSlug");
  const entryId = c.req.param("entryId");
  const shop = (await getShopBySlug(c.env.DB, slug)) ?? (await getShopById(c.env.DB, slug));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const entry = await c.env.DB
    .prepare("SELECT id, name, position, status, created_at FROM walkin_queue WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(entryId, shop.id)
    .first<{ id: string; name: string; position: number; status: string; created_at: string }>();
  if (!entry) return c.json({ success: false, error: "Entry not found" }, 404);

  // Count people ahead
  const aheadRow = await c.env.DB
    .prepare("SELECT COUNT(*) AS ahead FROM walkin_queue WHERE shop_id = ? AND status = 'waiting' AND position < ?")
    .bind(shop.id, entry.position)
    .first<{ ahead: number }>();

  return c.json({
    success: true,
    data: {
      id: entry.id,
      name: entry.name,
      position: entry.position,
      status: entry.status,
      ahead: aheadRow?.ahead ?? 0,
      est_wait_minutes: (aheadRow?.ahead ?? 0) * 20, // rough 20min per person
    },
  });
});

// ─── PUBLIC: GET /api/walkin/:shopSlug/queue ─────────────────────────────────

walkin.get("/:shopSlug/queue", async (c) => {
  const slug = c.req.param("shopSlug");
  const shop = (await getShopBySlug(c.env.DB, slug)) ?? (await getShopById(c.env.DB, slug));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, service, position, status, created_at
       FROM walkin_queue WHERE shop_id = ? AND status IN ('waiting','serving')
       ORDER BY position ASC`
    )
    .bind(shop.id)
    .all<{ id: string; name: string; service: string | null; position: number; status: string; created_at: string }>();

  return c.json({ success: true, data: results ?? [] });
});

// ─── ADMIN: routes below require auth + shop scope ───────────────────────────

const adminWalkin = new Hono<{ Bindings: Bindings }>();
// Operational: admins and staff of the shop (developers bypass). Excludes customers.
adminWalkin.use("*", authMiddleware, requireShopRole("admin", "staff"));

// GET /api/shops/:shopId/walkin — full queue for admin
adminWalkin.get("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, phone, service, position, status, notes, created_at, updated_at
       FROM walkin_queue WHERE shop_id = ?
       AND status IN ('waiting','serving')
       ORDER BY position ASC`
    )
    .bind(shopId)
    .all<{
      id: string; name: string; phone: string | null; service: string | null;
      position: number; status: string; notes: string | null;
      created_at: string; updated_at: string;
    }>();

  return c.json({ success: true, data: results ?? [] });
});

// PATCH /api/shops/:shopId/walkin/:entryId — update status
adminWalkin.patch("/:entryId", async (c) => {
  const shopId = c.req.param("shopId")!;
  const entryId = c.req.param("entryId")!;

  const entry = await c.env.DB
    .prepare("SELECT id, status FROM walkin_queue WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(entryId, shopId)
    .first<{ id: string; status: string }>();
  if (!entry) return c.json({ success: false, error: "Entry not found" }, 404);

  const body: { status?: string } = (await readJsonObject(c.req)) ?? {};
  const valid = ["waiting", "serving", "served", "skipped", "removed"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }

  // Pattern B: the status UPDATE and its entry. Positions are a derived order
  // every PATCH recomputes, so the reorder and the KV bust stay post-steps.
  const refused = await batchWithAudit(
    c,
    [
      c.env.DB
        .prepare("UPDATE walkin_queue SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(body.status, entryId),
    ],
    {
      action: body.status === "skipped" || body.status === "removed" ? "walkin.remove" : "walkin.serve",
      outcome: "succeeded",
      shopId,
      entityType: "walkin_entry",
      entityId: entryId,
      changes: fieldChanges(entry, { status: body.status }).changes,
    },
  );
  if (refused) return refused;

  // Reorder remaining queue
  await reorderQueue(c.env.DB, shopId);
  await c.env.KV.delete(`walkin:queue:${shopId}`);

  return c.json({ success: true });
});

// DELETE /api/shops/:shopId/walkin — clear entire queue (EOD)
adminWalkin.delete("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  // Pattern G: how many entries were cleared is known only from meta.changes,
  // so the count rides on the outcome entry (no entity: it is the whole queue).
  // Developers bypass the shop check, so the entry records the param only
  // once it resolves to a shop (never a raw caller-supplied value).
  const resolvedShopId = (await getShopById(c.env.DB, shopId))?.id ?? null;
  let cleared = 0;
  try {
    return await auditFor(c).run(
      { action: "walkin.remove", shopId: resolvedShopId, entityType: "walkin_entry", entityId: null },
      async (): Promise<Response> => {
        const res = await c.env.DB
          .prepare("UPDATE walkin_queue SET status = 'removed', updated_at = datetime('now') WHERE shop_id = ? AND status IN ('waiting','serving')")
          .bind(shopId)
          .run();
        cleared = res.meta?.changes ?? 0;
        await c.env.KV.delete(`walkin:queue:${shopId}`);
        return c.json({ success: true });
      },
      statusOutcome(() => ({ details: { cleared } })),
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export { walkin as walkinRouter, adminWalkin as adminWalkinRouter };
