import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { auditFor, batchWithAudit, SYSTEM_ACTOR } from "../audit/context.js";
import { sendEnquiryAlert } from "../services/email.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { readTurnstileToken, verifyTurnstileToken } from "../services/turnstile.js";
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

    // The bot check runs here, once, and after the field checks so a field
    // mistake never spends the visitor's token (a token works only once).
    // The website forwards the widget's token and never checks it itself.
    // Unset (staging, local), the form works without it.
    const turnstileSecret = c.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      const token = readTurnstileToken(body.turnstile_token);
      if (!token) {
        console.warn("[worker contact] no security check token");
        return c.json({ success: false, error: "Please complete the security check." }, 400);
      }
      // Error codes only: the token itself never goes in a log line.
      const check = await verifyTurnstileToken(turnstileSecret, token, clientIp(c));
      if (check.result === "misconfigured") {
        console.error("[worker contact] Turnstile refused our secret", { codes: check.codes });
        return c.json({ success: false, error: "We couldn't run the security check. Please try again later." }, 503);
      }
      if (check.result === "unavailable") {
        console.warn("[worker contact] Turnstile siteverify unavailable", { codes: check.codes });
        return c.json({ success: false, error: "We couldn't run the security check. Please try again later." }, 503);
      }
      if (check.result === "rejected") {
        console.warn("[worker contact] security check failed", { codes: check.codes });
        return c.json({ success: false, error: "Security check failed. Please try again." }, 400);
      }
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

    // The platform inbox hears of every stored enquiry, in the background so
    // the visitor never waits on the email and its outcome never changes their
    // answer. Unset in staging and local, so nothing is sent there.
    const apiKey = c.env.RESEND_API_KEY;
    const alertTo = c.env.ENQUIRY_ALERT_TO;
    if (apiKey && alertTo) {
      const alert = { full_name: fullName, shop_name: shopName, shop_type: shopType, email, phone, message };
      c.executionCtx.waitUntil(
        auditFor(c, "api", SYSTEM_ACTOR)
          .run({ action: "enquiry.alert", entityType: "contact", entityId: id }, () =>
            sendEnquiryAlert(apiKey, alertTo, alert),
          )
          .catch((err: unknown) => {
            // An error line, so the Worker issue alert says a lead was not
            // forwarded. The enquiry itself is stored. Never the error's
            // message: it can carry what the enquirer typed.
            const status = (err as { status?: unknown } | null)?.status;
            console.error("[worker contact] enquiry alert not sent", {
              id,
              error: err instanceof Error ? err.name : "unknown",
              ...(typeof status === "number" ? { status } : {}),
            });
          }),
      );
    }

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
