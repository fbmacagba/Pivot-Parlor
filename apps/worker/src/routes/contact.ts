import { Hono } from "hono";
import type { Bindings } from "../bindings.js";

const contact = new Hono<{ Bindings: Bindings }>();

// ─── POST /api/contact — public form submission ───────────────────────────────

contact.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      full_name?: string;
      shop_name?: string;
      shop_type?: string;
      email?: string;
      phone?: string;
      message?: string;
    }>();

    console.log("[worker contact] incoming body", body);

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

    await c.env.DB.prepare(
      `INSERT INTO contacts (id, full_name, shop_name, shop_type, email, phone, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.full_name.trim(),
        body.shop_name.trim(),
        body.shop_type.trim(),
        body.email.trim().toLowerCase(),
        body.phone?.trim() ?? null,
        body.message?.trim() ?? null
      )
      .run();

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
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM contacts ORDER BY created_at DESC LIMIT 100"
  ).all();
  return c.json({ success: true, data: results });
});

export default contact;
