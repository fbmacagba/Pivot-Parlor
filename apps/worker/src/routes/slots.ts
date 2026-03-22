import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { getServiceById } from "../db/queries.js";
import { getAvailableSlots } from "../services/slots.js";

const slots = new Hono<{ Bindings: Bindings }>();

// ─── GET /api/shops/:shopId/slots — public ────────────────────────────────────
// Query: date (YYYY-MM-DD), service_id, [staff_id]

slots.get("/", async (c) => {
  const shopId = c.req.param("shopId")!;
  const { date, service_id, staff_id } = c.req.query();

  if (!date || !service_id) {
    return c.json({ success: false, error: "date and service_id are required" }, 400);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ success: false, error: "date must be in YYYY-MM-DD format" }, 400);
  }

  const service = await getServiceById(c.env.DB, service_id);
  if (!service || service.shop_id !== shopId) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }

  const slotList = await getAvailableSlots(
    shopId,
    staff_id ?? null,
    date,
    service.duration_min,
    c.env.DB,
    c.env.KV
  );

  return c.json({ success: true, data: slotList });
});

export default slots;
