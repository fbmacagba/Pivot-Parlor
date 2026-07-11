import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import {
  getShopById,
  getProductCategoriesByShop,
  getProductCategoryById,
  createProductCategory,
  updateProductCategory,
  getProductsWithStockByShop,
  getProductById,
  createProduct,
  updateProduct,
  getVariantsByProduct,
  getProductVariantById,
  createProductVariant,
  updateProductVariant,
  getStockLevelsByProduct,
  getSuppliersByShop,
  getSupplierById,
  createSupplier,
  updateSupplier,
} from "../db/queries.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";

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
  const body = await c.req.json<{ name?: string; sort_order?: number }>();
  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);

  const id = crypto.randomUUID();
  await createProductCategory(c.env.DB, {
    id,
    shop_id: shopId,
    name,
    sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
  });
  return c.json({ success: true, data: await getProductCategoryById(c.env.DB, id) }, 201);
});

productsRouter.put("/categories/:categoryId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const categoryId = c.req.param("categoryId")!;
  const cat = await getProductCategoryById(c.env.DB, categoryId);
  if (!cat || cat.shop_id !== shopId) {
    return c.json({ success: false, error: "Category not found" }, 404);
  }
  const body = await c.req.json<{ name?: string; sort_order?: number; is_active?: number }>();
  await updateProductCategory(c.env.DB, categoryId, {
    ...(body.name !== undefined ? { name: optStr(body.name) ?? cat.name } : {}),
    ...(Number.isInteger(body.sort_order) ? { sort_order: body.sort_order } : {}),
    ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  });
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

  const body = await c.req.json<{
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
  }>();

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
  try {
    await createProduct(c.env.DB, {
      id,
      shop_id: shopId,
      name,
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
    });
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

  const body = await c.req.json<{
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
  }>();

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

  try {
    await updateProduct(c.env.DB, productId, {
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
    });
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
  await updateProduct(c.env.DB, productId, { is_active: 0 });
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

  const body = await c.req.json<{
    name?: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
  }>();

  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);
  for (const key of ["cost_price_pence", "retail_price_pence"] as const) {
    if (body[key] !== undefined && !pence(body[key])) {
      return c.json({ success: false, error: `${key} must be a non-negative integer (pence)` }, 400);
    }
  }

  const id = crypto.randomUUID();
  try {
    await createProductVariant(c.env.DB, {
      id,
      product_id: productId,
      shop_id: shopId,
      name,
      sku: optStr(body.sku),
      barcode: optStr(body.barcode),
      cost_price_pence: body.cost_price_pence ?? product.cost_price_pence,
      retail_price_pence: body.retail_price_pence ?? product.retail_price_pence,
      attributes_json: optStr(body.attributes_json),
    });
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

  const body = await c.req.json<{
    name?: string;
    sku?: string | null;
    barcode?: string | null;
    cost_price_pence?: number;
    retail_price_pence?: number;
    attributes_json?: string | null;
    is_active?: number;
  }>();

  for (const key of ["cost_price_pence", "retail_price_pence"] as const) {
    if (body[key] !== undefined && !pence(body[key])) {
      return c.json({ success: false, error: `${key} must be a non-negative integer (pence)` }, 400);
    }
  }

  try {
    await updateProductVariant(c.env.DB, variantId, {
      ...(body.name !== undefined ? { name: optStr(body.name) ?? variant.name } : {}),
      ...(body.sku !== undefined ? { sku: optStr(body.sku) } : {}),
      ...(body.barcode !== undefined ? { barcode: optStr(body.barcode) } : {}),
      ...(body.cost_price_pence !== undefined ? { cost_price_pence: body.cost_price_pence } : {}),
      ...(body.retail_price_pence !== undefined ? { retail_price_pence: body.retail_price_pence } : {}),
      ...(body.attributes_json !== undefined ? { attributes_json: optStr(body.attributes_json) } : {}),
      ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
    });
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
  await updateProductVariant(c.env.DB, variantId, { is_active: 0 });
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
  const body = await c.req.json<{ name?: string; email?: string; phone?: string; notes?: string }>();
  const name = optStr(body.name);
  if (!name) return c.json({ success: false, error: "name is required" }, 400);

  const id = crypto.randomUUID();
  await createSupplier(c.env.DB, {
    id,
    shop_id: shopId,
    name,
    email: optStr(body.email),
    phone: optStr(body.phone),
    notes: optStr(body.notes),
  });
  return c.json({ success: true, data: await getSupplierById(c.env.DB, id) }, 201);
});

suppliersRouter.put("/:supplierId", authMiddleware, requireShopRole("admin"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const supplierId = c.req.param("supplierId")!;
  const sup = await getSupplierById(c.env.DB, supplierId);
  if (!sup || sup.shop_id !== shopId) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  const body = await c.req.json<{
    name?: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    is_active?: number;
  }>();
  await updateSupplier(c.env.DB, supplierId, {
    ...(body.name !== undefined ? { name: optStr(body.name) ?? sup.name } : {}),
    ...(body.email !== undefined ? { email: optStr(body.email) } : {}),
    ...(body.phone !== undefined ? { phone: optStr(body.phone) } : {}),
    ...(body.notes !== undefined ? { notes: optStr(body.notes) } : {}),
    ...(body.is_active === 0 || body.is_active === 1 ? { is_active: body.is_active } : {}),
  });
  return c.json({ success: true, data: await getSupplierById(c.env.DB, supplierId) });
});

export { productsRouter, suppliersRouter };
