import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
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
import connectProxyRouter from "./routes/connect-proxy.js";
import waitlistRouter from "./routes/waitlist.js";
import aiRouter from "./routes/ai.js";
import jobsRouter from "./routes/jobs.js";
import { productsRouter, suppliersRouter } from "./routes/products.js";
import { inventoryRouter } from "./routes/inventory.js";
import { bookingsRouter, publicBookingRouter } from "./routes/bookings.js";
import { processReminder, sendPendingReminders, type ReminderPayload } from "./services/reminder.js";
import { reminderDelaySeconds } from "@repo/utils";
import { sendEodAlert } from "./services/email.js";
import { walkinRouter, adminWalkinRouter } from "./routes/walkin.js";
import {
  devRouter,
  shopStatsRouter,
  shopRevenueRouter,
  shopSetupStatusRouter,
  shopAnalyticsRouter,
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

// Public shop images under /assets/* are embedded cross-origin — by the dev
// dashboard and by the live shop sites, both served from a different origin than
// this API host. secureHeaders() below defaults Cross-Origin-Resource-Policy to
// "same-origin", which makes browsers refuse those <img> loads (curl still 200,
// the browser shows a broken image). Relax CORP to "cross-origin" for assets only.
// MUST be registered before secureHeaders(): middleware unwinds last-registered-
// first, so this outer post-response runs AFTER secureHeaders' and wins. The
// targeting (assets only) is guarded by test/assets-cors.test.ts.
app.use("/assets/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
});

app.use("*", logger());

// API security headers (NFR-S7). The web app's headers live in apps/web/public/_headers.
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    strictTransportSecurity: "max-age=63072000; includeSubDomains",
    referrerPolicy: "no-referrer",
  })
);

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
app.route("/api/shops/:shopId/connect", connectProxyRouter);
app.route("/api/shops/:shopId/staff", staffRouter);
app.route("/api/shops/:shopId/services", servicesRouter);
app.route("/api/shops/:shopId/schedule", scheduleRouter);
app.route("/api/shops/:shopId/bookings", bookingsRouter);

// Inventory catalogue + stock (WS-3 Phase 0; shop-internal, auth inside routers)
app.route("/api/shops/:shopId/products", productsRouter);
app.route("/api/shops/:shopId/suppliers", suppliersRouter);
app.route("/api/shops/:shopId/inventory", inventoryRouter);

// ─── Dashboard endpoints ──────────────────────────────────────────────────────

// Developer platform stats + revenue (developer role only)
app.route("/api/dev", devRouter);

// Admin shop stats (today's summary)
app.route("/api/shops/:shopId/stats", shopStatsRouter);

// Admin shop revenue breakdown
app.route("/api/shops/:shopId/revenue", shopRevenueRouter);
app.route("/api/shops/:shopId/setup-status", shopSetupStatusRouter);
app.route("/api/shops/:shopId/analytics", shopAnalyticsRouter);
app.route("/api/walkin", walkinRouter);
app.route("/api/shops/:shopId/walkin", adminWalkinRouter);

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
  // Include request context so 500s are diagnosable from logs.
  console.error(`[Worker Error] ${c.req.method} ${c.req.path} —`, err);
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
  async scheduled(event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    const cron = event.cron;

    // 08:00 UTC — send 24h-ahead booking reminders
    if (cron === "0 8 * * *") {
      console.log("[Cron 08:00] Processing pending reminders...");
      await sendPendingReminders(env.DB, env.RESEND_API_KEY);
      return;
    }

    // 20:00 UTC — EOD developer alert (booking count only, no financial amounts)
    if (cron === "0 20 * * *") {
      console.log("[Cron 20:00] Sending EOD developer alert...");
      try {
        const today = new Date().toISOString().slice(0, 10);
        const row = await env.DB
          .prepare(
            `SELECT COUNT(*) AS booking_count,
                    COUNT(DISTINCT shop_id) AS shop_count
             FROM bookings
             WHERE booking_date = ?
               AND status NOT IN ('cancelled', 'no_show')`
          )
          .bind(today)
          .first<{ booking_count: number; shop_count: number }>();

        // Get developer email from platform_users
        const dev = await env.DB
          .prepare("SELECT email FROM platform_users WHERE role = 'developer' LIMIT 1")
          .first<{ email: string }>();

        if (dev?.email && env.RESEND_API_KEY) {
          await sendEodAlert(env.RESEND_API_KEY, {
            developer_email: dev.email,
            date: today,
            booking_count: row?.booking_count ?? 0,
            shop_count: row?.shop_count ?? 0,
          });
        }
      } catch (err) {
        console.error("[Cron 20:00] EOD alert failed:", err);
      }
      return;
    }

    console.warn("[Cron] Unknown schedule:", cron);
  },

  /**
   * Queue consumer: booking reminders only (site generation queues use dedicated workers).
   */
  async queue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
    const q = batch.queue;

    if (q === "pivot-parlor-reminders" || q === "pivot-parlor-reminders-staging") {
      for (const msg of batch.messages) {
        try {
          const body = msg.body as ReminderPayload;
          const now = new Date();
          const sendAt = new Date(body.sendAt);

          if (sendAt > now) {
            // Not due yet (delaySeconds caps at 12h, so >12h reminders arrive
            // early). Re-delay the remainder instead of dropping the message —
            // acking here silently lost every reminder more than one queue-hop out.
            msg.retry({ delaySeconds: Math.max(60, reminderDelaySeconds(sendAt, now)) });
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
