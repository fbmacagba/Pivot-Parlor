import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { getWaitlistByShop, createWaitlistEntry } from "../db/queries.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShop } from "../middleware/rbac.js";

const waitlist = new Hono<{ Bindings: Bindings }>();

// ─── POST /api/waitlist — public (no auth required) ──────────────────────────

waitlist.post("/", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    service_id?: string;
    staff_id?: string;
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    preferred_date?: string;
  }>();

  if (!body.shop_id || !body.customer_name || !body.customer_email) {
    return c.json(
      { success: false, error: "shop_id, customer_name and customer_email are required" },
      400
    );
  }

  const id = crypto.randomUUID();
  await createWaitlistEntry(c.env.DB, {
    id,
    shop_id: body.shop_id,
    staff_id: body.staff_id ?? null,
    service_id: body.service_id ?? null,
    customer_name: body.customer_name,
    customer_email: body.customer_email,
    customer_phone: body.customer_phone ?? null,
    preferred_date: body.preferred_date ?? null,
  });

  return c.json({ success: true, data: { id } }, 201);
});

// ─── GET /api/waitlist?shop_id= — admin/developer view ───────────────────────

waitlist.get("/", authMiddleware, requireShop(), async (c) => {
  const shopId = c.req.query("shop_id") ?? c.req.param("shopId");
  if (!shopId) return c.json({ success: false, error: "shop_id is required" }, 400);

  const entries = await getWaitlistByShop(c.env.DB, shopId);
  return c.json({ success: true, data: entries });
});

// ─── PATCH /api/waitlist/:id/status — admin/developer ────────────────────────

waitlist.patch("/:id/status", authMiddleware, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ status?: string }>();
  const valid = ["waiting", "notified", "booked", "expired"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }
  await c.env.DB
    .prepare("UPDATE waitlist SET status = ? WHERE id = ?")
    .bind(body.status, id)
    .run();
  return c.json({ success: true });
});

export default waitlist;
