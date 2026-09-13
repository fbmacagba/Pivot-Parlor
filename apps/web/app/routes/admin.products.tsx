import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { AlertTriangle, Boxes, Pencil, Plus, ToggleLeft, ToggleRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";

// ─── Types (worker rows are snake_case) ───────────────────────────────────────

interface Product {
  id: string;
  shop_id: string;
  category_id: string | null;
  name: string;
  brand: string | null;
  sku: string | null;
  cost_price_pence: number;
  retail_price_pence: number;
  track_stock: number;
  is_active: number;
  total_quantity: number;
}

interface Category {
  id: string;
  name: string;
}

interface LowStockRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  reorder_point: number;
  product_name: string;
  product_sku: string | null;
  variant_name: string | null;
}

type ActionData = { ok: true; intent: string } | { error: string };

// Manual movement types only — 'sale'/'consumption' belong to the POS and
// back-bar flows and the worker rejects them here.
const MOVEMENT_TYPES = [
  { value: "receive", label: "Receive stock (delivery)" },
  { value: "adjustment", label: "Adjustment (stock take)" },
  { value: "waste", label: "Waste / damage" },
  { value: "return", label: "Customer return" },
  { value: "transfer", label: "Transfer" },
] as const;

// ─── Shop ID resolution (matches admin.services.tsx pattern) ─────────────────

function resolveShopId(
  request: Request,
  user: SessionPayload,
  formShopId: string | null
): string | null {
  const url = new URL(request.url);
  if (user.role === "developer") {
    const fromForm = formShopId?.trim();
    const fromQuery = url.searchParams.get("shopId")?.trim();
    return fromForm || fromQuery || null;
  }
  return user.shop_id?.trim() || null;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = resolveShopId(request, user, null);

  let products: Product[] = [];
  let categories: Category[] = [];
  let lowStock: LowStockRow[] = [];
  if (shopId) {
    try {
      [products, categories, lowStock] = await Promise.all([
        api.get<Product[]>(`/api/shops/${shopId}/products`),
        api.get<Category[]>(`/api/shops/${shopId}/products/categories`),
        api.get<LowStockRow[]>(`/api/shops/${shopId}/inventory/low-stock`),
      ]);
    } catch {
      /* empty */
    }
  }

  return json({
    products,
    categories,
    lowStock,
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

/** Optional pounds field: empty = fallback, otherwise must parse. */
function poundsOrNull(raw: string, fallback: number | undefined): number | null | undefined {
  if (!raw.trim()) return fallback;
  return parsePoundsToPence(raw);
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "").trim();
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = resolveShopId(request, user, formShopId);

  if (!shopId) {
    return json<ActionData>(
      { error: "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL." },
      { status: 400 }
    );
  }

  const api = createApiClient(env.API_URL, token);

  // Category is free text: match an existing one by name or create it.
  async function resolveCategoryId(name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = await api.get<Category[]>(`/api/shops/${shopId}/products/categories`);
    const match = existing.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (match) return match.id;
    const created = await api.post<Category>(`/api/shops/${shopId}/products/categories`, {
      name: trimmed,
    });
    return created.id;
  }

  try {
    if (intent === "create" || intent === "update") {
      const name = String(form.get("name") ?? "").trim();
      if (!name) return json<ActionData>({ error: "Product name is required." }, { status: 400 });

      const cost = poundsOrNull(String(form.get("cost_price") ?? ""), 0);
      const retail = poundsOrNull(String(form.get("retail_price") ?? ""), 0);
      if (cost === null || retail === null) {
        return json<ActionData>({ error: "Prices must be valid amounts (e.g. 4.50)." }, { status: 400 });
      }

      const body = {
        name,
        brand: String(form.get("brand") ?? "").trim() || null,
        sku: String(form.get("sku") ?? "").trim() || null,
        cost_price_pence: cost,
        retail_price_pence: retail,
        track_stock: form.get("track_stock") === "on" ? 1 : 0,
        category_id: await resolveCategoryId(String(form.get("category") ?? "")),
      };

      if (intent === "create") {
        await api.post(`/api/shops/${shopId}/products`, body);
      } else {
        const productId = String(form.get("productId") ?? "").trim();
        if (!productId) return json<ActionData>({ error: "Missing product ID." }, { status: 400 });
        await api.put(`/api/shops/${shopId}/products/${productId}`, body);
      }
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "deactivate" || intent === "restore") {
      const productId = String(form.get("productId") ?? "").trim();
      if (!productId) return json<ActionData>({ error: "Missing product ID." }, { status: 400 });
      if (intent === "deactivate") {
        await api.del(`/api/shops/${shopId}/products/${productId}`);
      } else {
        await api.put(`/api/shops/${shopId}/products/${productId}`, { is_active: 1 });
      }
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "movement") {
      const productId = String(form.get("productId") ?? "").trim();
      const type = String(form.get("type") ?? "").trim();
      const qtyStr = String(form.get("quantity_delta") ?? "").trim();
      const quantity = Number(qtyStr);
      if (!productId || !type) return json<ActionData>({ error: "Missing movement data." }, { status: 400 });
      if (!qtyStr || !Number.isInteger(quantity) || quantity === 0) {
        return json<ActionData>(
          { error: "Quantity must be a non-zero whole number (negative to remove stock)." },
          { status: 400 }
        );
      }
      const unitCostStr = String(form.get("unit_cost") ?? "").trim();
      const unitCost = unitCostStr ? parsePoundsToPence(unitCostStr) : undefined;
      if (unitCost === null) {
        return json<ActionData>({ error: "Unit cost must be a valid amount (e.g. 3.20)." }, { status: 400 });
      }

      await api.post(`/api/shops/${shopId}/inventory/movements`, {
        product_id: productId,
        type,
        quantity_delta: quantity,
        ...(unitCost !== undefined ? { unit_cost_pence: unitCost } : {}),
        note: String(form.get("note") ?? "").trim() || null,
      });
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "reorder") {
      const productId = String(form.get("productId") ?? "").trim();
      const point = Number(String(form.get("reorder_point") ?? "").trim());
      const qty = Number(String(form.get("reorder_qty") ?? "").trim());
      if (!productId) return json<ActionData>({ error: "Missing product ID." }, { status: 400 });
      if (!Number.isInteger(point) || point < 0 || !Number.isInteger(qty) || qty < 0) {
        return json<ActionData>(
          { error: "Reorder point and quantity must be whole numbers (0 or more)." },
          { status: 400 }
        );
      }
      await api.put(`/api/shops/${shopId}/inventory/reorder`, {
        product_id: productId,
        reorder_point: point,
        reorder_qty: qty,
      });
      return json<ActionData>({ ok: true, intent });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed";
    return json<ActionData>({ error: msg }, { status: 400 });
  }

  return json<ActionData>({ error: "Unknown action." }, { status: 400 });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminProducts() {
  const { products, categories, lowStock, shopId, developerNeedsShop } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";

  const [addOpen, setAddOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [stockProduct, setStockProduct] = useState<Product | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    if (actionData && "ok" in actionData) {
      setAddOpen(false);
      setEditProduct(null);
      setStockProduct(null);
    }
  }, [actionData]);

  const active = products.filter((p) => p.is_active === 1);
  const inactive = products.filter((p) => p.is_active !== 1);
  const displayed = showInactive ? products : active;
  const lowProductIds = new Set(lowStock.map((r) => r.product_id));
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "";

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Products</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {active.length} active
            {inactive.length > 0 && ` · ${inactive.length} inactive`}
            {lowStock.length > 0 && ` · ${lowStock.length} low on stock`}
          </p>
        </div>

        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={developerNeedsShop}>
              <Plus className="h-4 w-4" /> Add product
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New product</DialogTitle>
            </DialogHeader>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="create" />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <ProductFields categories={categories} />
              {actionData && "error" in actionData && (
                <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
              )}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Save product →"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Developer hint */}
      {developerNeedsShop && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage products as a developer.
        </div>
      )}

      {/* Low stock banner */}
      {lowStock.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <AlertTriangle className="h-4 w-4" /> Low stock
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-100/80">
            {lowStock.map((row) => (
              <li key={row.id}>
                {row.product_name}
                {row.variant_name && ` — ${row.variant_name}`}
                {row.product_sku && <span className="text-amber-100/50"> ({row.product_sku})</span>}
                : <span className="font-semibold">{row.quantity}</span> left
                {row.reorder_point > 0 && ` (reorder at ${row.reorder_point})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editProduct} onOpenChange={(open) => { if (!open) setEditProduct(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit product</DialogTitle>
          </DialogHeader>
          {editProduct && (
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="productId" value={editProduct.id} />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <ProductFields
                product={editProduct}
                categories={categories}
                categoryDefault={categoryName(editProduct.category_id)}
              />
              {actionData && "error" in actionData && (
                <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
              )}
              <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Update product →"}
              </Button>
            </Form>
          )}
        </DialogContent>
      </Dialog>

      {/* Stock dialog */}
      <Dialog open={!!stockProduct} onOpenChange={(open) => { if (!open) setStockProduct(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stock — {stockProduct?.name}</DialogTitle>
          </DialogHeader>
          {stockProduct && (
            <div className="space-y-6">
              <p className="text-sm text-white/55">
                On hand: <span className="font-semibold text-white">{stockProduct.total_quantity}</span>
              </p>

              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="movement" />
                <input type="hidden" name="productId" value={stockProduct.id} />
                {shopId && <input type="hidden" name="shopId" value={shopId} />}
                <label className="block text-sm text-white/70">
                  Movement type
                  <select
                    name="type"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-3 py-2 text-sm text-white"
                    defaultValue="receive"
                  >
                    {MOVEMENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Quantity (±) *"
                    name="quantity_delta"
                    type="number"
                    step="1"
                    placeholder="e.g. 12 or -3"
                    required
                  />
                  <Input
                    label="Unit cost (£)"
                    name="unit_cost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </div>
                <Input label="Note" name="note" placeholder="e.g. May delivery" />
                {actionData && "error" in actionData && (
                  <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
                )}
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Saving…" : "Record movement →"}
                </Button>
              </Form>

              <Form method="post" className="space-y-3 border-t border-white/10 pt-4">
                <input type="hidden" name="intent" value="reorder" />
                <input type="hidden" name="productId" value={stockProduct.id} />
                {shopId && <input type="hidden" name="shopId" value={shopId} />}
                <p className="text-xs font-semibold uppercase tracking-widest text-white/50">
                  Low-stock alert
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Reorder point"
                    name="reorder_point"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue="0"
                  />
                  <Input
                    label="Reorder quantity"
                    name="reorder_qty"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue="0"
                  />
                </div>
                <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Saving…" : "Save alert level"}
                </Button>
              </Form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Toggle inactive */}
      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((v) => !v)}
          className="tap-target mb-4 inline-flex items-center text-xs text-white/60 hover:text-gold transition-colors"
        >
          {showInactive ? "Hide inactive" : `Show ${inactive.length} inactive`}
        </button>
      )}

      {/* Product list */}
      {displayed.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-12 text-center text-white/60">
          <p className="text-lg">No products yet.</p>
          <p className="mt-1 text-sm">Add retail or back-bar products to track stock and sell at the counter.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayed.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              shopId={shopId}
              categoryName={categoryName(product.category_id)}
              isLow={lowProductIds.has(product.id)}
              onEdit={() => setEditProduct(product)}
              onStock={() => setStockProduct(product)}
              isSubmitting={isSubmitting}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ProductRow ───────────────────────────────────────────────────────────────

function ProductRow({
  product,
  shopId,
  categoryName,
  isLow,
  onEdit,
  onStock,
  isSubmitting,
}: {
  product: Product;
  shopId: string | null;
  categoryName: string;
  isLow: boolean;
  onEdit: () => void;
  onStock: () => void;
  isSubmitting: boolean;
}) {
  const inactive = product.is_active !== 1;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 transition-colors ${
        inactive
          ? "border-white/5 bg-white/3 opacity-50"
          : "border-white/10 bg-dark-100 hover:border-white/20"
      }`}
    >
      {/* Info */}
      <div className="min-w-[9rem] flex-1">
        <p className="truncate text-sm font-medium text-white">
          {product.name}
          {inactive && <span className="ml-2 text-xs text-white/50">(inactive)</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-white/60">
          {[product.brand, product.sku, categoryName].filter(Boolean).join(" · ")}
        </p>
      </div>

      {/* Stock + price: right-aligned, on their own line when a phone needs the room */}
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <div className="text-right">
          {product.track_stock === 1 ? (
            <p className={`text-sm font-semibold ${isLow ? "text-amber-400" : "text-white"}`}>
              {product.total_quantity} in stock
              {isLow && <AlertTriangle className="ml-1 inline h-3 w-3" />}
            </p>
          ) : (
            <p className="text-sm text-white/50">untracked</p>
          )}
          <p className="text-xs text-white/60">cost {formatPence(product.cost_price_pence)}</p>
        </div>
        <div className="w-20 text-right">
          <p className="text-sm font-semibold text-gold">{formatPence(product.retail_price_pence)}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onStock}
          className="tap-target flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white transition-colors"
        >
          <Boxes className="h-3 w-3" /> Stock
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="tap-target flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white transition-colors"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>

        <Form method="post">
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="intent" value={inactive ? "restore" : "deactivate"} />
          <button
            type="submit"
            disabled={isSubmitting}
            className={`tap-target flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              inactive
                ? "border-green-500/30 text-green-400 hover:bg-green-500/10"
                : "border-red-500/20 text-red-400/80 hover:bg-red-500/10"
            }`}
          >
            {inactive ? (
              <><ToggleRight className="h-3 w-3" /> Restore</>
            ) : (
              <><ToggleLeft className="h-3 w-3" /> Deactivate</>
            )}
          </button>
        </Form>
      </div>
    </div>
  );
}

// ─── ProductFields ────────────────────────────────────────────────────────────

function ProductFields({
  product,
  categories,
  categoryDefault,
}: {
  product?: Product;
  categories: Category[];
  categoryDefault?: string;
}) {
  return (
    <>
      <Input
        label="Product name *"
        name="name"
        defaultValue={product?.name ?? ""}
        placeholder="e.g. Sea Salt Spray 250ml"
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Brand"
          name="brand"
          defaultValue={product?.brand ?? ""}
          placeholder="e.g. Coastal"
        />
        <Input
          label="SKU"
          name="sku"
          defaultValue={product?.sku ?? ""}
          placeholder="e.g. SSS-250"
        />
      </div>
      <Input
        label="Category"
        name="category"
        defaultValue={categoryDefault ?? ""}
        placeholder="e.g. Styling, Retail, Back bar"
        list="product-categories"
      />
      <datalist id="product-categories">
        {categories.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Cost price (£)"
          name="cost_price"
          type="number"
          defaultValue={product ? (product.cost_price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
          min="0"
          step="0.01"
        />
        <Input
          label="Retail price (£)"
          name="retail_price"
          type="number"
          defaultValue={product ? (product.retail_price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
          min="0"
          step="0.01"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-white/70">
        <input
          type="checkbox"
          name="track_stock"
          defaultChecked={product ? product.track_stock === 1 : true}
          className="h-4 w-4 rounded border-white/20 bg-dark-100"
        />
        Track stock levels
      </label>
    </>
  );
}
