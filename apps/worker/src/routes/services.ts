import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  type DBService,
  getServicesByShop,
  getServiceById,
  createService,
  updateService,
  getShopBySlug,
  getShopById,
} from "../db/queries.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";

const services = new Hono<{ Bindings: Bindings }>();

/** Public API shape for booking UI (@repo/types Service). Money is pence (WS-4). */
function toPublicService(row: DBService) {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    description: "",
    durationMinutes: row.duration_min,
    price_pence: row.price_pence,
    category: row.category ?? "",
    isActive: row.is_active === 1,
  };
}

// ─── GET /api/shops/:shopId/services — public ─────────────────────────────────

services.get("/", async (c) => {
  const shopIdParam = c.req.param("shopId")!;
  const shop =
    (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
  if (!shop) {
    console.log("[services][GET] shop not found param=", shopIdParam);
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const list = await getServicesByShop(c.env.DB, shop.id);
  console.log(
    "[services][GET] param=",
    shopIdParam,
    "resolved_shop_id=",
    shop.id,
    "shop_slug=",
    shop.slug,
    "query=services WHERE shop_id=? AND is_active=1 row_count=",
    list.length
  );

  return c.json({ success: true, data: list.map(toPublicService) });
});

// ─── GET /api/shops/:shopId/services/:serviceId ───────────────────────────────

services.get("/:serviceId", async (c) => {
  const shopIdParam = c.req.param("shopId")!;
  const serviceId = c.req.param("serviceId")!;
  // :shopId may be a slug or an id, same as GET / above.
  const shop =
    (await getShopBySlug(c.env.DB, shopIdParam)) ?? (await getShopById(c.env.DB, shopIdParam));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shop.id) {
    return c.json({ success: false, error: "Service not found" }, 404);
  }
  return c.json({ success: true, data: svc });
});

// Protected mutations below. Each handler applies authMiddleware + requireShopRole("admin")
// inline (the prior services.use("POST, PUT, ...") line was a no-op: Hono treats
// the method-prefixed string as a literal path that never matches).

// ─── POST /api/shops/:shopId/services ────────────────────────────────────────

services.post("/", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await c.req.json<{
    name?: string;
    duration_min?: number;
    price_pence?: number;
    category?: string;
  }>();

  if (!body.name || body.duration_min == null || body.price_pence == null) {
    return c.json({ success: false, error: "name, duration_min and price_pence are required" }, 400);
  }
  if (!Number.isInteger(body.price_pence) || body.price_pence < 0) {
    return c.json({ success: false, error: "price_pence must be a non-negative integer (pence)" }, 400);
  }

  const id = crypto.randomUUID();
  await createService(c.env.DB, {
    id,
    shop_id: shopId,
    name: body.name,
    duration_min: body.duration_min,
    price_pence: body.price_pence,
    category: body.category ?? null,
  });

  const svc = await getServiceById(c.env.DB, id);
  return c.json({ success: true, data: svc }, 201);
});

// ─── PUT /api/shops/:shopId/services/:serviceId ───────────────────────────────

services.put("/:serviceId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!; const serviceId = c.req.param("serviceId")!;
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shopId) return c.json({ success: false, error: "Service not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    duration_min?: number;
    price_pence?: number;
    category?: string | null;
  }>();

  if (body.price_pence !== undefined && (!Number.isInteger(body.price_pence) || body.price_pence < 0)) {
    return c.json({ success: false, error: "price_pence must be a non-negative integer (pence)" }, 400);
  }

  await updateService(c.env.DB, serviceId, body);
  const updated = await getServiceById(c.env.DB, serviceId);
  return c.json({ success: true, data: updated });
});

// ─── DELETE /api/shops/:shopId/services/:serviceId (soft-delete) ──────────────

services.delete("/:serviceId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!; const serviceId = c.req.param("serviceId")!;
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shopId) return c.json({ success: false, error: "Service not found" }, 404);

  await updateService(c.env.DB, serviceId, { is_active: 0 });
  return c.json({ success: true });
});

export default services;
