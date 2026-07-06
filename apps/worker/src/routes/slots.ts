import { Hono } from "hono";
import type { Bindings } from "../bindings.js";

const slots = new Hono<{ Bindings: Bindings }>();

// ─── GET /api/shops/:shopId/slots — public ────────────────────────────────────
// Query: date (YYYY-MM-DD), service_id, [staff_id]
// WS-1: availability is owned by the booking worker (dynamic schedules model);
// this proxies over the BOOKING service binding with the query string intact.

slots.get("/", (c) => {
  const shopId = c.req.param("shopId")!;
  const search = new URL(c.req.url).search;
  return c.env.BOOKING.fetch(
    new Request(`https://booking/public/shops/${shopId}/slots${search}`, c.req.raw)
  );
});

export default slots;
