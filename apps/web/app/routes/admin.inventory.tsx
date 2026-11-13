/**
 * WS-3 Phase 2 — inventory operations in one place:
 *   · retail/COGS report (last 30 days)
 *   · purchase orders (draft → ordered → receive)
 *   · stock-take sessions (count → complete emits adjustments)
 *   · back-bar recipes (service_products BOM — consumed when a service sells)
 */
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { ClipboardList, FlaskConical, Package, Plus, Truck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/Dialog";
import { formatDate, formatDateTime } from "~/lib/dateFormat";

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

interface Report {
  from: string;
  to: string;
  retail: { revenue_pence: number; cogs_pence: number; margin_pence: number; units_sold: number };
  by_product: Array<{ product_id: string | null; name: string; units_sold: number; revenue_pence: number; cogs_pence: number }>;
  by_staff: Array<{ staff_id: string | null; staff_name: string | null; units_sold: number; revenue_pence: number }>;
  consumption: { units_consumed: number; cost_pence: number };
}

type ActionData = { ok: true; intent: string } | { error: string };

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
  let openStockTake: (StockTakeRow & { items: StockTakeItem[] }) | null = null;

  if (shopId) {
    try {
      [products, suppliers, services, purchaseOrders, stockTakes, report] = await Promise.all([
        api.get<Product[]>(`/api/shops/${shopId}/products`),
        api.get<Supplier[]>(`/api/shops/${shopId}/suppliers`),
        api.get<Service[]>(`/api/shops/${shopId}/services`),
        api.get<PoListRow[]>(`/api/shops/${shopId}/purchase-orders`),
        api.get<StockTakeRow[]>(`/api/shops/${shopId}/stock-takes`),
        api.get<Report>(`/api/shops/${shopId}/inventory/report`),
      ]);
      if (poId) {
        poDetail = await api.get<PoDetail>(`/api/shops/${shopId}/purchase-orders/${poId}`).catch(() => null);
      }
      const open = stockTakes.find((s) => s.status === "open");
      if (open) {
        openStockTake = await api
          .get<StockTakeRow & { items: StockTakeItem[] }>(`/api/shops/${shopId}/stock-takes/${open.id}`)
          .catch(() => null);
      }
    } catch {
      /* sections render empty */
    }
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
    openStockTake,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
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

const PO_STATUS_PILL: Record<string, string> = {
  draft: "bg-white/10 text-white/60",
  ordered: "bg-blue-500/10 text-blue-300",
  partial: "bg-amber-500/10 text-amber-300",
  received: "bg-emerald-500/10 text-emerald-300",
  cancelled: "bg-red-500/10 text-red-300",
};

export default function AdminInventory() {
  const {
    shopId, developerNeedsShop, products, suppliers, services,
    purchaseOrders, stockTakes, report, poDetail, openStockTake,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";
  const activeProducts = products.filter((p) => p.is_active === 1);
  const shopQuery = shopId ? `?shopId=${shopId}` : "";

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

      {actionData && "error" in actionData && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
          {actionData.error}
        </div>
      )}

      {report && <ReportSection report={report} />}

      <PurchaseOrdersSection
        shopId={shopId}
        shopQuery={shopQuery}
        purchaseOrders={purchaseOrders}
        poDetail={poDetail}
        suppliers={suppliers.filter((s) => s.is_active === 1)}
        products={activeProducts}
        isSubmitting={isSubmitting}
      />

      <StockTakeSection
        shopId={shopId}
        stockTakes={stockTakes}
        openStockTake={openStockTake}
        products={activeProducts.filter((p) => p.track_stock === 1)}
        isSubmitting={isSubmitting}
      />

      <BackBarSection shopId={shopId} services={services.filter((s) => s.isActive)} products={activeProducts} />
    </div>
  );
}

// ─── Report ───────────────────────────────────────────────────────────────────

function ReportSection({ report }: { report: Report }) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 font-heading text-lg font-semibold text-white">
        <Package className="h-4 w-4 text-gold" /> Retail performance
        <span className="text-xs font-normal text-white/50">{report.from} → {report.to}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Retail revenue" value={formatPence(report.retail.revenue_pence)} />
        <StatCard label="COGS" value={formatPence(report.retail.cogs_pence)} />
        <StatCard label="Margin" value={formatPence(report.retail.margin_pence)} accent />
        <StatCard label="Back-bar cost" value={formatPence(report.consumption.cost_pence)} />
      </div>
      {report.by_product.length > 0 && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/50">Top products</p>
            <ul className="space-y-1.5 text-sm">
              {report.by_product.slice(0, 5).map((row) => (
                <li key={row.product_id ?? row.name} className="flex justify-between gap-3">
                  <span className="truncate text-white/70">{row.name} <span className="text-white/50">×{row.units_sold}</span></span>
                  <span className="shrink-0 text-white">{formatPence(row.revenue_pence)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/50">Retail by staff</p>
            {report.by_staff.length === 0 ? (
              <p className="text-sm text-white/50">No attributed retail sales in this period.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {report.by_staff.slice(0, 5).map((row) => (
                  <li key={row.staff_id} className="flex justify-between gap-3">
                    <span className="truncate text-white/70">{row.staff_name ?? "Unknown"} <span className="text-white/50">×{row.units_sold}</span></span>
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

// ─── Purchase orders ──────────────────────────────────────────────────────────

interface DraftLine { product_id: string; quantity: number; unit_cost: string }

function PurchaseOrdersSection({
  shopId, shopQuery, purchaseOrders, poDetail, suppliers, products, isSubmitting,
}: {
  shopId: string | null;
  shopQuery: string;
  purchaseOrders: PoListRow[];
  poDetail: PoDetail | null;
  suppliers: Supplier[];
  products: Product[];
  isSubmitting: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const actionData = useActionData<typeof action>();

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.intent === "po-create") {
      setCreateOpen(false);
      setLines([]);
    }
  }, [actionData]);

  const addLine = () => {
    const first = products[0];
    if (!first) return;
    setLines((l) => [...l, { product_id: first.id, quantity: 1, unit_cost: (first.cost_price_pence / 100).toFixed(2) }]);
  };
  const patchLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((l) => l.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold text-white">
          <Truck className="h-4 w-4 text-gold" /> Purchase orders
        </h2>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!shopId || products.length === 0}>
              <Plus className="h-4 w-4" /> New order
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
              <label className="block text-sm text-white/70">
                Supplier
                <select name="supplier_id" className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-3 py-2 text-sm text-white" defaultValue="">
                  <option value="">None</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-white/50">Lines</p>
                {lines.map((line, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <label className="flex-1 text-xs text-white/50">
                      Product
                      <select
                        value={line.product_id}
                        onChange={(e) => {
                          const p = products.find((x) => x.id === e.target.value);
                          patchLine(i, { product_id: e.target.value, unit_cost: p ? (p.cost_price_pence / 100).toFixed(2) : line.unit_cost });
                        }}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-2 py-2 text-sm text-white"
                      >
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </label>
                    <label className="w-16 text-xs text-white/50">
                      Qty
                      <input
                        type="number" min="1" step="1" value={line.quantity}
                        onChange={(e) => patchLine(i, { quantity: Number(e.target.value) })}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-2 py-2 text-sm text-white"
                      />
                    </label>
                    <label className="w-20 text-xs text-white/50">
                      Cost £
                      <input
                        type="number" min="0" step="0.01" value={line.unit_cost}
                        onChange={(e) => patchLine(i, { unit_cost: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-2 py-2 text-sm text-white"
                      />
                    </label>
                    <button type="button" onClick={() => setLines((l) => l.filter((_, idx) => idx !== i))}
                      className="mb-1 rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white" aria-label="Remove line">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addLine} className="text-xs text-gold hover:underline">+ Add line</button>
              </div>

              <Input label="Notes" name="notes" placeholder="e.g. monthly restock" />
              <Button type="submit" className="w-full" disabled={isSubmitting || lines.length === 0}>
                {isSubmitting ? "Saving…" : "Create draft →"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {purchaseOrders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-sm text-white/60">
          No purchase orders yet. Create one to restock from a supplier.
        </div>
      ) : (
        <div className="space-y-2">
          {purchaseOrders.map((po) => (
            <div key={po.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-dark-100 p-4">
              <div className="min-w-[9rem] flex-1">
                <p className="truncate text-sm font-medium text-white">
                  {po.supplier_name ?? "No supplier"}
                  <span className="ml-2 text-xs text-white/50">{formatDate(po.created_at)}</span>
                </p>
                <p className="mt-0.5 text-xs text-white/60">
                  {po.total_received_qty}/{po.total_qty} received · {formatPence(po.total_pence)}
                  {po.notes && ` · ${po.notes}`}
                </p>
              </div>
              <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PO_STATUS_PILL[po.status]}`}>
                {po.status}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {po.status === "draft" && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="po-order" />
                    <input type="hidden" name="poId" value={po.id} />
                    {shopId && <input type="hidden" name="shopId" value={shopId} />}
                    <button type="submit" disabled={isSubmitting}
                      className="tap-target rounded-lg border border-blue-500/30 px-3 py-1.5 text-xs text-blue-300 hover:bg-blue-500/10 disabled:opacity-50">
                      Mark ordered
                    </button>
                  </Form>
                )}
                {(po.status === "ordered" || po.status === "partial") && (
                  <Link
                    to={`/admin/inventory${shopQuery}${shopQuery ? "&" : "?"}po=${po.id}`}
                    className="tap-target flex items-center rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/10"
                  >
                    Receive
                  </Link>
                )}
                {(po.status === "draft" || po.status === "ordered") && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="po-cancel" />
                    <input type="hidden" name="poId" value={po.id} />
                    {shopId && <input type="hidden" name="shopId" value={shopId} />}
                    <button type="submit" disabled={isSubmitting}
                      className="tap-target rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-400/80 hover:bg-red-500/10 disabled:opacity-50">
                      Cancel
                    </button>
                  </Form>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {poDetail && (poDetail.status === "ordered" || poDetail.status === "partial") && (
        <ReceiveDialog shopId={shopId} shopQuery={shopQuery} po={poDetail} isSubmitting={isSubmitting} />
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
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-emerald-200">
          Receive delivery: {po.supplier_name ?? "no supplier"}
        </p>
        <Link to={`/admin/inventory${shopQuery}`} className="text-xs text-white/60 hover:text-white">Close</Link>
      </div>
      <Form method="post" className="space-y-3">
        <input type="hidden" name="intent" value="po-receive" />
        <input type="hidden" name="poId" value={po.id} />
        {shopId && <input type="hidden" name="shopId" value={shopId} />}
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />
        <div className="space-y-2">
          {po.items.map((item) => {
            const outstanding = item.quantity - item.received_qty;
            return (
              <div key={item.id} className="flex items-center gap-3 text-sm">
                <span className="flex-1 truncate text-white/70">
                  {item.product_name}{item.variant_name && ` (${item.variant_name})`}
                  <span className="ml-2 text-xs text-white/50">
                    {item.received_qty}/{item.quantity} received · {formatPence(item.unit_cost_pence)} each
                  </span>
                </span>
                {outstanding > 0 ? (
                  <input
                    type="number" min="0" max={outstanding} step="1"
                    placeholder={`Up to ${outstanding}`}
                    value={qtys[item.id] ?? ""}
                    onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                    className="w-24 rounded-lg border border-white/10 bg-dark-100 px-2 py-1.5 text-sm text-white"
                  />
                ) : (
                  <span className="text-xs text-emerald-300">complete</span>
                )}
              </div>
            );
          })}
        </div>
        <Button type="submit" size="sm" disabled={isSubmitting || lines.length === 0}>
          {isSubmitting ? "Receiving…" : "Receive into stock →"}
        </Button>
      </Form>
    </div>
  );
}

// ─── Stock takes ──────────────────────────────────────────────────────────────

function StockTakeSection({
  shopId, stockTakes, openStockTake, products, isSubmitting,
}: {
  shopId: string | null;
  stockTakes: StockTakeRow[];
  openStockTake: (StockTakeRow & { items: StockTakeItem[] }) | null;
  products: Product[];
  isSubmitting: boolean;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const countedByProduct = new Map((openStockTake?.items ?? []).map((i) => [i.product_id, i]));
  const entries = products
    .map((p) => ({ product_id: p.id, counted_qty: Number(counts[p.id] ?? "") }))
    .filter((e) => counts[e.product_id] !== undefined && counts[e.product_id] !== "" && Number.isInteger(e.counted_qty) && e.counted_qty >= 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold text-white">
          <ClipboardList className="h-4 w-4 text-gold" /> Stock takes
        </h2>
        {!openStockTake && (
          <Form method="post">
            <input type="hidden" name="intent" value="st-open" />
            {shopId && <input type="hidden" name="shopId" value={shopId} />}
            <Button size="sm" type="submit" disabled={!shopId || isSubmitting || products.length === 0}>
              <Plus className="h-4 w-4" /> Start stock take
            </Button>
          </Form>
        )}
      </div>

      {openStockTake && (
        <div className="mb-4 rounded-xl border border-gold/30 bg-gold/5 p-4">
          <p className="mb-3 text-sm font-semibold text-gold">
            Stock take in progress
            <span className="ml-2 text-xs font-normal text-white/60">
              started {formatDateTime(openStockTake.created_at)} · {openStockTake.items.length} counted
            </span>
          </p>

          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="st-count" />
            <input type="hidden" name="stockTakeId" value={openStockTake.id} />
            {shopId && <input type="hidden" name="shopId" value={shopId} />}
            <input type="hidden" name="counts" value={JSON.stringify(entries)} />
            <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {products.map((p) => {
                const existing = countedByProduct.get(p.id);
                return (
                  <div key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="flex-1 truncate text-white/70">
                      {p.name}
                      <span className="ml-2 text-xs text-white/50">
                        system: {p.total_quantity}
                        {existing && ` · counted: ${existing.counted_qty}`}
                      </span>
                    </span>
                    <input
                      type="number" min="0" step="1"
                      placeholder={existing ? String(existing.counted_qty) : "count"}
                      value={counts[p.id] ?? ""}
                      onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value }))}
                      className="w-24 rounded-lg border border-white/10 bg-dark-100 px-2 py-1.5 text-sm text-white"
                    />
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

          <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
            <Form method="post">
              <input type="hidden" name="intent" value="st-complete" />
              <input type="hidden" name="stockTakeId" value={openStockTake.id} />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <Button type="submit" size="sm" disabled={isSubmitting || openStockTake.items.length === 0}>
                Complete and apply adjustments
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="st-cancel" />
              <input type="hidden" name="stockTakeId" value={openStockTake.id} />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <button type="submit" disabled={isSubmitting}
                className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-400/80 hover:bg-red-500/10 disabled:opacity-50">
                Cancel session
              </button>
            </Form>
          </div>
        </div>
      )}

      {stockTakes.filter((s) => s.status !== "open").length === 0 && !openStockTake ? (
        <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-sm text-white/60">
          No stock takes yet. Start one to count shelves and reconcile the system quantities.
        </div>
      ) : (
        <div className="space-y-2">
          {stockTakes.filter((s) => s.status !== "open").slice(0, 8).map((st) => (
            <div key={st.id} className="flex items-center gap-4 rounded-xl border border-white/10 bg-dark-100 px-4 py-3 text-sm">
              <span className="flex-1 text-white/70">
                {formatDate(st.created_at)}
                <span className="ml-2 text-xs text-white/50">{st.item_count} items counted</span>
              </span>
              {st.status === "completed" && (
                <span className={`text-xs ${st.variance_qty === 0 ? "text-white/60" : st.variance_qty > 0 ? "text-emerald-300" : "text-amber-300"}`}>
                  variance {st.variance_qty > 0 ? `+${st.variance_qty}` : st.variance_qty}
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-xs ${st.status === "completed" ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
                {st.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Back-bar recipes (BOM) ───────────────────────────────────────────────────

interface BomRow { product_id: string; quantity: number; product_name: string }

function BackBarSection({
  shopId, services, products,
}: { shopId: string | null; services: Service[]; products: Product[] }) {
  const [serviceId, setServiceId] = useState("");
  const [rows, setRows] = useState<BomRow[]>([]);
  const fetcher = useFetcher<{ success: boolean; data?: BomRow[]; error?: string }>();
  const loadedFor = fetcher.data && fetcher.state === "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data.data) {
      setRows(fetcher.data.data);
    }
  }, [fetcher.state, fetcher.data]);

  const selectService = (id: string) => {
    setServiceId(id);
    setRows([]);
    if (id && shopId) fetcher.load(`/api/shops/${shopId}/services/${id}/products`);
  };

  const save = () => {
    if (!serviceId || !shopId) return;
    fetcher.submit(
      { products: JSON.stringify(rows.map((r) => ({ product_id: r.product_id, quantity: r.quantity }))) },
      { method: "post", action: `/api/shops/${shopId}/services/${serviceId}/products` }
    );
  };

  const addProduct = (productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p || rows.some((r) => r.product_id === productId)) return;
    setRows((r) => [...r, { product_id: p.id, quantity: 1, product_name: p.name }]);
  };

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 font-heading text-lg font-semibold text-white">
        <FlaskConical className="h-4 w-4 text-gold" /> Back-bar recipes
      </h2>
      <p className="mb-3 text-sm text-white/60">
        Products used each time a service is performed, deducted from stock automatically when the
        service is sold at checkout or the till. Use whole units (e.g. track colour in 10ml tubes).
      </p>

      <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
        <label className="block max-w-sm text-sm text-white/70">
          Service
          <select
            value={serviceId}
            onChange={(e) => selectService(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-dark px-3 py-2 text-sm text-white"
          >
            <option value="">Choose a service</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        {serviceId && loadedFor && (
          <div className="mt-4 space-y-2">
            {rows.length === 0 && (
              <p className="text-sm text-white/50">No products linked to this service yet.</p>
            )}
            {rows.map((row, i) => (
              <div key={row.product_id} className="flex items-center gap-3 text-sm">
                <span className="flex-1 truncate text-white/70">{row.product_name}</span>
                <input
                  type="number" min="1" step="1" value={row.quantity}
                  onChange={(e) =>
                    setRows((r) => r.map((x, idx) => (idx === i ? { ...x, quantity: Number(e.target.value) || 1 } : x)))
                  }
                  className="w-20 rounded-lg border border-white/10 bg-dark px-2 py-1.5 text-sm text-white"
                  aria-label={`Units of ${row.product_name} per service`}
                />
                <button
                  type="button"
                  onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}
                  className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white"
                  aria-label={`Remove ${row.product_name}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <select
                value=""
                onChange={(e) => addProduct(e.target.value)}
                className="rounded-lg border border-white/10 bg-dark px-3 py-2 text-sm text-white"
                aria-label="Add product to recipe"
              >
                <option value="">+ add product…</option>
                {products.filter((p) => !rows.some((r) => r.product_id === p.id)).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <Button size="sm" onClick={save} disabled={fetcher.state !== "idle"}>
                {fetcher.state !== "idle" ? "Saving…" : "Save recipe"}
              </Button>
              {fetcher.data && !fetcher.data.success && (
                <p className="text-sm text-red-400" role="alert">{fetcher.data.error}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
