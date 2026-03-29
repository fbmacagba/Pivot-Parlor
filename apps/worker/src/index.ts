import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { MessageBatch } from "@cloudflare/workers-types";

import type { Bindings } from "./bindings.js";
export type { Bindings } from "./bindings.js";

import authRouter from "./routes/auth.js";
import oauthRouter from "./routes/oauth.js";
import contactRouter from "./routes/contact.js";
import shopsRouter from "./routes/shops.js";
import invitesRouter from "./routes/invites.js";
import webhooksRouter from "./routes/webhooks.js";
import staffRouter from "./routes/staff.js";
import servicesRouter from "./routes/services.js";
import scheduleRouter from "./routes/schedule.js";
import slotsRouter from "./routes/slots.js";
import waitlistRouter from "./routes/waitlist.js";
import aiRouter from "./routes/ai.js";
import jobsRouter from "./routes/jobs.js";
import { bookingsRouter, publicBookingRouter } from "./routes/bookings.js";
import { processReminder, sendPendingReminders, type ReminderPayload } from "./services/reminder.js";
import {
  devRouter,
  shopStatsRouter,
  shopRevenueRouter,
  shopSetupStatusRouter,
  staffMeRouter,
  meRouter,
} from "./routes/dashboard.js";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>();

/**
 * Stripe webhooks must not pass through global middleware (logger/cors). Server-side
 * callers (Stripe) have no Origin; edge/proxy quirks can otherwise surface as redirects
 * or non-JSON responses before the handler runs. This app only mounts the webhook router.
 */
const stripeWebhookApp = new Hono<{ Bindings: Bindings }>();
stripeWebhookApp.route("/api/webhooks", webhooksRouter);

// ─── Global middleware ────────────────────────────────────────────────────────

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "http://localhost:3000";
      if (
        origin === "http://localhost:3000" ||
        origin === "https://pivotparlor.com" ||
        /^https:\/\/[a-z0-9-]+\.pivotparlor\.com$/.test(origin) ||
        /^https:\/\/[a-z0-9-]+\.pivot-parlor-web\.pages\.dev$/.test(origin)
      ) {
        return origin;
      }
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  })
);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT ?? "development", ts: new Date().toISOString() })
);

// ─── Public: R2 assets (images for shop sites) ─────────────────────────────────

app.get("/assets/:shopSlug/:filename", async (c) => {
  const { shopSlug, filename } = c.req.param();
  const key = `shops/${shopSlug}/${filename}`;
  const object = await c.env.ASSETS.get(key);
  if (!object) return c.json({ success: false, error: "Not found" }, 404);

  const contentType = filename.endsWith(".png") ? "image/png" : "image/webp";
  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// Auth (public + protected)
app.route("/auth", authRouter);

// OAuth social login (Google, Facebook, LinkedIn)
app.route("/auth", oauthRouter);

// Developer-scoped shop management  (auth + requireRole applied inside router)
app.route("/api/shops", shopsRouter);

// Job status (async site generation)
app.route("/api/jobs", jobsRouter);

// Public: invite acceptance
app.route("/api/invites", invitesRouter);

// Stripe webhooks: handled only via stripeWebhookApp in fetch() below (bypasses global middleware).

// Shop sub-resources  (auth + requireShop applied inside each router)
app.route("/api/shops/:shopId/staff", staffRouter);
app.route("/api/shops/:shopId/services", servicesRouter);
app.route("/api/shops/:shopId/schedule", scheduleRouter);
app.route("/api/shops/:shopId/bookings", bookingsRouter);

// ─── Dashboard endpoints ──────────────────────────────────────────────────────

// Developer platform stats + revenue (developer role only)
app.route("/api/dev", devRouter);

// Admin shop stats (today's summary)
app.route("/api/shops/:shopId/stats", shopStatsRouter);

// Admin shop revenue breakdown
app.route("/api/shops/:shopId/revenue", shopRevenueRouter);
app.route("/api/shops/:shopId/setup-status", shopSetupStatusRouter);

// Staff member's own data (scoped to JWT — no shopId in URL)
app.route("/api/staff/me", staffMeRouter);

// Customer's own booking history
app.route("/api/me", meRouter);

// ─────────────────────────────────────────────────────────────────────────────

// Public: time slots
app.route("/api/shops/:shopId/slots", slotsRouter);

// Public: customer booking creation
app.route("/api/bookings", publicBookingRouter);

// Public: waitlist join  (GET is protected inside the router)
app.route("/api/waitlist", waitlistRouter);

// Developer: AI theme generation + model management
app.route("/api/ai", aiRouter);

// Public: contact form + developer enquiry list
// Primary path when the Worker is mounted at the domain root:
app.route("/api/contact", contactRouter);
// Alias to support deployments where the Worker itself is mounted at `/api/*`
// and receives `/contact` as the request path:
app.route("/contact", contactRouter);

// ─── Error handlers ───────────────────────────────────────────────────────────

app.notFound((c) => c.json({ success: false, error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("[Worker Error]", err);
  return c.json({ success: false, error: "Internal server error" }, 500);
});

// ─── Export ───────────────────────────────────────────────────────────────────

function isStripeWebhookPost(request: Request, url: URL): boolean {
  if (request.method !== "POST") return false;
  const path = url.pathname.replace(/\/$/, "") || "/";
  return path === "/api/webhooks/stripe";
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (isStripeWebhookPost(request, url)) {
      return stripeWebhookApp.fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },

  /**
   * Cron trigger: send pending 24-hour reminders (fallback if Queue not configured).
   * Schedule: "0 8 * * *" — fires at 08:00 UTC daily.
   */
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    console.log("[Cron] Processing pending reminders...");
    await sendPendingReminders(env.DB, env.RESEND_API_KEY);
  },

  /**
   * Queue consumer: booking reminders only (site generation queues use dedicated workers).
   */
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    const q = batch.queue;

    if (q === "pivot-parlor-reminders") {
      for (const msg of batch.messages) {
        try {
          const body = msg.body as ReminderPayload;
          const now = new Date();
          const sendAt = new Date(body.sendAt);

          if (sendAt > now) {
            msg.ack();
            continue;
          }

          await processReminder(body, env.DB, env.RESEND_API_KEY);
          msg.ack();
        } catch (err) {
          console.error("[Queue] Failed to process reminder", msg.body, err);
          msg.retry();
        }
      }
      return;
    }

    console.warn("[Queue] Unknown queue:", q);
    for (const msg of batch.messages) {
      msg.ack();
    }
  },
};
