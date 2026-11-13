import { Hono } from "hono";
import { AuditWriteError } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { auditFor, auditRefused, batchWithAudit } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import {
  getWaitlistByShop,
  createWaitlistEntryStmt,
  getShopById,
  getShopBySlug,
  getWaitlistEntryById,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { reportError } from "../services/report-error.js";
import { notifyWaitlistEntry, WaitlistSendError } from "../services/waitlist-claim.js";
import { isOptionalText, isPortfolioDemoShopRecord, PORTFOLIO_DEMO_ERROR, readJsonObject } from "@repo/utils";

const waitlist = new Hono<{ Bindings: Bindings }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── POST /api/waitlist — public (no auth required) ──────────────────────────

waitlist.post(
  "/",
  rateLimit({ name: "waitlist", limit: 10, windowS: 3600, key: clientIp }),
  async (c) => {
    // A body that is not a JSON object, or an id that is not text, is the
    // caller's mistake: a 400, never a 500 from D1 binding it.
    const body = await readJsonObject(c.req);
    if (!body) return c.json({ success: false, error: "Invalid JSON" }, 400);

    const name = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
    const email = typeof body.customer_email === "string" ? body.customer_email.trim() : "";
    const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : "";
    const preferredDate = typeof body.preferred_date === "string" ? body.preferred_date.trim() : "";

    const asId = (value: unknown): string => (typeof value === "string" ? value : "");
    const shopIdentifier = asId(body.shop_id) || asId(body.shop_slug);
    if (!shopIdentifier || !name || !email) {
      return c.json(
        { success: false, error: "shop_id (or shop_slug), customer_name and customer_email are required" },
        400
      );
    }
    const { service_id: serviceId, staff_id: staffId } = body;
    if (!isOptionalText(serviceId)) return c.json({ success: false, error: "service_id must be text" }, 400);
    if (!isOptionalText(staffId)) return c.json({ success: false, error: "staff_id must be text" }, 400);
    if (name.length > 120) return c.json({ success: false, error: "Name is too long" }, 400);
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return c.json({ success: false, error: "Invalid email address" }, 400);
    }
    if (phone.length > 40) return c.json({ success: false, error: "Phone number is too long" }, 400);
    if (preferredDate && !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
      return c.json({ success: false, error: "preferred_date must be YYYY-MM-DD" }, 400);
    }

    // The shop must exist and be live, and any service/staff must belong to it —
    // otherwise the public form can be used to write cross-tenant garbage.
    const shop =
      (await getShopBySlug(c.env.DB, shopIdentifier)) ?? (await getShopById(c.env.DB, shopIdentifier));
    if (!shop || !shop.is_active) {
      return c.json({ success: false, error: "Shop not found" }, 404);
    }
    if (isPortfolioDemoShopRecord(shop)) {
      return c.json({ success: false, error: PORTFOLIO_DEMO_ERROR }, 403);
    }
    if (serviceId) {
      const svc = await c.env.DB
        .prepare("SELECT id FROM services WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1")
        .bind(serviceId, shop.id)
        .first<{ id: string }>();
      if (!svc) return c.json({ success: false, error: "Invalid service" }, 400);
    }
    if (staffId) {
      const st = await c.env.DB
        .prepare("SELECT id FROM staff WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1")
        .bind(staffId, shop.id)
        .first<{ id: string }>();
      if (!st) return c.json({ success: false, error: "Invalid staff member" }, 400);
    }

    const id = crypto.randomUUID();
    // Pattern B: the entry joins the insert's batch. Anonymous actor + IP;
    // every submitted field is personal, so the entry carries none of them.
    const refused = await batchWithAudit(
      c,
      [
        createWaitlistEntryStmt(c.env.DB, {
          id,
          shop_id: shop.id,
          staff_id: staffId ?? null,
          service_id: serviceId ?? null,
          customer_name: name,
          customer_email: email,
          customer_phone: phone || null,
          preferred_date: preferredDate || null,
        }),
      ],
      {
        action: "waitlist.join",
        outcome: "succeeded",
        shopId: shop.id,
        entityType: "waitlist_entry",
        entityId: id,
        changes: fieldChanges(null, { status: "waiting" }).changes,
      },
    );
    if (refused) return refused;

    return c.json({ success: true, data: { id } }, 201);
  }
);

// ─── GET /api/waitlist?shop_id= — admin/staff of that shop, or developer ──────
//
// This route is mounted at /api/waitlist (no :shopId param), so shop scope is
// checked against the shop_id query directly — requireShopRole() would read a
// param that does not exist and fail closed for admins.

waitlist.get("/", authMiddleware, async (c) => {
  const user = getUser(c);
  const shopId = c.req.query("shop_id");
  if (!shopId) return c.json({ success: false, error: "shop_id is required" }, 400);

  const allowed =
    user.role === "developer" ||
    (["admin", "staff"].includes(user.role) && user.shop_id === shopId);
  if (!allowed) return c.json({ success: false, error: "Forbidden" }, 403);

  const entries = await getWaitlistByShop(c.env.DB, shopId);
  return c.json({ success: true, data: entries });
});

// ─── PATCH /api/waitlist/:id/status — admin/developer ────────────────────────

waitlist.patch("/:id/status", authMiddleware, async (c) => {
  const user = getUser(c);
  if (!user || !["developer", "admin", "staff"].includes(user.role)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }
  const { id } = c.req.param();
  const body = await c.req.json<{ status?: string }>();
  const valid = ["waiting", "notified", "booked", "expired"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }
  const entry = await c.env.DB
    .prepare("SELECT shop_id, status FROM waitlist WHERE id = ?")
    .bind(id)
    .first<{ shop_id: string; status: string }>();
  if (!entry || (user.role !== "developer" && user.shop_id !== entry.shop_id)) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  const refused = await batchWithAudit(
    c,
    [c.env.DB.prepare("UPDATE waitlist SET status = ? WHERE id = ?").bind(body.status, id)],
    {
      action: "waitlist.update",
      outcome: "succeeded",
      shopId: entry.shop_id,
      entityType: "waitlist_entry",
      entityId: id,
      changes: fieldChanges(entry, { status: body.status }).changes,
    },
  );
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── POST /api/waitlist/:id/notify — admin/staff/developer ────────────────────
//
// Sends the "a slot just opened" email to one waiting entry and marks it
// notified. The claim is atomic (UPDATE ... WHERE status='waiting') so two
// admins double-clicking produce exactly one email; a failed send reverts the
// claim. Re-notification goes through PATCH back to 'waiting' first.

waitlist.post("/:id/notify", authMiddleware, async (c) => {
  const user = getUser(c);
  if (!user || !["developer", "admin", "staff"].includes(user.role)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }
  const { id } = c.req.param();
  const entry = await getWaitlistEntryById(c.env.DB, id);
  if (!entry || (user.role !== "developer" && user.shop_id !== entry.shop_id)) {
    return c.json({ success: false, error: "Not found" }, 404);
  }

  if (entry.status === "notified") {
    // A 200 that changes nothing still records itself (no silent 2xx on a
    // declared route). Best effort: if it cannot be written, the answer is
    // the same and the gap guard attempts its own floor row.
    try {
      await auditFor(c).write({
        action: "waitlist.notify",
        outcome: "refused",
        reason: "already_notified",
        shopId: entry.shop_id,
        entityType: "waitlist_entry",
        entityId: id,
        details: { trigger: "manual" },
      });
    } catch (e) {
      if (!(e instanceof AuditWriteError)) throw e;
    }
    return c.json({ success: true, data: { notified: false, already_notified: true } });
  }
  if (entry.status !== "waiting") {
    return c.json({ success: false, error: "Only waiting entries can be notified" }, 400);
  }
  // An explicit admin action must not silently mark notified with no email.
  const apiKey = c.env.RESEND_API_KEY;
  if (!apiKey) {
    return c.json({ success: false, error: "Email sending is not configured" }, 503);
  }

  const shop = await getShopById(c.env.DB, entry.shop_id);
  if (!shop) return c.json({ success: false, error: "Not found" }, 404);

  // The started entry commits before the claim (notifyWaitlistEntry), so a
  // notification that cannot be recorded is never claimed or sent.
  let result: "sent" | "lost";
  try {
    result = await notifyWaitlistEntry(c.env.DB, apiKey, shop, entry, auditFor(c), "manual");
  } catch (err) {
    if (err instanceof AuditWriteError) return auditRefused(c);
    if (err instanceof WaitlistSendError) {
      // The send failed: the claim is already reverted and the outcome recorded.
      reportError("waitlist.notify_email", err.original, { entryId: id, shopId: entry.shop_id });
      return c.json({ success: false, error: "Failed to send notification email" }, 502);
    }
    // A database failure (claim or revert): a 500, as before (the outcome is recorded `failed`).
    throw err;
  }

  if (result === "lost") {
    // Lost the race: re-read to report accurately. A concurrent click that
    // already sent leaves it notified; a concurrent booked/expired transition
    // means it can no longer be notified.
    const current = await getWaitlistEntryById(c.env.DB, id);
    if (current?.status === "notified") {
      return c.json({ success: true, data: { notified: false, already_notified: true } });
    }
    return c.json({ success: false, error: "Only waiting entries can be notified" }, 400);
  }

  return c.json({ success: true, data: { notified: true } });
});

export default waitlist;
