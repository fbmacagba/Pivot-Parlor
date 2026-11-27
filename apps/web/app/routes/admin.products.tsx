import { useFetcher, useLoaderData, useLocation, useSearchParams, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { AlertTriangle, Boxes, Pencil, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { ErrorScreen } from "~/components/ErrorScreen";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/Dialog";
import { MOVEMENT_TYPES, movementType, signedQuantityDelta } from "~/components/admin/stockMovement";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Products");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

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
  /** 0 or 1. */
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

interface StockLevelRow {
  variant_id: string | null;
  reorder_point: number;
  reorder_qty: number;
}

/** A product's own low-stock alert levels, loaded when its stock dialog opens. */
interface AlertLevels {
  productId: string;
  reorder_point: number;
  reorder_qty: number;
}

/** Every answer names the intent it is for, so a dialog only shows its own outcome. */
type ActionData =
  | { ok: true; intent: string; message: string }
  | { ok: false; intent: string; error: string };

/** How many products the list shows before "Show more". */
const PAGE_SIZE = 50;

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);

  let products: Product[] = [];
  let categories: Category[] = [];
  let lowStock: LowStockRow[] = [];
  let loadError = false;
  let lowStockError = false;
  let alertLevels: AlertLevels | null = null;
  let alertLevelsError = false;

  // The stock dialog asks for one product's alert levels (?alertLevelsFor=):
  // the list does not carry them, and the form must open on the real values.
  const alertLevelsFor = new URL(request.url).searchParams.get("alertLevelsFor");
  if (shopId && alertLevelsFor) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(alertLevelsFor)) {
      alertLevelsError = true;
    } else {
      try {
        const detail = await api.get<{ stock?: StockLevelRow[] }>(`/api/shops/${shopId}/products/${alertLevelsFor}`);
        // The page sets the product's own level (no variant). No row yet means none set.
        const level = (detail.stock ?? []).find((row) => row.variant_id === null);
        alertLevels = {
          productId: alertLevelsFor,
          reorder_point: level?.reorder_point ?? 0,
          reorder_qty: level?.reorder_qty ?? 0,
        };
      } catch {
        alertLevelsError = true;
      }
    }
  } else if (shopId) {
    // Deactivated products come too, so the owner can restore one.
    const [productsRes, categoriesRes, lowStockRes] = await Promise.allSettled([
      api.get<Product[]>(`/api/shops/${shopId}/products?include_inactive=1`),
      api.get<Category[]>(`/api/shops/${shopId}/products/categories`),
      api.get<LowStockRow[]>(`/api/shops/${shopId}/inventory/low-stock`),
    ]);
    // Editing a product fills its category from the category list, so a list
    // without its categories is not safe to edit: both count as the list failing.
    if (productsRes.status === "fulfilled" && categoriesRes.status === "fulfilled") {
      products = productsRes.value;
      categories = categoriesRes.value;
    } else {
      loadError = true;
    }
    if (lowStockRes.status === "fulfilled") lowStock = lowStockRes.value;
    else lowStockError = true;
  }

  return json({
    products,
    categories,
    lowStock,
    shopId,
    loadError,
    lowStockError,
    alertLevels,
    alertLevelsError,
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
  const fail = (intent: string, error: string, status = 400) =>
    json<ActionData>({ ok: false, intent, error }, { status });
  const done = (intent: string, message: string) => json<ActionData>({ ok: true, intent, message });
  if (!token) return fail("", "You are signed out. Sign in again to continue.", 401);

  const form = await readFormData(request);
  if (!form) return fail("", UNREADABLE_FORM);
  const intent = String(form.get("intent") ?? "").trim();
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = pageShopId(request, user, formShopId);

  if (!shopId) {
    return fail(intent, "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL.");
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

  const missingProduct = "That product could not be found. Reload the page and try again.";

  try {
    if (intent === "create" || intent === "update") {
      const name = String(form.get("name") ?? "").trim();
      if (!name) return fail(intent, "Enter a name for the product.");
      const productId = String(form.get("productId") ?? "").trim();
      if (intent === "update" && !productId) return fail(intent, missingProduct);

      const cost = poundsOrNull(String(form.get("cost_price") ?? ""), 0);
      const retail = poundsOrNull(String(form.get("retail_price") ?? ""), 0);
      if (cost === null || retail === null) {
        return fail(intent, "Enter prices in pounds, for example 4.50.");
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
        return done(intent, `${name} added.`);
      }
      await api.put(`/api/shops/${shopId}/products/${productId}`, body);
      return done(intent, `${name} saved.`);
    }

    if (intent === "deactivate" || intent === "restore") {
      const productId = String(form.get("productId") ?? "").trim();
      if (!productId) return fail(intent, missingProduct);
      if (intent === "deactivate") {
        await api.del(`/api/shops/${shopId}/products/${productId}`);
        return done(intent, "Product deactivated. Restore it from the inactive list.");
      }
      await api.put(`/api/shops/${shopId}/products/${productId}`, { is_active: 1 });
      return done(intent, "Product restored.");
    }

    if (intent === "movement") {
      const productId = String(form.get("productId") ?? "").trim();
      const type = String(form.get("type") ?? "").trim();
      if (!productId) return fail(intent, missingProduct);
      // The person types how many; the type (or their add/remove choice) gives the sign.
      const signed = signedQuantityDelta(type, String(form.get("quantity") ?? ""), String(form.get("direction") ?? ""));
      if (!signed.ok) return fail(intent, signed.error);

      const unitCostStr = String(form.get("unit_cost") ?? "").trim();
      const unitCost = unitCostStr ? parsePoundsToPence(unitCostStr) : undefined;
      if (unitCost === null) {
        return fail(intent, "Enter the unit cost in pounds, for example 3.20.");
      }

      await api.post(`/api/shops/${shopId}/inventory/movements`, {
        product_id: productId,
        type,
        quantity_delta: signed.delta,
        ...(unitCost !== undefined ? { unit_cost_pence: unitCost } : {}),
        note: String(form.get("note") ?? "").trim() || null,
      });
      const amount = Math.abs(signed.delta);
      return done(intent, signed.delta > 0 ? `${amount} added to stock.` : `${amount} removed from stock.`);
    }

    if (intent === "reorder") {
      const productId = String(form.get("productId") ?? "").trim();
      const pointStr = String(form.get("reorder_point") ?? "").trim();
      const qtyStr = String(form.get("reorder_qty") ?? "").trim();
      if (!productId) return fail(intent, missingProduct);
      if (!/^\d{1,7}$/.test(pointStr) || !/^\d{1,7}$/.test(qtyStr)) {
        return fail(intent, "Enter both alert levels as whole numbers, 0 or more.");
      }
      await api.put(`/api/shops/${shopId}/inventory/reorder`, {
        product_id: productId,
        reorder_point: Number(pointStr),
        reorder_qty: Number(qtyStr),
      });
      return done(intent, "Low stock alert saved.");
    }
  } catch (e) {
    return fail(intent, e instanceof Error ? e.message : "That could not be saved. Try again.");
  }

  return fail(intent, "That action is not recognised. Reload the page and try again.");
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminProducts() {
  const { products, categories, lowStock, shopId, loadError, lowStockError, developerNeedsShop } =
    useLoaderData<typeof loader>();

  const [addOpen, setAddOpen] = useState(false);
  // Ids, not rows: the dialogs always show the product as last loaded.
  const [editId, setEditId] = useState<string | null>(null);
  const [stockId, setStockId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const editProduct = editId ? products.find((p) => p.id === editId) ?? null : null;
  const stockProduct = stockId ? products.find((p) => p.id === stockId) ?? null : null;

  const active = products.filter((p) => p.is_active === 1);
  const inactive = products.filter((p) => p.is_active !== 1);
  const lowProductIds = new Set(lowStock.map((r) => r.product_id));
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "";

  const filtering = search.trim() !== "" || categoryFilter !== "";
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (p: Product) => {
      if (categoryFilter === "none" ? p.category_id !== null : categoryFilter && p.category_id !== categoryFilter) return false;
      if (!q) return true;
      return [p.name, p.brand, p.sku].some((field) => (field ?? "").toLowerCase().includes(q));
    };
  }, [search, categoryFilter]);
  const shownActive = active.filter(matches);
  const shownInactive = inactive.filter(matches);
  const page = shownActive.slice(0, limit);

  function rowProps(product: Product) {
    return {
      product,
      shopId,
      categoryName: categoryName(product.category_id),
      isLow: lowProductIds.has(product.id),
      onEdit: () => setEditId(product.id),
      onStock: () => setStockId(product.id),
      onNotice: setNotice,
    };
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Products</h1>
          {!loadError && (
            <p className="mt-0.5 text-sm text-white/60">
              {active.length} active
              {inactive.length > 0 && ` · ${inactive.length} inactive`}
              {lowStock.length > 0 && ` · ${lowStock.length} low on stock`}
            </p>
          )}
        </div>
        <Button size="sm" disabled={developerNeedsShop || loadError} onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Add product
        </Button>
      </div>

      {/* The outcome of the last action. Always mounted, so a screen reader hears it arrive. */}
      <div role="status" className={notice ? "mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" : "sr-only"}>
        {notice}
      </div>

      {/* Developer hint */}
      {developerNeedsShop && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage products as a developer.
        </div>
      )}

      {/* Low stock banner */}
      {lowStockError && !loadError && (
        <LoadError what="your low stock alerts" className="mb-6" />
      )}
      {lowStock.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Low stock
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-100">
            {lowStock.map((row) => (
              <li key={row.id}>
                {row.product_name}
                {row.variant_name && ` (${row.variant_name})`}
                {row.product_sku && <span className="text-amber-100/80"> ({row.product_sku})</span>}
                : <span className="font-semibold">{row.quantity}</span> left
                {row.reorder_point > 0 && ` (alert at ${row.reorder_point})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add dialog. Its form mounts with the dialog, so each opening starts clean. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New product</DialogTitle>
          </DialogHeader>
          {addOpen && (
            <ProductForm
              intent="create"
              shopId={shopId}
              categories={categories}
              submitLabel="Add product"
              onDone={(message) => {
                setAddOpen(false);
                setNotice(message);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editProduct} onOpenChange={(open) => { if (!open) setEditId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit product</DialogTitle>
          </DialogHeader>
          {editProduct && (
            <ProductForm
              key={editProduct.id}
              intent="update"
              shopId={shopId}
              product={editProduct}
              categories={categories}
              categoryDefault={categoryName(editProduct.category_id)}
              submitLabel="Save changes"
              onDone={(message) => {
                setEditId(null);
                setNotice(message);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Stock dialog */}
      <Dialog open={!!stockProduct} onOpenChange={(open) => { if (!open) setStockId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stock: {stockProduct?.name}</DialogTitle>
          </DialogHeader>
          {stockProduct && (
            <div className="space-y-6" key={stockProduct.id}>
              <p className="text-sm text-white/70">
                On hand: <span className="font-semibold text-white">{stockProduct.total_quantity}</span>
              </p>
              <MovementForm
                product={stockProduct}
                shopId={shopId}
                onDone={(message) => {
                  setStockId(null);
                  setNotice(`${stockProduct.name}: ${message}`);
                }}
              />
              <AlertLevelsForm
                product={stockProduct}
                shopId={shopId}
                onDone={(message) => {
                  setStockId(null);
                  setNotice(`${stockProduct.name}: ${message}`);
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {loadError ? (
        <LoadError what="your products" />
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-12 text-center text-white/70">
          <p className="text-lg">No products yet.</p>
          <p className="mt-1 text-sm text-white/60">Add retail or back-bar products to track stock and sell at the counter.</p>
        </div>
      ) : (
        <>
          {/* Search and category filter, over the loaded list */}
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <Input
                label="Search products"
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(PAGE_SIZE);
                }}
                placeholder="Name, brand or SKU"
                autoComplete="off"
              />
            </div>
            {categories.length > 0 && (
              <div className="w-48">
                <Select
                  label="Category"
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  <option value="" className="bg-dark">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id} className="bg-dark">{c.name}</option>
                  ))}
                  <option value="none" className="bg-dark">No category</option>
                </Select>
              </div>
            )}
            {filtering && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setCategoryFilter("");
                  setLimit(PAGE_SIZE);
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
          {filtering && (
            <p role="status" className="mb-3 text-sm text-white/70">
              {shownActive.length} of {active.length} active product{active.length !== 1 ? "s" : ""} match.
            </p>
          )}

          {/* Product list */}
          {shownActive.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/20 p-10 text-center text-sm text-white/70">
              {filtering
                ? "No active products match your search or category."
                : "No active products. Restore one from the inactive list below, or add a new product."}
            </div>
          ) : (
            <div className="space-y-2">
              {page.map((product) => (
                <ProductRow key={product.id} {...rowProps(product)} />
              ))}
              {shownActive.length > page.length && (
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <p className="text-sm text-white/60">
                    Showing {page.length} of {shownActive.length}.
                  </p>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                    Show {Math.min(PAGE_SIZE, shownActive.length - page.length)} more
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Inactive products, collapsed until asked for */}
          {inactive.length > 0 && (
            <section className="mt-6">
              <button
                type="button"
                aria-expanded={showInactive}
                onClick={() => setShowInactive((v) => !v)}
                className="tap-target inline-flex items-center rounded-lg text-sm text-white/70 underline-offset-4 transition-colors hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                {showInactive ? "Hide inactive" : `Show ${inactive.length} inactive`}
              </button>
              {showInactive && (
                <div className="mt-2 space-y-2">
                  {shownInactive.length === 0 ? (
                    <p className="text-sm text-white/60">No inactive products match your search or category.</p>
                  ) : (
                    shownInactive.map((product) => <ProductRow key={product.id} {...rowProps(product)} />)
                  )}
                </div>
              )}
            </section>
          )}
        </>
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
  onNotice,
}: {
  product: Product;
  shopId: string | null;
  categoryName: string;
  isLow: boolean;
  onEdit: () => void;
  onStock: () => void;
  onNotice: (message: string) => void;
}) {
  const inactive = product.is_active !== 1;
  const fetcher = useFetcher<ActionData>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      setConfirmOpen(false);
      onNotice(
        data.intent === "restore"
          ? `${product.name} restored.`
          : `${product.name} deactivated. Restore it from the inactive list.`,
      );
    } else {
      setError(data.error);
    }
  });

  function submit(intent: "deactivate" | "restore") {
    setError(null);
    fetcher.submit(
      { intent, productId: product.id, ...(shopId ? { shopId } : {}) },
      { method: "post" },
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 transition-colors ${
        inactive ? "border-white/10 bg-white/[0.03]" : "border-white/10 bg-dark-100 hover:border-white/20"
      }`}
    >
      {/* Info */}
      <div className="min-w-[9rem] flex-1">
        <p className={`truncate text-sm font-medium ${inactive ? "text-white/70" : "text-white"}`}>
          {product.name}
          {inactive && <span className="ml-2 text-xs font-normal text-white/60">(inactive)</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-white/60">
          {[product.brand, product.sku, categoryName].filter(Boolean).join(" · ")}
        </p>
      </div>

      {/* Stock + price: right-aligned, on their own line when a phone needs the room */}
      <div className="ml-auto flex shrink-0 items-center gap-4">
        <div className="text-right">
          {product.track_stock === 1 ? (
            <p className={`text-sm font-semibold ${isLow ? "text-amber-400" : inactive ? "text-white/70" : "text-white"}`}>
              {product.total_quantity} in stock
              {isLow && (
                <>
                  <AlertTriangle className="ml-1 inline h-3 w-3" aria-hidden />
                  <span className="sr-only"> (low)</span>
                </>
              )}
            </p>
          ) : (
            <p className="text-sm text-white/60">Stock not tracked</p>
          )}
          <p className="text-xs text-white/60">cost {formatPence(product.cost_price_pence)}</p>
        </div>
        <div className="w-20 text-right">
          <p className={`text-sm font-semibold ${inactive ? "text-white/70" : "text-gold"}`}>{formatPence(product.retail_price_pence)}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!inactive && (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={onStock} aria-label={`Stock for ${product.name}`}>
              <Boxes className="h-3 w-3" aria-hidden /> Stock
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={onEdit} aria-label={`Edit ${product.name}`}>
              <Pencil className="h-3 w-3" aria-hidden /> Edit
            </Button>
          </>
        )}
        {inactive ? (
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => submit("restore")} aria-label={`Restore ${product.name}`}>
            <RotateCcw className="h-3 w-3" aria-hidden /> {busy ? "Restoring…" : "Restore"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-red-300 hover:bg-red-500/10"
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
            aria-label={`Deactivate ${product.name}`}
          >
            Deactivate
          </Button>
        )}
      </div>

      {/* A refused restore says so on the row it belongs to. */}
      {error && !busy && !confirmOpen && (
        <p role="alert" className="w-full text-xs text-red-400">{error}</p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => submit("deactivate")}
        title={`Deactivate ${product.name}?`}
        confirmLabel={`Deactivate ${product.name}`}
        destructive
        pending={busy}
        pendingLabel="Deactivating…"
        error={error}
      >
        <p>
          It comes off your product list and can no longer be sold. Its stock count
          {product.track_stock === 1 ? ` (${product.total_quantity} on hand)` : ""} and its history are kept.
        </p>
        <p>This can be undone: restore it from the inactive list on this page.</p>
      </ConfirmDialog>
    </div>
  );
}

// ─── MovementForm ─────────────────────────────────────────────────────────────

function MovementForm({
  product,
  shopId,
  onDone,
}: {
  product: Product;
  shopId: string | null;
  onDone: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const [type, setType] = useState<string>("receive");
  const [direction, setDirection] = useState<"add" | "remove" | "">("");
  const [quantity, setQuantity] = useState("");

  useFetcherResult(fetcher, (data) => {
    if (data.ok) onDone(data.message);
  });

  const chosen = movementType(type);
  // What the stock will read afterwards, once the form says enough to know.
  const signed = signedQuantityDelta(type, quantity, direction);
  const after = signed.ok ? product.total_quantity + signed.delta : null;
  const adds = chosen?.direction === "add" || (chosen?.direction === "choose" && direction === "add");

  return (
    <fetcher.Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="movement" />
      <input type="hidden" name="productId" value={product.id} />
      {shopId && <input type="hidden" name="shopId" value={shopId} />}
      <Select
        label="What happened"
        name="type"
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          setDirection("");
        }}
      >
        {MOVEMENT_TYPES.map((t) => (
          <option key={t.value} value={t.value} className="bg-dark">{t.label}</option>
        ))}
      </Select>

      {chosen?.direction === "choose" && (
        <fieldset>
          <legend className="text-sm font-medium text-white/80">Add or remove stock</legend>
          <div className="mt-1 flex flex-col">
            {(["add", "remove"] as const).map((d) => (
              <label key={d} className="tap-target flex cursor-pointer items-center gap-2 text-sm text-white/80">
                <input
                  type="radio"
                  name="direction"
                  value={d}
                  checked={direction === d}
                  onChange={() => setDirection(d)}
                  required
                  className="h-4 w-4 accent-gold"
                />
                {d === "add" ? chosen.addLabel : chosen.removeLabel}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="How many"
          name="quantity"
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="e.g. 12"
          required
        />
        {adds && (
          <Input
            label="Unit cost (£, optional)"
            name="unit_cost"
            inputMode="decimal"
            placeholder="0.00"
          />
        )}
      </div>
      <Input label="Note (optional)" name="note" placeholder="e.g. May delivery" />

      {signed.ok && after !== null && (
        <p role="status" className={`text-sm ${after < 0 ? "text-amber-300" : "text-white/70"}`}>
          {signed.delta > 0 ? `Adds ${signed.delta}` : `Removes ${-signed.delta}`}. Stock on hand will go from{" "}
          {product.total_quantity} to <span className="font-semibold text-white">{after}</span>.
          {after < 0 ? " That is below zero: check the quantity." : ""}
        </p>
      )}

      {!busy && fetcher.data && !fetcher.data.ok && (
        <p className="text-sm text-red-400" role="alert">{fetcher.data.error}</p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy
          ? "Saving…"
          : signed.ok
            ? signed.delta > 0
              ? `Add ${signed.delta} to stock`
              : `Remove ${-signed.delta} from stock`
            : "Record stock movement"}
      </Button>
    </fetcher.Form>
  );
}

// ─── AlertLevelsForm ──────────────────────────────────────────────────────────

/** The low-stock alert levels, opened on the product's saved values. The list
 *  does not carry them, so they are loaded when the dialog opens; if that
 *  fails the form is not shown, so zeros are never saved over real levels. */
function AlertLevelsForm({
  product,
  shopId,
  onDone,
}: {
  product: Product;
  shopId: string | null;
  onDone: (message: string) => void;
}) {
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const levels = useFetcher<typeof loader>();
  const save = useFetcher<ActionData>();
  const busy = save.state !== "idle";

  const query = new URLSearchParams(searchParams);
  query.set("alertLevelsFor", product.id);
  const href = `${pathname}?${query}`;
  const load = levels.load;
  useEffect(() => {
    void load(href);
  }, [load, href]);

  useFetcherResult(save, (data) => {
    if (data.ok) onDone(data.message);
  });

  const loaded = levels.data?.alertLevels?.productId === product.id ? levels.data.alertLevels : null;
  const failed = levels.state === "idle" && levels.data !== undefined && !loaded;

  return (
    <div className="space-y-3 border-t border-white/10 pt-4">
      <div>
        <h3 className="text-sm font-semibold text-white">Low stock alert</h3>
        <p className="mt-0.5 text-xs text-white/60">
          The product is flagged as low when stock reaches the alert level. Set it to 0 to be told only when it runs out.
        </p>
      </div>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="min-w-[10rem] flex-1 text-sm text-amber-100">
            We couldn&apos;t load this product&apos;s alert levels, so they can&apos;t be edited right now. Nothing has been changed.
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load(href)}>
            Try again
          </Button>
        </div>
      ) : !loaded ? (
        <p role="status" className="text-sm text-white/60">Loading the current alert levels…</p>
      ) : (
        <save.Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="reorder" />
          <input type="hidden" name="productId" value={product.id} />
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Alert when stock reaches"
              name="reorder_point"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              defaultValue={loaded.reorder_point}
              required
            />
            <Input
              label="Usual reorder quantity"
              name="reorder_qty"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              defaultValue={loaded.reorder_qty}
              required
            />
          </div>
          {!busy && save.data && !save.data.ok && (
            <p className="text-sm text-red-400" role="alert">{save.data.error}</p>
          )}
          <Button type="submit" variant="outline" className="w-full" disabled={busy}>
            {busy ? "Saving…" : "Save alert levels"}
          </Button>
        </save.Form>
      )}
    </div>
  );
}

// ─── ProductForm ──────────────────────────────────────────────────────────────

/** The add and edit form. Each has its own fetcher, so an error from one
 *  attempt is never shown in another dialog. */
function ProductForm({
  intent,
  shopId,
  product,
  categories,
  categoryDefault,
  submitLabel,
  onDone,
}: {
  intent: "create" | "update";
  shopId: string | null;
  product?: Product;
  categories: Category[];
  categoryDefault?: string;
  submitLabel: string;
  onDone: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) onDone(data.message);
  });

  return (
    <fetcher.Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value={intent} />
      {product && <input type="hidden" name="productId" value={product.id} />}
      {shopId && <input type="hidden" name="shopId" value={shopId} />}
      <Input
        label="Product name"
        name="name"
        defaultValue={product?.name ?? ""}
        placeholder="e.g. Sea Salt Spray 250ml"
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Brand (optional)"
          name="brand"
          defaultValue={product?.brand ?? ""}
          placeholder="e.g. Coastal"
        />
        <Input
          label="SKU (optional)"
          name="sku"
          defaultValue={product?.sku ?? ""}
          placeholder="e.g. SSS-250"
        />
      </div>
      <Input
        label="Category (optional)"
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
          inputMode="decimal"
          defaultValue={product ? (product.cost_price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
        />
        <Input
          label="Retail price (£)"
          name="retail_price"
          inputMode="decimal"
          defaultValue={product ? (product.retail_price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
        />
      </div>
      <label className="tap-target flex cursor-pointer items-center gap-2 text-sm text-white/80">
        <input
          type="checkbox"
          name="track_stock"
          defaultChecked={product ? product.track_stock === 1 : true}
          className="h-4 w-4 rounded accent-gold"
        />
        Track stock levels
      </label>
      {!busy && fetcher.data && !fetcher.data.ok && (
        <p className="text-sm text-red-400" role="alert">{fetcher.data.error}</p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </fetcher.Form>
  );
}
