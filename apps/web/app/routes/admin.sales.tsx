/**
 * WS-3 Phase 2 — sales history + returns/refunds (admin only).
 * Refunds are per-line: pick quantities, choose whether product lines go back
 * into stock, add a reason. Cash/card-external refunds settle immediately
 * (the shop hands the money back); Stripe refunds go through the API and
 * complete when Stripe confirms (charge.refunded).
 */
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Receipt, Undo2 } from "lucide-react";
import { useState } from "react";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

interface SaleRow {
  id: string;
  booking_id: string | null;
  customer_name: string | null;
  subtotal_pence: number;
  discount_pence: number;
  tip_pence: number;
  total_pence: number;
  tender_type: string;
  status: string;
  created_at: string;
}

interface SaleItem {
  id: string;
  item_type: string;
  name: string;
  quantity: number;
  returned_quantity: number;
  unit_price_pence: number;
  line_total_pence: number;
}

interface SaleReturn {
  id: string;
  refund_pence: number;
  status: string;
  reason: string | null;
  created_at: string;
}

interface SaleDetail extends SaleRow {
  refunded_pence: number;
  items: SaleItem[];
  returns: SaleReturn[];
}

type ActionData = { ok: true; message: string } | { error: string };

function resolveShopId(request: Request, user: SessionPayload, formShopId: string | null): string | null {
  const url = new URL(request.url);
  if (user.role === "developer") {
    return formShopId?.trim() || url.searchParams.get("shopId")?.trim() || null;
  }
  return user.shop_id?.trim() || null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = resolveShopId(request, user, null);
  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date")! : today;
  const saleId = url.searchParams.get("sale");

  let sales: SaleRow[] = [];
  let detail: SaleDetail | null = null;
  if (shopId) {
    try {
      sales = await api.get<SaleRow[]>(`/api/shops/${shopId}/sales?date=${date}`);
      if (saleId) {
        detail = await api.get<SaleDetail>(`/api/shops/${shopId}/sales/${saleId}`).catch(() => null);
      }
    } catch {
      /* empty */
    }
  }

  return json({ shopId, developerNeedsShop: user.role === "developer" && !shopId, date, sales, detail });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const shopId = resolveShopId(request, user, String(form.get("shopId") ?? "").trim() || null);
  const saleId = String(form.get("saleId") ?? "").trim();
  if (!shopId || !saleId) return json<ActionData>({ error: "Missing shop or sale." }, { status: 400 });

  let lines: Array<{ sale_item_id: string; quantity: number; restock: boolean }>;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    return json<ActionData>({ error: "Invalid refund payload." }, { status: 400 });
  }
  if (lines.length === 0) return json<ActionData>({ error: "Select at least one item to refund." }, { status: 400 });

  const api = createApiClient(env.API_URL, token);
  try {
    const result = await api.post<{ refund_pence: number; status: string }>(
      `/api/shops/${shopId}/sales/${saleId}/refund`,
      { lines, reason: String(form.get("reason") ?? "").trim() || undefined }
    );
    return json<ActionData>({
      ok: true,
      message:
        result.status === "completed"
          ? `Refunded ${formatPence(result.refund_pence)}.`
          : `Refund of ${formatPence(result.refund_pence)} sent to Stripe — it completes when Stripe confirms.`,
    });
  } catch (e) {
    return json<ActionData>({ error: e instanceof Error ? e.message : "Refund failed" }, { status: 400 });
  }
}

const STATUS_PILL: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-300",
  completed: "bg-emerald-500/10 text-emerald-300",
  refunded: "bg-purple-500/10 text-purple-300",
  disputed: "bg-red-500/10 text-red-300",
  voided: "bg-white/10 text-white/60",
};

export default function AdminSales() {
  const { shopId, developerNeedsShop, date, sales, detail } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = nav.state === "submitting";

  const baseParams = new URLSearchParams(searchParams);
  baseParams.delete("sale");
  const baseQuery = baseParams.toString() ? `?${baseParams.toString()}` : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Sales</h1>
          <p className="mt-0.5 text-sm text-white/60">Till history and refunds.</p>
        </div>
        <Form method="get" className="flex items-end gap-2">
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <label className="text-xs text-white/50">
            Date
            <input
              type="date"
              name="date"
              defaultValue={date}
              className="mt-1 block rounded-lg border border-white/10 bg-dark-100 px-3 py-2 text-sm text-white"
            />
          </label>
          <Button type="submit" size="sm" variant="outline">Show</Button>
        </Form>
      </div>

      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to view sales as a developer.
        </div>
      )}

      {actionData && "ok" in actionData && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {actionData.message}
        </div>
      )}
      {actionData && "error" in actionData && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200" role="alert">
          {actionData.error}
        </div>
      )}

      {detail && <RefundPanel shopId={shopId} detail={detail} baseQuery={baseQuery} isSubmitting={isSubmitting} />}

      {sales.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-10 text-center text-sm text-white/60">
          No sales on {date}.
        </div>
      ) : (
        <div className="space-y-2">
          {sales.map((sale) => (
            <div key={sale.id} className="flex items-center gap-4 rounded-xl border border-white/10 bg-dark-100 px-4 py-3">
              <Receipt className="h-4 w-4 shrink-0 text-white/40" />
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm text-white">
                  {sale.customer_name || (sale.booking_id ? "Appointment checkout" : "Counter sale")}
                  <span className="ml-2 text-xs text-white/50">
                    {new Date(sale.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    {" · "}{sale.tender_type.replace("_", " ")}
                  </span>
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[sale.status] ?? "bg-white/10 text-white/50"}`}>
                {sale.status}
              </span>
              <span className="w-20 shrink-0 text-right text-sm font-semibold text-gold">
                {formatPence(sale.total_pence)}
              </span>
              {(sale.status === "completed" || sale.status === "refunded") && (
                <Link
                  to={`/admin/sales${baseQuery}${baseQuery ? "&" : "?"}sale=${sale.id}`}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <Undo2 className="h-3 w-3" /> Refund
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RefundPanel({
  shopId, detail, baseQuery, isSubmitting,
}: { shopId: string | null; detail: SaleDetail; baseQuery: string; isSubmitting: boolean }) {
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});

  const lines = detail.items
    .map((item) => ({
      sale_item_id: item.id,
      quantity: Number(qtys[item.id] ?? "") || 0,
      restock: restock[item.id] ?? true,
    }))
    .filter((l) => l.quantity > 0);

  const refundable = detail.subtotal_pence - detail.discount_pence - detail.refunded_pence;

  return (
    <div className="rounded-xl border border-gold/30 bg-gold/5 p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-semibold text-gold">
          Refund sale · {formatPence(detail.total_pence)} {detail.tender_type.replace("_", " ")}
          <span className="ml-2 text-xs font-normal text-white/60">
            {detail.refunded_pence > 0 && `${formatPence(detail.refunded_pence)} already refunded · `}
            {formatPence(Math.max(0, refundable))} refundable
          </span>
        </p>
        <Link to={`/admin/sales${baseQuery}`} className="text-xs text-white/60 hover:text-white">Close</Link>
      </div>

      {detail.returns.length > 0 && (
        <ul className="mb-4 space-y-1 text-xs text-white/60">
          {detail.returns.map((r) => (
            <li key={r.id}>
              {new Date(r.created_at).toLocaleString("en-GB")} — {formatPence(r.refund_pence)} ({r.status})
              {r.reason && ` · ${r.reason}`}
            </li>
          ))}
        </ul>
      )}

      {refundable <= 0 ? (
        <p className="text-sm text-white/60">This sale is fully refunded.</p>
      ) : (
        <Form method="post" className="space-y-3">
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <input type="hidden" name="saleId" value={detail.id} />
          <input type="hidden" name="lines" value={JSON.stringify(lines)} />
          <div className="space-y-2">
            {detail.items.map((item) => {
              const returnable = item.quantity - item.returned_quantity;
              return (
                <div key={item.id} className="flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate text-white/70">
                    {item.name}
                    <span className="ml-2 text-xs text-white/50">
                      {formatPence(item.unit_price_pence)} × {item.quantity}
                      {item.returned_quantity > 0 && ` · ${item.returned_quantity} returned`}
                    </span>
                  </span>
                  {returnable > 0 ? (
                    <>
                      <input
                        type="number" min="0" max={returnable} step="1"
                        placeholder={`0–${returnable}`}
                        value={qtys[item.id] ?? ""}
                        onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                        className="w-20 rounded-lg border border-white/10 bg-dark-100 px-2 py-1.5 text-sm text-white"
                        aria-label={`Quantity of ${item.name} to refund`}
                      />
                      {item.item_type === "product" && (
                        <label className="flex items-center gap-1.5 text-xs text-white/50">
                          <input
                            type="checkbox"
                            checked={restock[item.id] ?? true}
                            onChange={(e) => setRestock((r) => ({ ...r, [item.id]: e.target.checked }))}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-dark-100"
                          />
                          restock
                        </label>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-white/50">fully returned</span>
                  )}
                </div>
              );
            })}
          </div>
          <Input label="Reason" name="reason" placeholder="e.g. product returned unopened" />
          <p className="text-xs text-white/60">
            Tips are not refunded here. Back-bar products used during a service are not restocked.
            {detail.tender_type !== "stripe" && " You hand the money back at the till — this records it."}
          </p>
          <Button type="submit" size="sm" disabled={isSubmitting || lines.length === 0}>
            {isSubmitting ? "Refunding…" : "Refund selected →"}
          </Button>
        </Form>
      )}
    </div>
  );
}
