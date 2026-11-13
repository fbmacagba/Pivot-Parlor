import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getShopById,
  getProductCategoriesByShop,
  getProductCategoryById,
  createProductCategoryStmt,
  updateProductCategoryStmt,
  getProductsWithStockByShop,
  getProductById,
  createProductStmt,
  updateProductStmt,
  getVariantsByProduct,
  getProductVariantById,
  createProductVariantStmt,
  updateProductVariantStmt,
  getStockLevelsByProduct,
  getSuppliersByShop,
  getSupplierById,
  createSupplierStmt,
  updateSupplierStmt,
} from "../db/queries.js";
import { auditShopId, batchWithAudit, UNRESOLVED_SHOP } from "../audit/context.js";
import { fieldChanges } from "../audit/diff.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { readJsonObject } from "@repo/utils";

/**
 * WS-3 Phase 0: product catalogue. Nothing here is public — the catalogue is
 * shop-internal (no online retail yet). Staff can read (counter lookups);
 * mutations are admin-only. Money is INTEGER pence (WS-4).
 */

const UNIQUE_RE = /UNIQUE constraint failed/i;

function pence(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Optional string field: trim, empty string becomes null. */
function optStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ─── /api/shops/:shopId/products ──────────────────────────────────────────────

const productsRouter = new Hono<{ Bindings: Bindings }>();

// Static subpaths (/categories) are registered before /:productId; Hono gives
// static segments priority over params, so "categories" never resolves as an id.

productsRouter.get("/categories", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const list = await getProductCategoriesByShop(c.env.DB, shopId);
  return c.json({ success: true, data: list });
});

productsRouter.post("/categories", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await readJsonObject<{ name?: string; sort_order?: number }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);

  const id = crypto.randomUUID();
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : 0;
  // Developers pass requireShopRole without a shop check: the entry records
  // the shop only once it resolves (never the raw param).
  const auditShop = await auditShopId(c, shopId);
  const refused = await batchWithAudit(
    c,
    [createProductCategoryStmt(c.env.DB, { id, shop_id: shopId, name, sort_order: sortOrder })],
    {
      action: "product.create",
      outcome: "succeeded",
      shopId: auditShop,
      entityType: "product_category",
      entityId: id,
      changes: fieldChanges(null, { name, sort_order: sortOrder }).changes,
      ...(auditShop ? {} : { details: UNRESOLVED_SHOP }),
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: await getProductCategoryById(c.env.DB, id) }, 201);
});

productsRouter.put("/categories/:categoryId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const categoryId = c.req.param("categoryId")!;
  const cat = await getProductCategoryById(c.env.DB, categoryId);
  if (!cat || cat.shop_id !== shopId) {
    return c.json({ success: false, error: "Category not found" }, 404);
  }
  const body = await readJsonObject<{ name?: string; sort_order?: number; is_active?: number }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const fields = {
    ...(body.name !== undefined ? { name: optStr(body.name) ?? cat.name } : {}),
    ...(Number.isInteger(body.sort_order) ? { sort_order: body.sort_order } : {}),
    ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  };
  const { changes, fields: changed } = fieldChanges(cat as unknown as Record<string, unknown>, fields);
  const refused = await batchWithAudit(
    c,
    [updateProductCategoryStmt(c.env.DB, categoryId, fields)].filter((s) => s !== null),
    {
      action: "product.update",
      outcome: "succeeded",
      shopId,
      entityType: "product_category",
      entityId: categoryId,
      changes,
      details: changed.length > 0 ? { fields: changed } : null,
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: await getProductCategoryById(c.env.DB, categoryId) });
});

productsRouter.get("/", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const list = await getProductsWithStockByShop(c.env.DB, shopId);
  return c.json({ success: true, data: list });
});

productsRouter.post("/", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const shop = await getShopById(c.env.DB, shopId);
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const body = await readJsonObject<{
    name?: string;
    category_id?: string | null;
    supplier_id?: string | null;
    description?: string | null;
    brand?: string | null;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    tax_rate_bps?: number;
    is_professional?: number;
    track_stock?: number;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);
  if (body.cost_price_pence !== undefined && !pence(body.cost_price_pence)) {
    return c.json({ success: false, error: "cost_price_pence must be a non-negative integer (pence)" }, 400);
  }
  if (body.retail_price_pence !== undefined && !pence(body.retail_price_pence)) {
    return c.json({ success: false, error: "retail_price_pence must be a non-negative integer (pence)" }, 400);
  }
  if (
    body.tax_rate_bps !== undefined &&
    (!Number.isInteger(body.tax_rate_bps) || body.tax_rate_bps < 0 || body.tax_rate_bps > 10000)
  ) {
    return c.json({ success: false, error: "tax_rate_bps must be an integer between 0 and 10000" }, 400);
  }
  if (body.category_id) {
    const cat = await getProductCategoryById(c.env.DB, body.category_id);
    if (!cat || cat.shop_id !== shopId) {
      return c.json({ success: false, error: "Category not found" }, 400);
    }
  }
  if (body.supplier_id) {
    const sup = await getSupplierById(c.env.DB, body.supplier_id);
    if (!sup || sup.shop_id !== shopId) {
      return c.json({ success: false, error: "Supplier not found" }, 400);
    }
  }

  const id = crypto.randomUUID();
  const row = {
    category_id: body.category_id ?? null,
    supplier_id: body.supplier_id ?? null,
    description: optStr(body.description),
    brand: optStr(body.brand),
    sku: optStr(body.sku),
    barcode: optStr(body.barcode),
    cost_price_pence: body.cost_price_pence ?? 0,
    retail_price_pence: body.retail_price_pence ?? 0,
    tax_rate_bps: body.tax_rate_bps ?? 0,
    is_professional: body.is_professional === 1 ? 1 : 0,
    track_stock: body.track_stock === 0 ? 0 : 1,
  };
  try {
    const refused = await batchWithAudit(
      c,
      [createProductStmt(c.env.DB, { id, shop_id: shopId, name, ...row })],
      {
        action: "product.create",
        outcome: "succeeded",
        shopId,
        entityType: "product",
        entityId: id,
        changes: fieldChanges(null, { name, ...row }).changes,
      },
    );
    if (refused) return refused;
  } catch (err) {
    if (UNIQUE_RE.test(String(err))) {
      return c.json({ success: false, error: "SKU already in use in this shop" }, 409);
    }
    throw err;
  }
  return c.json({ success: true, data: await getProductById(c.env.DB, id) }, 201);
});

productsRouter.get("/:productId", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const product = await getProductById(c.env.DB, productId);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  const [variants, stock] = await Promise.all([
    getVariantsByProduct(c.env.DB, productId),
    getStockLevelsByProduct(c.env.DB, shopId, productId),
  ]);
  return c.json({ success: true, data: { ...product, variants, stock } });
});

productsRouter.put("/:productId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const product = await getProductById(c.env.DB, productId);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }

  const body = await readJsonObject<{
    name?: string;
    category_id?: string | null;
    supplier_id?: string | null;
    description?: string | null;
    brand?: string | null;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    tax_rate_bps?: number;
    is_professional?: number;
    track_stock?: number;
    is_active?: number;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  for (const key of ["cost_price_pence", "retail_price_pence"] as const) {
    if (body[key] !== undefined && !pence(body[key])) {
      return c.json({ success: false, error: `${key} must be a non-negative integer (pence)` }, 400);
    }
  }
  if (
    body.tax_rate_bps !== undefined &&
    (!Number.isInteger(body.tax_rate_bps) || body.tax_rate_bps < 0 || body.tax_rate_bps > 10000)
  ) {
    return c.json({ success: false, error: "tax_rate_bps must be an integer between 0 and 10000" }, 400);
  }
  if (body.category_id) {
    const cat = await getProductCategoryById(c.env.DB, body.category_id);
    if (!cat || cat.shop_id !== shopId) {
      return c.json({ success: false, error: "Category not found" }, 400);
    }
  }
  if (body.supplier_id) {
    const sup = await getSupplierById(c.env.DB, body.supplier_id);
    if (!sup || sup.shop_id !== shopId) {
      return c.json({ success: false, error: "Supplier not found" }, 400);
    }
  }

  // Only the columns the update writes, so a stray body key never shows as changed.
  const fields = {
      ...(body.name !== undefined ? { name: optStr(body.name) ?? product.name } : {}),
      ...(body.category_id !== undefined ? { category_id: body.category_id } : {}),
      ...(body.supplier_id !== undefined ? { supplier_id: body.supplier_id } : {}),
      ...(body.description !== undefined ? { description: optStr(body.description) } : {}),
      ...(body.brand !== undefined ? { brand: optStr(body.brand) } : {}),
      ...(body.sku !== undefined ? { sku: optStr(body.sku) } : {}),
      ...(body.barcode !== undefined ? { barcode: optStr(body.barcode) } : {}),
      ...(body.cost_price_pence !== undefined ? { cost_price_pence: body.cost_price_pence } : {}),
      ...(body.retail_price_pence !== undefined ? { retail_price_pence: body.retail_price_pence } : {}),
      ...(body.tax_rate_bps !== undefined ? { tax_rate_bps: body.tax_rate_bps } : {}),
      ...(body.is_professional !== undefined ? { is_professional: body.is_professional === 1 ? 1 : 0 } : {}),
      ...(body.track_stock !== undefined ? { track_stock: body.track_stock === 0 ? 0 : 1 } : {}),
      ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  };
  const { changes, fields: changed } = fieldChanges(product as unknown as Record<string, unknown>, fields);
  try {
    const refused = await batchWithAudit(
      c,
      [updateProductStmt(c.env.DB, productId, fields)].filter((s) => s !== null),
      {
        action: "product.update",
        outcome: "succeeded",
        shopId,
        entityType: "product",
        entityId: productId,
        changes,
        details: changed.length > 0 ? { fields: changed } : null,
      },
    );
    if (refused) return refused;
  } catch (err) {
    if (UNIQUE_RE.test(String(err))) {
      return c.json({ success: false, error: "SKU already in use in this shop" }, 409);
    }
    throw err;
  }
  return c.json({ success: true, data: await getProductById(c.env.DB, productId) });
});

// Soft-delete (is_active = 0), same convention as services.
productsRouter.delete("/:productId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const product = await getProductById(c.env.DB, productId);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  const refused = await batchWithAudit(c, [updateProductStmt(c.env.DB, productId, { is_active: 0 })!], {
    action: "product.delete",
    outcome: "succeeded",
    shopId,
    entityType: "product",
    entityId: productId,
    // Diffed, so deleting an already inactive product records no change.
    changes: fieldChanges(product as unknown as Record<string, unknown>, { is_active: 0 }).changes,
  });
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── Variants ─────────────────────────────────────────────────────────────────

productsRouter.get("/:productId/variants", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const product = await getProductById(c.env.DB, productId);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }
  return c.json({ success: true, data: await getVariantsByProduct(c.env.DB, productId) });
});

productsRouter.post("/:productId/variants", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const product = await getProductById(c.env.DB, productId);
  if (!product || product.shop_id !== shopId) {
    return c.json({ success: false, error: "Product not found" }, 404);
  }

  const body = await readJsonObject<{
    name?: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);
  for (const key of ["cost_price_pence", "retail_price_pence"] as const) {
    if (body[key] !== undefined && !pence(body[key])) {
      return c.json({ success: false, error: `${key} must be a non-negative integer (pence)` }, 400);
    }
  }

  const id = crypto.randomUUID();
  const row = {
    sku: optStr(body.sku),
    barcode: optStr(body.barcode),
    cost_price_pence: body.cost_price_pence ?? product.cost_price_pence,
    retail_price_pence: body.retail_price_pence ?? product.retail_price_pence,
    attributes_json: optStr(body.attributes_json),
  };
  try {
    const refused = await batchWithAudit(
      c,
      [createProductVariantStmt(c.env.DB, { id, product_id: productId, shop_id: shopId, name, ...row })],
      {
        action: "product.create",
        outcome: "succeeded",
        shopId,
        entityType: "product_variant",
        entityId: id,
        changes: fieldChanges(null, { name, ...row }).changes,
        details: { product_id: productId },
      },
    );
    if (refused) return refused;
  } catch (err) {
    if (UNIQUE_RE.test(String(err))) {
      return c.json({ success: false, error: "SKU already in use in this shop" }, 409);
    }
    throw err;
  }
  return c.json({ success: true, data: await getProductVariantById(c.env.DB, id) }, 201);
});

productsRouter.put("/:productId/variants/:variantId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const variantId = c.req.param("variantId")!;
  const variant = await getProductVariantById(c.env.DB, variantId);
  if (!variant || variant.shop_id !== shopId || variant.product_id !== productId) {
    return c.json({ success: false, error: "Variant not found" }, 404);
  }

  const body = await readJsonObject<{
    name?: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
    is_active?: number;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  for (const key of ["cost_price_pence", "retail_price_pence"] as const) {
    if (body[key] !== undefined && !pence(body[key])) {
      return c.json({ success: false, error: `${key} must be a non-negative integer (pence)` }, 400);
    }
  }

  // Only the columns the update writes, so a stray body key never shows as changed.
  const fields = {
    ...(body.name !== undefined ? { name: optStr(body.name) ?? variant.name } : {}),
    ...(body.sku !== undefined ? { sku: optStr(body.sku) } : {}),
    ...(body.barcode !== undefined ? { barcode: optStr(body.barcode) } : {}),
    ...(body.cost_price_pence !== undefined ? { cost_price_pence: body.cost_price_pence } : {}),
    ...(body.retail_price_pence !== undefined ? { retail_price_pence: body.retail_price_pence } : {}),
    ...(body.attributes_json !== undefined ? { attributes_json: optStr(body.attributes_json) } : {}),
    ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  };
  const { changes, fields: changed } = fieldChanges(variant as unknown as Record<string, unknown>, fields);
  try {
    const refused = await batchWithAudit(
      c,
      [updateProductVariantStmt(c.env.DB, variantId, fields)].filter((s) => s !== null),
      {
        action: "product.update",
        outcome: "succeeded",
        shopId,
        entityType: "product_variant",
        entityId: variantId,
        changes,
        details: changed.length > 0 ? { fields: changed } : null,
      },
    );
    if (refused) return refused;
  } catch (err) {
    if (UNIQUE_RE.test(String(err))) {
      return c.json({ success: false, error: "SKU already in use in this shop" }, 409);
    }
    throw err;
  }
  return c.json({ success: true, data: await getProductVariantById(c.env.DB, variantId) });
});

productsRouter.delete("/:productId/variants/:variantId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const productId = c.req.param("productId")!;
  const variantId = c.req.param("variantId")!;
  const variant = await getProductVariantById(c.env.DB, variantId);
  if (!variant || variant.shop_id !== shopId || variant.product_id !== productId) {
    return c.json({ success: false, error: "Variant not found" }, 404);
  }
  const refused = await batchWithAudit(c, [updateProductVariantStmt(c.env.DB, variantId, { is_active: 0 })!], {
    action: "product.delete",
    outcome: "succeeded",
    shopId,
    entityType: "product_variant",
    entityId: variantId,
    changes: fieldChanges(variant as unknown as Record<string, unknown>, { is_active: 0 }).changes,
  });
  if (refused) return refused;
  return c.json({ success: true });
});

// ─── /api/shops/:shopId/suppliers ─────────────────────────────────────────────

const suppliersRouter = new Hono<{ Bindings: Bindings }>();

suppliersRouter.get("/", authMiddleware, requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  return c.json({ success: true, data: await getSuppliersByShop(c.env.DB, shopId) });
});

suppliersRouter.post("/", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const body = await readJsonObject<{ name?: string; email?: string; phone?: string; notes?: string }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);

  const id = crypto.randomUUID();
  const row = { email: optStr(body.email), phone: optStr(body.phone), notes: optStr(body.notes) };
  // Developers pass requireShopRole without a shop check: the entry records
  // the shop only once it resolves (never the raw param).
  const auditShop = await auditShopId(c, shopId);
  const refused = await batchWithAudit(
    c,
    [createSupplierStmt(c.env.DB, { id, shop_id: shopId, name, ...row })],
    {
      action: "inventory.supplier.create",
      outcome: "succeeded",
      shopId: auditShop,
      entityType: "supplier",
      entityId: id,
      // Names only: every supplier column except is_active is personal or free text.
      details: { fields: fieldChanges(null, { name, ...row }).fields, ...(auditShop ? {} : UNRESOLVED_SHOP) },
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: await getSupplierById(c.env.DB, id) }, 201);
});

suppliersRouter.put("/:supplierId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const supplierId = c.req.param("supplierId")!;
  const sup = await getSupplierById(c.env.DB, supplierId);
  if (!sup || sup.shop_id !== shopId) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  const body = await readJsonObject<{
    name?: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    is_active?: number;
  }>(c.req);
  if (!body) {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const fields = {
    ...(body.name !== undefined ? { name: optStr(body.name) ?? sup.name } : {}),
    ...(body.email !== undefined ? { email: optStr(body.email) } : {}),
    ...(body.phone !== undefined ? { phone: optStr(body.phone) } : {}),
    ...(body.notes !== undefined ? { notes: optStr(body.notes) } : {}),
    ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  };
  const { changes, fields: changed } = fieldChanges(sup as unknown as Record<string, unknown>, fields);
  const refused = await batchWithAudit(
    c,
    [updateSupplierStmt(c.env.DB, supplierId, fields)].filter((s) => s !== null),
    {
      action: "inventory.supplier.update",
      outcome: "succeeded",
      shopId,
      entityType: "supplier",
      entityId: supplierId,
      changes,
      details: changed.length > 0 ? { fields: changed } : null,
    },
  );
  if (refused) return refused;
  return c.json({ success: true, data: await getSupplierById(c.env.DB, supplierId) });
});

export { productsRouter, suppliersRouter };
