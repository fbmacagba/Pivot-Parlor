import { Hono } from "hono";
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import type { Env } from "./types.js";
import { assertBookingSchema } from "./db/ensure-schema.js";
import { authMiddleware } from "./middleware/auth.js";
import { requireShopAccess, requireDeveloper } from "./middleware/shop-access.js";
import setupRoutes from "./routes/setup.js";
import dayRoutes from "./routes/day.js";
import bookingsRoutes from "./routes/bookings.js";
import salesRoutes from "./routes/sales.js";
import platformAlertsRoutes from "./routes/platform-alerts.js";
import publicRoutes from "./routes/public.js";
import connectRoutes from "./routes/connect.js";
import stripeWebhookRoutes from "./routes/stripe-webhook.js";
import { sweepExpiredDepositBookings } from "./services/deposit-sweep.js";
import { reportError } from "./services/report-error.js";

const root = new Hono<{ Bindings: Env }>();

let schemaOnce: Promise<void> | null = null;
root.use("*", async (c, next) => {
  if (!schemaOnce) {
    // Clear on rejection — caching a rejected promise poisons every later
    // request until the isolate restarts.
    schemaOnce = assertBookingSchema(c.env.DB).catch((err) => {
      schemaOnce = null;
      throw err;
    });
  }
  await schemaOnce;
  await next();
});

const booking = new Hono<{ Bindings: Env }>();
booking.use("*", authMiddleware);

const shops = new Hono<{ Bindings: Env }>();
shops.use("/:shopId/*", requireShopAccess());
shops.route("/", setupRoutes);
shops.route("/", dayRoutes);
shops.route("/", bookingsRoutes);
shops.route("/", salesRoutes);
shops.route("/", connectRoutes);

booking.route("/shops", shops);

const platform = new Hono<{ Bindings: Env }>();
platform.use("*", requireDeveloper());
platform.route("/", platformAlertsRoutes);

booking.route("/platform", platform);

root.route("/booking", booking);

// Public (unauthenticated) customer booking surface — the main worker proxies
// /api/bookings and /api/shops/:shopId/slots here over its BOOKING service
// binding (WS-1). Rate limiting is applied inside the routes.
root.route("/public", publicRoutes);

// Stripe webhook — authenticated by signature, not JWT (WS-2).
root.route("/webhooks", stripeWebhookRoutes);

root.get("/health", (c) => c.json({ ok: true, worker: "pivot-parlor-booking" }));

export default {
  fetch: root.fetch,
  // Cron (*/15): backstop for checkout.session.expired — releases slots held
  // by abandoned deposit payments (see services/deposit-sweep.ts).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await assertBookingSchema(env.DB);
    ctx.waitUntil(
      sweepExpiredDepositBookings(env.DB).catch((err) =>
        reportError("deposit.sweep", err, {})
      )
    );
  },
};
