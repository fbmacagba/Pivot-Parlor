import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { batchWithAudit } from "../audit/context.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import {
  CONTACT_FIELD_LIMITS,
  type ContactLimitedField,
  isOptionalText,
  normalizeLineBreaks,
  readJsonObject,
} from "@repo/utils";

const contact = new Hono<{ Bindings: Bindings }>();

// ─── POST /api/contact — public form submission ───────────────────────────────

contact.post(
  "/",
  rateLimit({ name: "contact", limit: 5, windowS: 3600, key: clientIp }),
  async (c) => {
  try {
    // A body that is not a JSON object, or a field that is not text, is the
    // caller's mistake: a 400, never the catch's 500 below.
    const body = await readJsonObject(c.req);
    if (!body) {
      return c.json({ success: false, error: "Invalid JSON" }, 400);
    }
    const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
    const fullName = text(body.full_name);
    const shopName = text(body.shop_name);
    const shopType = text(body.shop_type);
    const email = text(body.email);
    // A browser submits each textarea line break as CRLF; one "\n" each is
    // what its maxlength counted.
    const message = normalizeLineBreaks(text(body.message));

    // No log line here carries what the enquirer typed: Workers Logs keeps
    // every line, and a name or an email is personal data. Field names only.
    if (!fullName) {
      console.warn("[worker contact] missing full_name");
      return c.json({ success: false, error: "full_name is required" }, 400);
    }
    if (!shopName) {
      console.warn("[worker contact] missing shop_name");
      return c.json({ success: false, error: "shop_name is required" }, 400);
    }
    if (!shopType) {
      console.warn("[worker contact] missing shop_type");
      return c.json({ success: false, error: "shop_type is required" }, 400);
    }
    if (!email) {
      console.warn("[worker contact] missing email");
      return c.json({ success: false, error: "email is required" }, 400);
    }
    if (!message) {
      console.warn("[worker contact] missing message");
      return c.json({ success: false, error: "message is required" }, 400);
    }
    if (!isOptionalText(body.phone)) {
      return c.json({ success: false, error: "phone must be text" }, 400);
    }
    const phone = body.phone?.trim() ?? null;

    // Each field is measured as it is stored (trimmed).
    const measured: Array<[ContactLimitedField, string]> = [
      ["full_name", fullName],
      ["shop_name", shopName],
      ["email", email],
      ["phone", phone ?? ""],
      ["message", message],
    ];
    const tooLong = measured.find(([field, value]) => value.length > CONTACT_FIELD_LIMITS[field]);
    if (tooLong) {
      const [field] = tooLong;
      console.warn("[worker contact] field too long", { field });
      return c.json(
        { success: false, error: `${field} is too long (${CONTACT_FIELD_LIMITS[field]} characters at most)` },
        400
      );
    }

    const validShopTypes = ["barber_shop", "beauty_parlor", "both"];
    if (!validShopTypes.includes(shopType)) {
      console.warn("[worker contact] invalid shop_type");
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
          fullName,
          shopName,
          shopType,
          email.toLowerCase(),
          phone,
          message
        ),
      ],
      {
        action: "enquiry.create",
        outcome: "succeeded",
        entityType: "contact",
        entityId: id,
        details: { shop_type: shopType },
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
