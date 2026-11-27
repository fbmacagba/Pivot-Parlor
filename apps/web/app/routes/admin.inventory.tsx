/**
 * WS-3 Phase 2 — inventory operations in one place:
 *   · retail/COGS report (last 30 days)
 *   · purchase orders (draft → ordered → receive)
 *   · stock-take sessions (count → complete emits adjustments)
 *   · back-bar recipes (service_products BOM — consumed when a service sells)
 */
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  data as json,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ClipboardList, FlaskConical, Package, Plus, Truck, X } from "lucide-react";
import { useRef, useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/Dialog";
import { ErrorScreen } from "~/components/ErrorScreen";
import { formatDate, formatDateTime, formatDay } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Inventory");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

/** Purchase orders and past stock takes are listed this many at a time. */
const LIST_PAGE = 10;

// ─── Types (worker rows are snake_case) ───────────────────────────────────────

interface Product {
  id: string;
  name: string;
  sku: string | null;
  cost_price_pence: number;
  track_stock: number;
  is_active: number;
  total_quantity: number;
}

interface Supplier { id: string; name: string; is_active: number }

interface Service { id: string; name: string; isActive: boolean }

interface PoListRow {
  id: string;
  status: "draft" | "ordered" | "partial" | "received" | "cancelled";
  supplier_name: string | null;
  notes: string | null;
  created_at: string;
  total_pence: number;
  total_qty: number;
  total_received_qty: number;
}

interface PoItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  received_qty: number;
  unit_cost_pence: number;
  product_name: string;
  variant_name: string | null;
}

interface PoDetail extends PoListRow { items: PoItem[] }

interface StockTakeRow {
  id: string;
  status: "open" | "completed" | "cancelled";
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  item_count: number;
  variance_qty: number;
}

interface StockTakeItem {
  product_id: string;
  variant_id: string | null;
  expected_qty: number;
  counted_qty: number;
  product_name: string;
}

type OpenStockTake = StockTakeRow & { items: StockTakeItem[] };

interface Report {
  from: string;
  to: string;
  retail: { revenue_pence: number; cogs_pence: number; margin_pence: number; units_sold: number };
  by_product: Array<{ product_id: string | null; name: string; units_sold: number; revenue_pence: number; cogs_pence: number }>;
  by_staff: Array<{ staff_id: string | null; staff_name: string | null; units_sold: number; revenue_pence: number }>;
  consumption: { units_consumed: number; cost_pence: number };
}

type ActionData = { ok: true; intent: string } | { error: string };

/** Which sections could not load. One failed request no longer blanks the rest. */
interface SectionErrors {
  products: boolean;
  suppliers: boolean;
  services: boolean;
  purchaseOrders: boolean;
  poDetail: boolean;
  stockTakes: boolean;
  openStockTake: boolean;
  report: boolean;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);
  const url = new URL(request.url);
  const poId = url.searchParams.get("po");

  let products: Product[] = [];
  let suppliers: Supplier[] = [];
  let services: Service[] = [];
  let purchaseOrders: PoListRow[] = [];
  let stockTakes: StockTakeRow[] = [];
  let report: Report | null = null;
  let poDetail: PoDetail | null = null;
  let openStockTake: OpenStockTake | null = null;
  const loadError: SectionErrors = {
    products: false,
    suppliers: false,
    services: false,
    purchaseOrders: false,
    poDetail: false,
    stockTakes: false,
    openStockTake: false,
    report: false,
  };

  if (shopId) {
    const wantsPo = Boolean(poId && /^[A-Za-z0-9_-]{1,100}$/.test(poId));
    // The open stock take's lines need the list first, so they follow it;
    // everything else loads alongside, each section failing on its own.
    const stockTakeChain = (async () => {
      try {
        stockTakes = (await api.get<StockTakeRow[]>(`/api/shops/${shopId}/stock-takes`)) ?? [];
      } catch {
        loadError.stockTakes = true;
        return;
      }
      const open = stockTakes.find((s) => s.status === "open");
      if (!open) return;
      try {
        openStockTake = await api.get<OpenStockTake>(`/api/shops/${shopId}/stock-takes/${open.id}`);
      } catch {
        loadError.openStockTake = true;
      }
    })();

    const [productsRes, suppliersRes, servicesRes, poRes, reportRes, poDetailRes] = await Promise.allSettled([
      api.get<Product[]>(`/api/shops/${shopId}/products`),
      api.get<Supplier[]>(`/api/shops/${shopId}/suppliers`),
      api.get<Service[]>(`/api/shops/${shopId}/services`),
      api.get<PoListRow[]>(`/api/shops/${shopId}/purchase-orders`),
      api.get<Report>(`/api/shops/${shopId}/inventory/report`),
      wantsPo ? api.get<PoDetail>(`/api/shops/${shopId}/purchase-orders/${poId}`) : Promise.resolve(null),
      stockTakeChain,
    ]);
    if (productsRes.status === "fulfilled") products = productsRes.value ?? [];
    else loadError.products = true;
    if (suppliersRes.status === "fulfilled") suppliers = suppliersRes.value ?? [];
    else loadError.suppliers = true;
    if (servicesRes.status === "fulfilled") services = servicesRes.value ?? [];
    else loadError.services = true;
    if (poRes.status === "fulfilled") purchaseOrders = poRes.value ?? [];
    else loadError.purchaseOrders = true;
    if (reportRes.status === "fulfilled") report = reportRes.value;
    else loadError.report = true;
    if (poDetailRes.status === "fulfilled") poDetail = poDetailRes.value;
    else loadError.poDetail = true;
  }

  return json({
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
    products,
    suppliers,
    services,
    purchaseOrders,
    stockTakes,
    report,
    poDetail,
    openStockTake: openStockTake as OpenStockTake | null,
    loadError,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await readFormData(request);
  if (!form) return json<ActionData>({ error: UNREADABLE_FORM }, { status: 400 });
  const intent = String(form.get("intent") ?? "").trim();
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "").trim() || null);
  if (!shopId) {
    return json<ActionData>(
      { error: "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL." },
      { status: 400 }
    );
  }
  const api = createApiClient(env.API_URL, token);

  const parseJson = <T,>(field: string): T | null => {
    try {
      return JSON.parse(String(form.get(field) ?? "")) as T;
    } catch {
      return null;
    }
  };

  try {
    if (intent === "po-create") {
      const rawItems = parseJson<Array<{ product_id: string; quantity: number; unit_cost: string }>>("items");
      if (!rawItems || rawItems.length === 0) {
        return json<ActionData>({ error: "Add at least one product line." }, { status: 400 });
      }
      const items = [];
      for (const line of rawItems) {
        const cost = line.unit_cost.trim() ? parsePoundsToPence(line.unit_cost) : undefined;
        if (cost === null) {
          return json<ActionData>({ error: "Unit costs must be valid amounts (e.g. 3.20)." }, { status: 400 });
        }
        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
          return json<ActionData>({ error: "Each line needs a whole quantity of 1 or more." }, { status: 400 });
        }
        items.push({
          product_id: line.product_id,
          quantity: line.quantity,
          ...(cost !== undefined ? { unit_cost_pence: cost } : {}),
        });
      }
      await api.post(`/api/shops/${shopId}/purchase-orders`, {
        supplier_id: String(form.get("supplier_id") ?? "").trim() || null,
        notes: String(form.get("notes") ?? "").trim() || null,
        items,
      });
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "po-order" || intent === "po-cancel") {
      const poId = String(form.get("poId") ?? "").trim();
      if (!poId) return json<ActionData>({ error: "Missing purchase order." }, { status: 400 });
      await api.post(`/api/shops/${shopId}/purchase-orders/${poId}/${intent === "po-order" ? "order" : "cancel"}`, {});
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "po-receive") {
      const poId = String(form.get("poId") ?? "").trim();
      const lines = parseJson<Array<{ item_id: string; quantity: number }>>("lines");
      if (!poId || !lines || lines.length === 0) {
        return json<ActionData>({ error: "Enter a received quantity for at least one line." }, { status: 400 });
      }
      await api.post(`/api/shops/${shopId}/purchase-orders/${poId}/receive`, { lines });
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "st-open") {
      await api.post(`/api/shops/${shopId}/stock-takes`, {
        notes: String(form.get("notes") ?? "").trim() || undefined,
      });
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "st-count") {
      const stId = String(form.get("stockTakeId") ?? "").trim();
      const items = parseJson<Array<{ product_id: string; counted_qty: number }>>("counts");
      if (!stId || !items || items.length === 0) {
        return json<ActionData>({ error: "Enter at least one count." }, { status: 400 });
      }
      await api.put(`/api/shops/${shopId}/stock-takes/${stId}/items`, { items });
      return json<ActionData>({ ok: true, intent });
    }

    if (intent === "st-complete" || intent === "st-cancel") {
      const stId = String(form.get("stockTakeId") ?? "").trim();
      if (!stId) return json<ActionData>({ error: "Missing stock take." }, { status: 400 });
      await api.post(`/api/shops/${shopId}/stock-takes/${stId}/${intent === "st-complete" ? "complete" : "cancel"}`, {});
      return json<ActionData>({ ok: true, intent });
    }
  } catch (e) {
    return json<ActionData>({ error: e instanceof Error ? e.message : "Request failed" }, { status: 400 });
  }

  return json<ActionData>({ error: "Unknown action." }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** What the page says once each action has gone through. */
const SUCCESS: Record<string, string> = {
  "po-create": "Draft purchase order created.",
  "po-order": "Purchase order marked as ordered.",
  "po-cancel": "Purchase order cancelled.",
  "po-receive": "Delivery received into stock.",
  "st-open": "Stock take started. Count your shelves and save as you go.",
  "st-count": "Counts saved.",
  "st-complete": "Stock take completed. Stock levels now match your counts.",
  "st-cancel": "Stock take cancelled. Stock levels were not changed.",
};

export default function AdminInventory() {
  const {
    shopId, developerNeedsShop, products, suppliers, services,
    purchaseOrders, stockTakes, report, poDetail, openStockTake, loadError,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";
  const activeProducts = products.filter((p) => p.is_active === 1);
  const shopQuery = shopId ? `?shopId=${shopId}` : "";
  // The outcome of the last confirmed action (cancel an order, complete or
  // cancel a stock take). Those go through a fetcher, so they report here.
  const [confirmed, setConfirmed] = useState<string | null>(null);

  // A form action that finishes afterwards takes the message over again.
  useFetcherResult({ state: nav.state, data: actionData }, () => setConfirmed(null));
  const notifyConfirmed = (intent: string) => setConfirmed(SUCCESS[intent] ?? "Done.");

  const formSuccess = actionData && "ok" in actionData ? (SUCCESS[actionData.intent] ?? "Done.") : null;
  const success = confirmed ?? formSuccess;

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Inventory</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Purchasing, stock takes, back-bar usage and retail performance.
        </p>
      </div>

      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage inventory as a developer.
        </div>
      )}

      {actionData && "error" in actionData && !confirmed && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
          {actionData.error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200" role="status">
          {success}
        </div>
      )}

      {loadError.products && <LoadError what="your products" />}

      {loadError.report ? (
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-heading text-lg font-semibold text-white">
            <Package className="h-4 w-4 text-gold" aria-hidden /> Retail performance
          </h2>
          <LoadError what="the retail performance figures" />
        </section>
      ) : (
        report && <ReportSection report={report} />
      )}

      <PurchaseOrdersSection
        shopId={shopId}
        shopQuery={shopQuery}
        purchaseOrders={purchaseOrders}
        poDetail={poDetail}
        suppliers={suppliers.filter((s) => s.is_active === 1)}
        products={activeProducts}
        isSubmitting={isSubmitting}
        listError={loadError.purchaseOrders}
        detailError={loadError.poDetail}
        suppliersError={loadError.suppliers}
        productsError={loadError.products}
        onConfirmed={notifyConfirmed}
      />

      <StockTakeSection
        shopId={shopId}
        stockTakes={stockTakes}
        openStockTake={openStockTake}
        products={activeProducts.filter((p) => p.track_stock === 1)}
        isSubmitting={isSubmitting}
        listError={loadError.stockTakes}
        openError={loadError.openStockTake}
        productsError={loadError.products}
        onConfirmed={notifyConfirmed}
      />

      <BackBarSection
        shopId={shopId}
        services={services.filter((s) => s.isActive)}
        products={activeProducts}
        loadError={loadError.services || loadError.products}
      />
    </div>
  );
}

// ─── Report ───────────────────────────────────────────────────────────────────

function ReportSection({ report }: { report: Report }) {
  return (
    <section>
      <h2 className="mb-3 flex flex-wrap items-center gap-2 font-heading text-lg font-semibold text-white">
        <Package className="h-4 w-4 text-gold" aria-hidden /> Retail performance
        <span className="text-xs font-normal text-white/60">{formatDay(report.from)} to {formatDay(report.to)}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Retail revenue" value={formatPence(report.retail.revenue_pence)} />
        <StatCard label="Cost of goods sold" value={formatPence(report.retail.cogs_pence)} />
        <StatCard label="Margin" value={formatPence(report.retail.margin_pence)} accent />
        <StatCard label="Back-bar cost" value={formatPence(report.consumption.cost_pence)} />
      </div>
      {report.by_product.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/60">Top products</p>
            <ul className="space-y-1.5 text-sm">
              {report.by_product.slice(0, 5).map((row) => (
                <li key={row.product_id ?? row.name} className="flex justify-between gap-3">
                  <span className="truncate text-white/70">{row.name} <span className="text-white/60">×{row.units_sold}</span></span>
                  <span className="shrink-0 text-white">{formatPence(row.revenue_pence)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/60">Retail by staff</p>
            {report.by_staff.length === 0 ? (
              <p className="text-sm text-white/60">No attributed retail sales in this period.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {report.by_staff.slice(0, 5).map((row) => (
                  <li key={row.staff_id ?? "unknown"} className="flex justify-between gap-3">
                    <span className="truncate text-white/70">{row.staff_name ?? "Unknown"} <span className="text-white/60">×{row.units_sold}</span></span>
                    <span className="shrink-0 text-white">{formatPence(row.revenue_pence)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
      <p className="text-xs text-white/60">{label}</p>
      <p className={`mt-1 text-lg font-bold ${accent ? "text-gold" : "text-white"}`}>{value}</p>
    </div>
  );
}

/** "Show more" under a list cut to a page, with how much of it is on screen. */
function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button type="button" variant="secondary" size="sm" onClick={onMore}>
        Show more
      </Button>
      <p className="text-xs text-white/60">Showing {shown} of {total}</p>
    </div>
  );
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

/** Quantity is kept as typed, so the field can be emptied while editing. */
interface DraftLine { product_id: string; quantity: string; unit_cost: string }

function PurchaseOrdersSection({
  shopId, shopQuery, purchaseOrders, poDetail, suppliers, products, isSubmitting,
  listError, detailError, suppliersError, productsError, onConfirmed,
}: {
  shopId: string | null;
  shopQuery: string;
  purchaseOrders: PoListRow[];
  poDetail: PoDetail | null;
  suppliers: Supplier[];
  products: Product[];
  isSubmitting: boolean;
  listError: boolean;
  detailError: boolean;
  suppliersError: boolean;
  productsError: boolean;
  onConfirmed: (intent: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [shown, setShown] = useState(LIST_PAGE);
  const [cancelling, setCancelling] = useState<PoListRow | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const cancelFetcher = useFetcher<ActionData>();

  useFetcherResult({ state: nav.state, data: actionData }, (data) => {
    if ("ok" in data && data.intent === "po-create") {
      setCreateOpen(false);
      setLines([]);
    }
  });

  useFetcherResult(cancelFetcher, (data) => {
    if ("ok" in data) {
      setCancelling(null);
      setCancelError(null);
      onConfirmed(data.intent);
    } else {
      setCancelError(data.error);
    }
  });

  const addLine = () => {
    const first = products[0];
    if (!first) return;
    setLines((l) => [...l, { product_id: first.id, quantity: "1", unit_cost: (first.cost_price_pence / 100).toFixed(2) }]);
  };
  const patchLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  const linesValid = lines.length > 0 && lines.every((l) => Number.isInteger(Number(l.quantity)) && Number(l.quantity) >= 1);

  const confirmCancel = () => {
    if (!cancelling) return;
    setCancelError(null);
    const form = new FormData();
    form.append("intent", "po-cancel");
    form.append("poId", cancelling.id);
    if (shopId) form.append("shopId", shopId);
    cancelFetcher.submit(form, { method: "post" });
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold text-white">
          <Truck className="h-4 w-4 text-gold" aria-hidden /> Purchase orders
        </h2>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!shopId || products.length === 0 || productsError || suppliersError}>
              <Plus className="h-4 w-4" aria-hidden /> New order
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="po-create" />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <input
                type="hidden"
                name="items"
                value={JSON.stringify(lines.map((l) => ({ ...l, quantity: Number(l.quantity) || 0 })))}
              />
              <Select label="Supplier" name="supplier_id" defaultValue="">
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-white/60">Lines</p>
                {lines.map((line, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[10rem] flex-1">
                      <Select
                        label="Product"
                        value={line.product_id}
                        onChange={(e) => {
                          const p = products.find((x) => x.id === e.target.value);
                          patchLine(i, { product_id: e.target.value, unit_cost: p ? (p.cost_price_pence / 100).toFixed(2) : line.unit_cost });
                        }}
                      >
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                    <div className="w-20">
                      <Input
                        label="Quantity"
                        type="number" min="1" step="1" inputMode="numeric"
                        value={line.quantity}
                        onChange={(e) => patchLine(i, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="w-24">
                      <Input
                        label="Cost (£)"
                        type="number" min="0" step="0.01" inputMode="decimal"
                        value={line.unit_cost}
                        onChange={(e) => patchLine(i, { unit_cost: e.target.value })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setLines((l) => l.filter((_, idx) => idx !== i))}
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                  <Plus className="h-4 w-4" aria-hidden /> Add line
                </Button>
              </div>

              <Input label="Notes" name="notes" placeholder="e.g. monthly restock" />
              {lines.length > 0 && !linesValid && (
                <p role="alert" className="text-sm text-red-400">Each line needs a whole quantity of 1 or more.</p>
              )}
              <Button type="submit" className="w-full" disabled={isSubmitting || !linesValid}>
                {isSubmitting ? "Saving…" : "Create draft order"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {listError ? (
        <LoadError what="your purchase orders" />
      ) : purchaseOrders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-sm text-white/60">
          No purchase orders yet. Create one to restock from a supplier.
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {purchaseOrders.slice(0, shown).map((po) => (
              <li key={po.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-dark-100 p-4">
                <div className="min-w-[9rem] flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {po.supplier_name ?? "No supplier"}
                    <span className="ml-2 text-xs text-white/60">{formatDate(po.created_at)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-white/60">
                    {po.total_received_qty} of {po.total_qty} received · {formatPence(po.total_pence)}
                    {po.notes && ` · ${po.notes}`}
                  </p>
                </div>
                <StatusBadge status={po.status} className="ml-auto shrink-0" />
                <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                  {po.status === "draft" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="po-order" />
                      <input type="hidden" name="poId" value={po.id} />
                      {shopId && <input type="hidden" name="shopId" value={shopId} />}
                      <Button type="submit" size="sm" variant="secondary" disabled={isSubmitting}>
                        Mark ordered
                      </Button>
                    </Form>
                  )}
                  {(po.status === "ordered" || po.status === "partial") && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/admin/inventory${shopQuery}${shopQuery ? "&" : "?"}po=${po.id}`}>Receive</Link>
                    </Button>
                  )}
                  {(po.status === "draft" || po.status === "ordered") && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isSubmitting}
                      onClick={() => {
                        setCancelError(null);
                        setCancelling(po);
                      }}
                      aria-label={`Cancel the order from ${po.supplier_name ?? "no supplier"}, ${formatDate(po.created_at)}`}
                    >
                      Cancel order
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <ShowMore shown={Math.min(shown, purchaseOrders.length)} total={purchaseOrders.length} onMore={() => setShown((n) => n + LIST_PAGE)} />
        </>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        onCancel={() => setCancelling(null)}
        onConfirm={confirmCancel}
        title="Cancel this purchase order?"
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        destructive
        pending={cancelFetcher.state !== "idle"}
        pendingLabel="Cancelling…"
        error={cancelError}
      >
        {cancelling && (
          <p>
            The {formatPence(cancelling.total_pence)} order from {cancelling.supplier_name ?? "no supplier"} ({formatDate(cancelling.created_at)}) will be
            closed and nothing more can be received against it. Stock levels do not change.
          </p>
        )}
        <p>This cannot be undone. Tell your supplier yourself if the order was already placed.</p>
      </ConfirmDialog>

      {detailError && <LoadError what="that purchase order" className="mt-4" />}
      {poDetail && (poDetail.status === "ordered" || poDetail.status === "partial") && (
        <ReceiveDialog
          // A delivery received changes the outstanding amounts: start the form clean.
          key={`${poDetail.id}:${poDetail.total_received_qty}`}
          shopId={shopId}
          shopQuery={shopQuery}
          po={poDetail}
          isSubmitting={isSubmitting}
        />
      )}
    </section>
  );
}

function ReceiveDialog({
  shopId, shopQuery, po, isSubmitting,
}: { shopId: string | null; shopQuery: string; po: PoDetail; isSubmitting: boolean }) {
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const lines = po.items
    .map((item) => ({ item_id: item.id, quantity: Number(qtys[item.id] ?? "") || 0 }))
    .filter((l) => l.quantity > 0);

  return (
    <div className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-emerald-200">
          Receive delivery: {po.supplier_name ?? "no supplier"}
        </p>
        <Link to={`/admin/inventory${shopQuery}`} className="tap-target inline-flex items-center text-xs text-white/70 hover:text-white">
          Close
        </Link>
      </div>
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="po-receive" />
        <input type="hidden" name="poId" value={po.id} />
        {shopId && <input type="hidden" name="shopId" value={shopId} />}
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />
        <div className="space-y-2">
          {po.items.map((item) => {
            const outstanding = item.quantity - item.received_qty;
            const itemName = `${item.product_name}${item.variant_name ? ` (${item.variant_name})` : ""}`;
            return (
              <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="min-w-[9rem] flex-1 text-white/70">
                  {itemName}
                  <span className="ml-2 text-xs text-white/60">
                    {item.received_qty} of {item.quantity} received · {formatPence(item.unit_cost_pence)} each
                  </span>
                </span>
                {outstanding > 0 ? (
                  <div className="w-28">
                    <Input
                      label={`Quantity of ${itemName} received`}
                      hideLabel
                      type="number" min="0" max={outstanding} step="1" inputMode="numeric"
                      placeholder={`Up to ${outstanding}`}
                      value={qtys[item.id] ?? ""}
                      onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-emerald-300">Complete</span>
                )}
              </div>
            );
          })}
        </div>
        <Button type="submit" size="sm" disabled={isSubmitting || lines.length === 0}>
          {isSubmitting ? "Receiving…" : "Receive into stock"}
        </Button>
      </Form>
    </div>
  );
}

// ─── Stock takes ──────────────────────────────────────────────────────────────

function StockTakeSection({
  shopId, stockTakes, openStockTake, products, isSubmitting, listError, openError, productsError, onConfirmed,
}: {
  shopId: string | null;
  stockTakes: StockTakeRow[];
  openStockTake: OpenStockTake | null;
  products: Product[];
  isSubmitting: boolean;
  listError: boolean;
  openError: boolean;
  productsError: boolean;
  onConfirmed: (intent: string) => void;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(LIST_PAGE);
  const [confirming, setConfirming] = useState<"st-complete" | "st-cancel" | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const confirmFetcher = useFetcher<ActionData>();
  const countedByProduct = new Map((openStockTake?.items ?? []).map((i) => [i.product_id, i]));
  const entries = products
    .map((p) => ({ product_id: p.id, counted_qty: Number(counts[p.id] ?? "") }))
    .filter((e) => counts[e.product_id] !== undefined && counts[e.product_id] !== "" && Number.isInteger(e.counted_qty) && e.counted_qty >= 0);
  const past = stockTakes.filter((s) => s.status !== "open");
  const hasOpen = Boolean(openStockTake) || openError;

  // Saved counts move into the "counted" note beside each product.
  useFetcherResult({ state: nav.state, data: actionData }, (data) => {
    if ("ok" in data && data.intent === "st-count") setCounts({});
  });

  useFetcherResult(confirmFetcher, (data) => {
    if ("ok" in data) {
      setConfirming(null);
      setConfirmError(null);
      setCounts({});
      onConfirmed(data.intent);
    } else {
      setConfirmError(data.error);
    }
  });

  const confirm = () => {
    if (!confirming || !openStockTake) return;
    setConfirmError(null);
    const form = new FormData();
    form.append("intent", confirming);
    form.append("stockTakeId", openStockTake.id);
    if (shopId) form.append("shopId", shopId);
    confirmFetcher.submit(form, { method: "post" });
  };

  const countedCount = openStockTake?.items.length ?? 0;
  const unsavedCounts = entries.length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold text-white">
          <ClipboardList className="h-4 w-4 text-gold" aria-hidden /> Stock takes
        </h2>
        {!hasOpen && !listError && (
          <Form method="post">
            <input type="hidden" name="intent" value="st-open" />
            {shopId && <input type="hidden" name="shopId" value={shopId} />}
            <Button size="sm" type="submit" disabled={!shopId || isSubmitting || products.length === 0 || productsError}>
              <Plus className="h-4 w-4" aria-hidden /> Start stock take
            </Button>
          </Form>
        )}
      </div>

      {openError && <LoadError what="the stock take in progress" className="mb-4" />}

      {openStockTake && (
        <div className="mb-4 rounded-xl border border-gold/30 bg-gold/5 p-4">
          <p className="mb-3 text-sm font-semibold text-gold">
            Stock take in progress
            <span className="ml-2 text-xs font-normal text-white/60">
              started {formatDateTime(openStockTake.created_at)} · {countedCount} counted
            </span>
          </p>

          {productsError ? (
            <p className="text-sm text-white/70">Your products could not be loaded, so counts cannot be entered right now.</p>
          ) : (
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="st-count" />
              <input type="hidden" name="stockTakeId" value={openStockTake.id} />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <input type="hidden" name="counts" value={JSON.stringify(entries)} />
              <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {products.map((p) => {
                  const existing = countedByProduct.get(p.id);
                  return (
                    <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="min-w-[9rem] flex-1 text-white/70">
                        {p.name}
                        <span className="ml-2 text-xs text-white/60">
                          system: {p.total_quantity}
                          {existing && ` · counted: ${existing.counted_qty}`}
                        </span>
                      </span>
                      <div className="w-28">
                        <Input
                          label={`Count of ${p.name}`}
                          hideLabel
                          type="number" min="0" step="1" inputMode="numeric"
                          placeholder={existing ? String(existing.counted_qty) : "Count"}
                          value={counts[p.id] ?? ""}
                          onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value }))}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" variant="outline" disabled={isSubmitting || entries.length === 0}>
                  {isSubmitting ? "Saving…" : "Save counts"}
                </Button>
              </div>
            </Form>
          )}

          <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
            <Button
              type="button"
              size="sm"
              disabled={isSubmitting || countedCount === 0}
              onClick={() => {
                setConfirmError(null);
                setConfirming("st-complete");
              }}
            >
              Complete and apply adjustments
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() => {
                setConfirmError(null);
                setConfirming("st-cancel");
              }}
            >
              Cancel stock take
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming === "st-complete"}
        onCancel={() => setConfirming(null)}
        onConfirm={confirm}
        title="Complete this stock take?"
        confirmLabel="Complete and adjust stock"
        cancelLabel="Keep counting"
        pending={confirmFetcher.state !== "idle"}
        pendingLabel="Applying…"
        error={confirmError}
      >
        <p>
          Stock levels change to match your saved counts for {countedCount === 1 ? "1 product" : `${countedCount} products`}.
          Products with no saved count stay as they are.
        </p>
        {unsavedCounts > 0 && (
          <p className="text-amber-300">
            {unsavedCounts === 1 ? "1 count you typed is" : `${unsavedCounts} counts you typed are`} not saved yet and will be
            left out. Go back and press Save counts first to include {unsavedCounts === 1 ? "it" : "them"}.
          </p>
        )}
        <p>This cannot be undone. To correct a level afterwards, run another stock take.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "st-cancel"}
        onCancel={() => setConfirming(null)}
        onConfirm={confirm}
        title="Cancel this stock take?"
        confirmLabel="Cancel stock take"
        cancelLabel="Keep counting"
        destructive
        pending={confirmFetcher.state !== "idle"}
        pendingLabel="Cancelling…"
        error={confirmError}
      >
        <p>
          {countedCount === 0
            ? "The stock take is closed."
            : `The ${countedCount === 1 ? "1 saved count is" : `${countedCount} saved counts are`} thrown away.`}{" "}
          Stock levels do not change.
        </p>
        <p>This cannot be undone. You would have to count again in a new stock take.</p>
      </ConfirmDialog>

      {listError ? (
        <LoadError what="your stock takes" />
      ) : past.length === 0 && !hasOpen ? (
        <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-sm text-white/60">
          No stock takes yet. Start one to count shelves and reconcile the system quantities.
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {past.slice(0, shown).map((st) => (
              <li key={st.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-dark-100 px-4 py-3 text-sm">
                <span className="min-w-[9rem] flex-1 text-white/70">
                  {formatDate(st.created_at)}
                  <span className="ml-2 text-xs text-white/60">{st.item_count} items counted</span>
                </span>
                {st.status === "completed" && (
                  <span className={`text-xs ${st.variance_qty === 0 ? "text-white/60" : st.variance_qty > 0 ? "text-emerald-300" : "text-amber-300"}`}>
                    variance {st.variance_qty > 0 ? `+${st.variance_qty}` : st.variance_qty}
                  </span>
                )}
                <StatusBadge status={st.status} />
              </li>
            ))}
          </ul>
          <ShowMore shown={Math.min(shown, past.length)} total={past.length} onMore={() => setShown((n) => n + LIST_PAGE)} />
        </>
      )}
    </section>
  );
}

// ─── Back-bar recipes (BOM) ───────────────────────────────────────────────────

interface BomRow { product_id: string; quantity: number; product_name: string }
/** Quantity is kept as typed, so the field can be emptied while editing. */
interface RecipeRow { product_id: string; quantity: string; product_name: string }

function validUnits(quantity: string): boolean {
  const n = Number(quantity);
  return quantity.trim() !== "" && Number.isInteger(n) && n >= 1;
}

function BackBarSection({
  shopId, services, products, loadError,
}: { shopId: string | null; services: Service[]; products: Product[]; loadError: boolean }) {
  const [serviceId, setServiceId] = useState("");
  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saved, setSaved] = useState(false);
  const fetcher = useFetcher<{ success: boolean; data?: BomRow[]; error?: string }>();
  const lastRequest = useRef<"load" | "save">("load");
  const loadedFor = fetcher.data && fetcher.state === "idle";

  useFetcherResult(fetcher, (result) => {
    if (result.success && Array.isArray(result.data)) {
      setRows(result.data.map((r) => ({ ...r, quantity: String(r.quantity) })));
    }
    if (result.success && lastRequest.current === "save") {
      setSaved(true);
      setShowErrors(false);
    }
  });

  const selectService = (id: string) => {
    setServiceId(id);
    setRows([]);
    setSaved(false);
    setShowErrors(false);
    lastRequest.current = "load";
    if (id && shopId) fetcher.load(`/api/shops/${shopId}/services/${id}/products`);
  };

  const invalid = rows.some((r) => !validUnits(r.quantity));

  const save = () => {
    if (!serviceId || !shopId) return;
    setSaved(false);
    if (invalid) {
      setShowErrors(true);
      return;
    }
    lastRequest.current = "save";
    fetcher.submit(
      { products: JSON.stringify(rows.map((r) => ({ product_id: r.product_id, quantity: Number(r.quantity) }))) },
      { method: "post", action: `/api/shops/${shopId}/services/${serviceId}/products` }
    );
  };

  const addProduct = (productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p || rows.some((r) => r.product_id === productId)) return;
    setSaved(false);
    setRows((r) => [...r, { product_id: p.id, quantity: "1", product_name: p.name }]);
  };

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 font-heading text-lg font-semibold text-white">
        <FlaskConical className="h-4 w-4 text-gold" aria-hidden /> Back-bar recipes
      </h2>
      <p className="mb-3 text-sm text-white/60">
        Products used each time a service is performed, deducted from stock automatically when the
        service is sold at checkout or the till. Use whole units (e.g. track colour in 10ml tubes).
      </p>

      {loadError ? (
        <LoadError what="your services and products" />
      ) : (
        <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
          <div className="max-w-sm">
            <Select label="Service" value={serviceId} onChange={(e) => selectService(e.target.value)}>
              <option value="">Choose a service</option>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>

          {serviceId && fetcher.data && !fetcher.data.success && lastRequest.current === "load" && fetcher.state === "idle" && (
            <p className="mt-4 text-sm text-red-400" role="alert">
              This service&apos;s recipe could not be loaded: {fetcher.data.error ?? "the request failed"}. Choose the service again to retry.
            </p>
          )}

          {serviceId && loadedFor && !(lastRequest.current === "load" && !fetcher.data?.success) && (
            <div className="mt-4 space-y-2">
              {rows.length === 0 && (
                <p className="text-sm text-white/60">No products linked to this service yet.</p>
              )}
              {rows.map((row, i) => (
                <div key={row.product_id} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-[9rem] flex-1 pt-2.5 text-white/70">{row.product_name}</span>
                  <div className="w-24">
                    <Input
                      label={`Units of ${row.product_name} per service`}
                      hideLabel
                      type="number" min="1" step="1" inputMode="numeric"
                      value={row.quantity}
                      onChange={(e) => {
                        setSaved(false);
                        setRows((r) => r.map((x, idx) => (idx === i ? { ...x, quantity: e.target.value } : x)));
                      }}
                      error={showErrors && !validUnits(row.quantity) ? "Enter 1 or more." : undefined}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSaved(false);
                      setRows((r) => r.filter((_, idx) => idx !== i));
                    }}
                    aria-label={`Remove ${row.product_name}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}

              <div className="flex flex-wrap items-end gap-3 pt-2">
                <div className="min-w-[12rem]">
                  <Select label="Add a product to the recipe" hideLabel value="" onChange={(e) => addProduct(e.target.value)}>
                    <option value="">Add a product…</option>
                    {products.filter((p) => !rows.some((r) => r.product_id === p.id)).map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
                <Button onClick={save} disabled={fetcher.state !== "idle"}>
                  {fetcher.state !== "idle" ? "Saving…" : "Save recipe"}
                </Button>
                {saved && fetcher.state === "idle" && (
                  <p className="text-sm text-emerald-300" role="status">Recipe saved.</p>
                )}
                {fetcher.data && !fetcher.data.success && lastRequest.current === "save" && fetcher.state === "idle" && (
                  <p className="text-sm text-red-400" role="alert">
                    The recipe was not saved: {fetcher.data.error ?? "the request failed"}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
