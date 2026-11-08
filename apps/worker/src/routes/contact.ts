import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { batchWithAudit } from "../audit/context.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";

const contact = new Hono<{ Bindings: Bindings }>();

// ─── POST /api/contact — public form submission ───────────────────────────────

contact.post(
  "/",
  rateLimit({ name: "contact", limit: 5, windowS: 3600, key: clientIp }),
  async (c) => {
  try {
    const body = await c.req.json<{
      full_name?: string;
      shop_name?: string;
      shop_type?: string;
      email?: string;
      phone?: string;
      message?: string;
    }>();

    // Log structured fields, not the raw body (avoids dumping the free-text
    // message / PII blob and any control chars into logs).
    console.log("[worker contact] incoming", {
      full_name: body.full_name,
      email: body.email,
      shop_name: body.shop_name,
      has_message: !!body.message,
    });

    if (!body.full_name?.trim()) {
      console.warn("[worker contact] missing full_name");
      return c.json({ success: false, error: "full_name is required" }, 400);
    }
    if (!body.shop_name?.trim()) {
      console.warn("[worker contact] missing shop_name");
      return c.json({ success: false, error: "shop_name is required" }, 400);
    }
    if (!body.shop_type?.trim()) {
      console.warn("[worker contact] missing shop_type");
      return c.json({ success: false, error: "shop_type is required" }, 400);
    }
    if (!body.email?.trim()) {
      console.warn("[worker contact] missing email");
      return c.json({ success: false, error: "email is required" }, 400);
    }
    if (!body.message?.trim()) {
      console.warn("[worker contact] missing message");
      return c.json({ success: false, error: "message is required" }, 400);
    }

    const validShopTypes = ["barber_shop", "beauty_parlor", "both"];
    if (!validShopTypes.includes(body.shop_type)) {
      console.warn("[worker contact] invalid shop_type", body.shop_type);
      return c.json({ success: false, error: "Invalid shop_type" }, 400);
    }

    const id = crypto.randomUUID();

    // The enquiry and its entry commit together. The entry names only the
    // validated shop type: never the name, shop name, email, phone or message.
    const refused = await batchWithAudit(
      c,
      [
        c.env.DB.prepare(
          `INSERT INTO contacts (id, full_name, shop_name, shop_type, email, phone, message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          body.full_name.trim(),
          body.shop_name.trim(),
          body.shop_type.trim(),
          body.email.trim().toLowerCase(),
          body.phone?.trim() ?? null,
          body.message?.trim() ?? null
        ),
      ],
      {
        action: "enquiry.create",
        outcome: "succeeded",
        entityType: "contact",
        entityId: id,
        details: { shop_type: validShopTypes.includes(body.shop_type) ? body.shop_type : null },
      }
    );
    if (refused) return refused;

    console.log("[worker contact] stored enquiry", { id });

    return c.json({ success: true, data: { id } }, 201);
  } catch (err) {
    console.error("[worker contact] unhandled error", err);
    return c.json({ success: false, error: "Internal error" }, 500);
  }
});

// ─── GET /api/contact — developer only: list all enquiries ───────────────────

import { authMiddleware } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";

contact.get("/", authMiddleware, requireRole("developer"), async (c) => {
  // Backward-compatible pagination: default limit 100 (the previous fixed cap,
  // so existing callers are unchanged) + offset to reach older enquiries.
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(limit, offset)
    .all();
  return c.json({ success: true, data: results });
});

export default contact;
