import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  type DBService,
  getServicesByShop,
  getServiceById,
  createServiceStmt,
  updateServiceStmt,
  getShopBySlug,
  getShopById,
  getProductById,
  getServiceProducts,
  setServiceProductsStmts,
  getShopSiteByShopId,
} from "../db/queries.js";
import { batchWithAudit } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { normalizeServiceName, serviceDescriptionsByName } from "../lib/serviceCopy.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";

const services = new Hono<{ Bindings: Bindings }>();

/** Public API shape for booking UI (@repo/types Service). Money is pence (WS-4).
 *  The description is the generated copy for this service name, if any. */
export function toPublicService(row: DBService, descriptions?: Map<string, string>) {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    description: descriptions?.get(normalizeServiceName(row.name)) ?? "",
    durationMinutes: row.duration_min,
    price_pence: row.price_pence,
    category: row.category ?? "",
    isActive: row.is_active === 1,
    image_url: row.image_url ?? null,
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

  // One extra read joins the generated copy; a shop with no site yet simply
  // gets empty descriptions, exactly as before.
  const site = await getShopSiteByShopId(c.env.DB, shop.id);
  const descriptions = serviceDescriptionsByName(site?.services_json);
  return c.json({ success: true, data: list.map((row) => toPublicService(row, descriptions)) });
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
  const category = body.category ?? null;
  const refused = await batchWithAudit(
    c,
    [
      createServiceStmt(c.env.DB, {
        id,
        shop_id: shopId,
        name: body.name,
        duration_min: body.duration_min,
        price_pence: body.price_pence,
        category,
      }),
    ],
    {
      action: "service.create",
      outcome: "succeeded",
      shopId,
      entityType: "service",
      entityId: id,
      changes: fieldChanges(null, {
        name: body.name,
        duration_min: body.duration_min,
        price_pence: body.price_pence,
        category,
      }).changes,
    },
  );
  if (refused) return refused;

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

  // Only the columns the update builder writes, so a stray body key never
  // shows as "changed from null".
  const fields = {
    name: body.name,
    duration_min: body.duration_min,
    price_pence: body.price_pence,
    category: body.category,
    is_active: (body as { is_active?: number }).is_active,
  };
  const { changes, fields: changed } = fieldChanges(svc as unknown as Record<string, unknown>, fields);
  const refused = await batchWithAudit(
    c,
    [updateServiceStmt(c.env.DB, serviceId, fields)].filter((s) => s !== null),
    {
      action: "service.update",
      outcome: "succeeded",
      shopId,
      entityType: "service",
      entityId: serviceId,
      changes,
      details: changed.length > 0 ? { fields: changed } : null,
    },
  );
  if (refused) return refused;
  const updated = await getServiceById(c.env.DB, serviceId);
  return c.json({ success: true, data: updated });
});

// ─── Back-bar BOM (WS-3 Phase 2) ──────────────────────────────────────────────
// Products consumed each time this service is sold — the booking worker reads
// service_products at sale time and emits 'consumption' stock movements.

services.get("/:serviceId/products", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const serviceId = c.req.param("serviceId")!;
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shopId) return c.json({ success: false, error: "Service not found" }, 404);
  return c.json({ success: true, data: await getServiceProducts(c.env.DB, shopId, serviceId) });
});

services.put("/:serviceId/products", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const serviceId = c.req.param("serviceId")!;
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shopId) return c.json({ success: false, error: "Service not found" }, 404);

  const body = await c.req.json<{ products?: Array<{ product_id?: string; quantity?: number }> }>();
  if (!Array.isArray(body.products)) {
    return c.json({ success: false, error: "products is required (empty array clears the list)" }, 400);
  }
  if (body.products.length > 50) {
    return c.json({ success: false, error: "Too many products (max 50)" }, 400);
  }

  const entries: Array<{ product_id: string; quantity: number }> = [];
  const seen = new Set<string>();
  for (const p of body.products) {
    if (!p.product_id) return c.json({ success: false, error: "product_id is required on every entry" }, 400);
    if (seen.has(p.product_id)) return c.json({ success: false, error: "Duplicate product in list" }, 400);
    seen.add(p.product_id);
    const qty = p.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return c.json({ success: false, error: "quantity must be an integer between 1 and 1000" }, 400);
    }
    const product = await getProductById(c.env.DB, p.product_id);
    if (!product || product.shop_id !== shopId) {
      return c.json({ success: false, error: "Product not found" }, 404);
    }
    entries.push({ product_id: product.id, quantity: qty });
  }

  const refused = await batchWithAudit(c, setServiceProductsStmts(c.env.DB, shopId, serviceId, entries), {
    action: "service.update",
    outcome: "succeeded",
    shopId,
    entityType: "service_products",
    entityId: serviceId,
    details: { product_count: entries.length },
  });
  if (refused) return refused;
  return c.json({ success: true, data: await getServiceProducts(c.env.DB, shopId, serviceId) });
});

// ─── DELETE /api/shops/:shopId/services/:serviceId (soft-delete) ──────────────

services.delete("/:serviceId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!; const serviceId = c.req.param("serviceId")!;
  const svc = await getServiceById(c.env.DB, serviceId);
  if (!svc || svc.shop_id !== shopId) return c.json({ success: false, error: "Service not found" }, 404);

  const refused = await batchWithAudit(c, [updateServiceStmt(c.env.DB, serviceId, { is_active: 0 })!], {
    action: "service.delete",
    outcome: "succeeded",
    shopId,
    entityType: "service",
    entityId: serviceId,
    changes: { is_active: [svc.is_active, 0] },
  });
  if (refused) return refused;
  return c.json({ success: true });
});

export default services;
