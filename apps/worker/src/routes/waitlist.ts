import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getWaitlistByShop,
  createWaitlistEntry,
  getShopById,
  getShopBySlug,
  getWaitlistEntryById,
  claimWaitlistNotification,
  revertWaitlistNotification,
} from "../db/queries.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { sendWaitlistSlotOpen } from "../services/email.js";
import { reportError } from "../services/report-error.js";
import { isPortfolioDemoShop, PORTFOLIO_DEMO_ERROR } from "@repo/utils";

const waitlist = new Hono<{ Bindings: Bindings }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── POST /api/waitlist — public (no auth required) ──────────────────────────

waitlist.post(
  "/",
  rateLimit({ name: "waitlist", limit: 10, windowS: 3600, key: clientIp }),
  async (c) => {
    const body = await c.req
      .json<{
        shop_id?: string;
        shop_slug?: string;
        service_id?: string;
        staff_id?: string;
        customer_name?: string;
        customer_email?: string;
        customer_phone?: string;
        preferred_date?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);

    const name = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
    const email = typeof body.customer_email === "string" ? body.customer_email.trim() : "";
    const phone = typeof body.customer_phone === "string" ? body.customer_phone.trim() : "";
    const preferredDate = typeof body.preferred_date === "string" ? body.preferred_date.trim() : "";

    const shopIdentifier = body.shop_id || body.shop_slug;
    if (!shopIdentifier || !name || !email) {
      return c.json(
        { success: false, error: "shop_id (or shop_slug), customer_name and customer_email are required" },
        400
      );
    }
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
    if (isPortfolioDemoShop(shop.slug)) {
      return c.json({ success: false, error: PORTFOLIO_DEMO_ERROR }, 403);
    }
    if (body.service_id) {
      const svc = await c.env.DB
        .prepare("SELECT id FROM services WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1")
        .bind(body.service_id, shop.id)
        .first<{ id: string }>();
      if (!svc) return c.json({ success: false, error: "Invalid service" }, 400);
    }
    if (body.staff_id) {
      const st = await c.env.DB
        .prepare("SELECT id FROM staff WHERE id = ? AND shop_id = ? AND is_active = 1 LIMIT 1")
        .bind(body.staff_id, shop.id)
        .first<{ id: string }>();
      if (!st) return c.json({ success: false, error: "Invalid staff member" }, 400);
    }

    const id = crypto.randomUUID();
    await createWaitlistEntry(c.env.DB, {
      id,
      shop_id: shop.id,
      staff_id: body.staff_id ?? null,
      service_id: body.service_id ?? null,
      customer_name: name,
      customer_email: email,
      customer_phone: phone || null,
      preferred_date: preferredDate || null,
    });

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
    .prepare("SELECT shop_id FROM waitlist WHERE id = ?")
    .bind(id)
    .first<{ shop_id: string }>();
  if (!entry || (user.role !== "developer" && user.shop_id !== entry.shop_id)) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  await c.env.DB
    .prepare("UPDATE waitlist SET status = ? WHERE id = ?")
    .bind(body.status, id)
    .run();
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
    return c.json({ success: true, data: { notified: false, already_notified: true } });
  }
  if (entry.status !== "waiting") {
    return c.json({ success: false, error: "Only waiting entries can be notified" }, 400);
  }
  // An explicit admin action must not silently mark notified with no email.
  if (!c.env.RESEND_API_KEY) {
    return c.json({ success: false, error: "Email sending is not configured" }, 503);
  }

  const shop = await getShopById(c.env.DB, entry.shop_id);
  if (!shop) return c.json({ success: false, error: "Not found" }, 404);

  const claim = await claimWaitlistNotification(c.env.DB, id);
  if (!claim.meta || claim.meta.changes === 0) {
    // Lost the race: re-read to report accurately. A concurrent click that
    // already sent leaves it notified; a concurrent booked/expired transition
    // means it can no longer be notified.
    const current = await getWaitlistEntryById(c.env.DB, id);
    if (current?.status === "notified") {
      return c.json({ success: true, data: { notified: false, already_notified: true } });
    }
    return c.json({ success: false, error: "Only waiting entries can be notified" }, 400);
  }

  try {
    await sendWaitlistSlotOpen(c.env.RESEND_API_KEY, {
      customer_name: entry.customer_name,
      customer_email: entry.customer_email,
      shop_name: shop.name,
      shop_slug: shop.slug,
      service_name: entry.service_name,
      preferred_date: entry.preferred_date,
    });
  } catch (err) {
    await revertWaitlistNotification(c.env.DB, id);
    reportError("waitlist.notify_email", err, { entryId: id, shopId: entry.shop_id });
    return c.json({ success: false, error: "Failed to send notification email" }, 502);
  }

  return c.json({ success: true, data: { notified: true } });
});

export default waitlist;
