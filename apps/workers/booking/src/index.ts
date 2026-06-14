import { Hono } from "hono";
import type { Env } from "./types.js";
import { ensureBookingSchema } from "./db/ensure-schema.js";
import { authMiddleware } from "./middleware/auth.js";
import { requireShopAccess, requireDeveloper } from "./middleware/shop-access.js";
import setupRoutes from "./routes/setup.js";
import dayRoutes from "./routes/day.js";
import bookingsRoutes from "./routes/bookings.js";
import platformAlertsRoutes from "./routes/platform-alerts.js";

const root = new Hono<{ Bindings: Env }>();

let schemaOnce: Promise<void> | null = null;
root.use("*", async (c, next) => {
  if (!schemaOnce) {
    // Clear on rejection — caching a rejected promise poisons every later
    // request until the isolate restarts.
    schemaOnce = ensureBookingSchema(c.env.DB).catch((err) => {
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

booking.route("/shops", shops);

const platform = new Hono<{ Bindings: Env }>();
platform.use("*", requireDeveloper());
platform.route("/", platformAlertsRoutes);

booking.route("/platform", platform);

root.route("/booking", booking);

root.get("/health", (c) => c.json({ ok: true, worker: "pivot-parlor-booking" }));

export default root;
