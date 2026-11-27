/**
 * WS-3 Phase 2: sales history and refund requests (admin only).
 * A refund is requested per line: pick quantities, choose whether product
 * lines go back into stock, say why, and attach evidence if there is any.
 * That files a request; the money moves only when the owner approves it on
 * the Refunds page (admin.refunds.tsx).
 */
import {
  Form,
  Link,
  useFetcher,
  useLoaderData,
  useSearchParams,
  data as json,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Receipt, Undo2 } from "lucide-react";
import { useState } from "react";
import { pageShopId, withShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge, statusLabel } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";
import { refundAmountPence, summariseSales, tenderLabel, type DaySummary } from "~/components/admin/salesSummary";
import { formatDateTime, formatDay, formatTime, ukToday } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { RefundRequestFields } from "~/components/admin/RefundRequestFields";
import {
  evidenceFrom,
  fileRefundRequest,
  refundEvidenceProblem,
  refundReasonProblem,
  type RefundRequest,
} from "~/lib/refundRequests";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Sales");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

/** The sales list answers with at most this many rows for a day. */
const SALES_LIST_LIMIT = 100;

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
  /** Sent on every row now; optional so a list from an older API still reads. */
  refunded_pence?: number | null;
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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);
  const url = new URL(request.url);
  // The shop's day, as the booking worker's sales list reads it.
  const today = ukToday();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date")! : today;
  const saleId = url.searchParams.get("sale");

  let sales: SaleRow[] = [];
  let detail: SaleDetail | null = null;
  let loadError = false;
  let detailError = false;
  // Sales that already have a refund request waiting: no second one is filed.
  let pendingRefundSaleIds: string[] = [];
  if (shopId) {
    const wantsDetail = Boolean(saleId && /^[A-Za-z0-9_-]{1,100}$/.test(saleId));
    const [salesRes, detailRes, pendingRes] = await Promise.allSettled([
      api.get<SaleRow[]>(`/api/shops/${shopId}/sales?date=${date}`),
      wantsDetail ? api.get<SaleDetail>(`/api/shops/${shopId}/sales/${saleId}`) : Promise.resolve(null),
      wantsDetail
        ? api.get<RefundRequest[]>(`/api/shops/${shopId}/refund-requests?status=pending`)
        : Promise.resolve([]),
    ]);
    if (pendingRes.status === "fulfilled") {
      pendingRefundSaleIds = (pendingRes.value ?? []).flatMap((r) => (r.sale_id ? [r.sale_id] : []));
    }
    if (salesRes.status === "fulfilled") sales = salesRes.value ?? [];
    else loadError = true;
    if (detailRes.status === "fulfilled") detail = detailRes.value;
    else detailError = true;
  }

  return json({
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
    date,
    sales,
    detail,
    loadError,
    detailError,
    pendingRefundSaleIds,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await readFormData(request);
  if (!form) return json<ActionData>({ error: UNREADABLE_FORM }, { status: 400 });
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "").trim() || null);
  const saleId = String(form.get("saleId") ?? "").trim();
  if (!shopId || !saleId) return json<ActionData>({ error: "Missing shop or sale." }, { status: 400 });

  let lines: Array<{ sale_item_id: string; quantity: number; restock: boolean }>;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    return json<ActionData>({ error: "Invalid refund payload." }, { status: 400 });
  }
  if (lines.length === 0) return json<ActionData>({ error: "Select at least one item to refund." }, { status: 400 });

  const reason = String(form.get("reason") ?? "").trim();
  const reasonProblem = refundReasonProblem(reason);
  if (reasonProblem) return json<ActionData>({ error: reasonProblem }, { status: 400 });
  const evidence = evidenceFrom(form);
  const evidenceProblem = refundEvidenceProblem(evidence);
  if (evidenceProblem) return json<ActionData>({ error: evidenceProblem }, { status: 400 });

  // This files a request. The refund itself runs only when the owner
  // approves it on the Refunds page.
  try {
    const filed = await fileRefundRequest(
      env.API_URL,
      token,
      shopId,
      { kind: "sale", sale_id: saleId, lines, reason },
      evidence
    );
    return json<ActionData>({
      ok: true,
      message: `Refund request for ${formatPence(filed.amount_pence)} filed. No money has moved: it waits for approval.`,
    });
  } catch (e) {
    return json<ActionData>({ error: e instanceof Error ? e.message : "The request could not be filed" }, { status: 400 });
  }
}

export default function AdminSales() {
  const { shopId, developerNeedsShop, date, sales, detail, loadError, detailError, pendingRefundSaleIds } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const baseParams = new URLSearchParams(searchParams);
  baseParams.delete("sale");
  const baseQuery = baseParams.toString() ? `?${baseParams.toString()}` : "";
  const summary = summariseSales(sales);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Sales</h1>
          <p className="mt-0.5 text-sm text-white/60">Till history and refund requests.</p>
        </div>
        <Form method="get" className="flex items-end gap-2">
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <Input label="Date" type="date" name="date" defaultValue={date} className="tap-target" />
          <Button type="submit" variant="outline">Show</Button>
        </Form>
      </div>

      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to view sales as a developer.
        </div>
      )}

      {detailError && <LoadError what="that sale" />}
      {detail && (
        <RefundPanel
          key={detail.id}
          shopId={shopId}
          detail={detail}
          baseQuery={baseQuery}
          requestPending={pendingRefundSaleIds.includes(detail.id)}
        />
      )}

      {loadError ? (
        <LoadError what={`the sales for ${formatDay(date)}`} />
      ) : sales.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-10 text-center text-sm text-white/60">
          No sales on {formatDay(date)}.
        </div>
      ) : (
        <>
          <DaySummaryCard summary={summary} date={date} capped={sales.length >= SALES_LIST_LIMIT} />
          <ul className="space-y-2">
            {sales.map((sale) => {
              const time = formatTime(sale.created_at, { hour: "2-digit", minute: "2-digit" });
              return (
                <li key={sale.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-dark-100 px-4 py-3">
                  <Receipt className="h-4 w-4 shrink-0 text-white/40" aria-hidden />
                  <div className="min-w-[9rem] flex-1">
                    <p className="truncate text-sm text-white">
                      {sale.customer_name || (sale.booking_id ? "Appointment checkout" : "Counter sale")}
                      <span className="ml-2 text-xs text-white/60">
                        {time}
                        {" · "}{tenderLabel(sale.tender_type)}
                      </span>
                    </p>
                  </div>
                  {/* Status, amount, refund: right-aligned, on their own line when a phone needs the room */}
                  <div className="ml-auto flex shrink-0 items-center gap-4">
                    <StatusBadge status={sale.status} />
                    <span className="w-20 text-right text-sm font-semibold text-gold">
                      {formatPence(sale.total_pence)}
                    </span>
                    {(sale.status === "completed" || sale.status === "refunded") && (
                      <Link
                        to={`/admin/sales${baseQuery}${baseQuery ? "&" : "?"}sale=${sale.id}`}
                        className="tap-target flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                        aria-label={`Refund the ${formatPence(sale.total_pence)} sale at ${time}`}
                      >
                        <Undo2 className="h-3 w-3" aria-hidden /> Refund
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** The day's totals for cashing up: how many sales, what was taken and how. */
function DaySummaryCard({ summary, date, capped }: { summary: DaySummary; date: string; capped: boolean }) {
  return (
    <section aria-label={`Totals for ${formatDay(date)}`} className="rounded-xl border border-white/10 bg-dark-100 p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-white/60">Sales</dt>
          <dd className="mt-0.5 text-lg font-bold text-white">{summary.count}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/60">Taken (gross)</dt>
          <dd className="mt-0.5 text-lg font-bold text-white">{formatPence(summary.gross_pence)}</dd>
        </div>
        {summary.refunds_pence !== null && summary.net_pence !== null && (
          <>
            <div>
              <dt className="text-xs text-white/60">Refunds</dt>
              <dd className="mt-0.5 text-lg font-bold text-white">{formatPence(summary.refunds_pence)}</dd>
            </div>
            <div>
              <dt className="text-xs text-white/60">Net</dt>
              <dd className="mt-0.5 text-lg font-bold text-gold">{formatPence(summary.net_pence)}</dd>
            </div>
          </>
        )}
      </dl>
      {summary.by_tender.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-white/10 pt-3 text-sm text-white/70">
          {summary.by_tender.map((t) => (
            <li key={t.tender}>
              {tenderLabel(t.tender)}: <span className="font-semibold text-white">{formatPence(t.gross_pence)}</span>{" "}
              <span className="text-xs text-white/60">({t.count} {t.count === 1 ? "sale" : "sales"})</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-white/60">
        Totals include tips and count every paid sale, including any refunded later. Unpaid and voided sales are left out.
        {summary.refunds_pence === null && " Refund totals are not shown here: open a sale to see what was refunded on it."}
        {capped && ` Only the latest ${SALES_LIST_LIMIT} sales of the day are listed, so these totals may be short.`}
      </p>
    </section>
  );
}

function RefundPanel({
  shopId, detail, baseQuery, requestPending,
}: { shopId: string | null; detail: SaleDetail; baseQuery: string; requestPending: boolean }) {
  const fetcher = useFetcher<ActionData>();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [result, setResult] = useState<ActionData | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    setResult(data);
    if ("ok" in data) {
      // The same request must not be one tap from repeating.
      setQtys({});
      setRestock({});
      setReason("");
      setFile(null);
      setTried(false);
      setFormKey((k) => k + 1);
    }
  });

  const lines = detail.items
    .map((item) => {
      const returnable = item.quantity - item.returned_quantity;
      const asked = Math.floor(Number(qtys[item.id] ?? "") || 0);
      return {
        sale_item_id: item.id,
        quantity: Math.max(0, Math.min(asked, returnable)),
        restock: restock[item.id] ?? true,
      };
    })
    .filter((l) => l.quantity > 0);

  const refundable = detail.subtotal_pence - detail.discount_pence - detail.refunded_pence;
  const amount = refundAmountPence(detail, lines);
  const reasonProblem = refundReasonProblem(reason);
  const fileProblem = refundEvidenceProblem(file);
  const filed = result !== null && "ok" in result;

  const submit = () => {
    setTried(true);
    if (lines.length === 0 || reasonProblem || fileProblem) return;
    setResult(null);
    const form = new FormData();
    if (shopId) form.append("shopId", shopId);
    form.append("saleId", detail.id);
    form.append("lines", JSON.stringify(lines));
    form.append("reason", reason.trim());
    if (file) form.append("evidence", file, file.name);
    fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <section aria-label="Request a refund on a sale" className="rounded-xl border border-gold/30 bg-gold/5 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-gold">
          Request a refund · {formatPence(detail.total_pence)} {tenderLabel(detail.tender_type)}
          <span className="ml-2 text-xs font-normal text-white/60">
            {detail.refunded_pence > 0 && `${formatPence(detail.refunded_pence)} already refunded · `}
            {formatPence(Math.max(0, refundable))} refundable
          </span>
        </p>
        <Link to={`/admin/sales${baseQuery}`} className="tap-target inline-flex items-center text-xs text-white/70 hover:text-white">
          Close
        </Link>
      </div>

      {result && "ok" in result && (
        <p role="status" className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {result.message}{" "}
          <Link to={withShopId("/admin/refunds", shopId)} className="underline underline-offset-2">
            Open Refunds
          </Link>
        </p>
      )}
      {result && "error" in result && (
        <p role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {result.error}
        </p>
      )}

      {detail.returns.length > 0 && (
        <ul className="mb-4 space-y-1 text-xs text-white/60">
          {detail.returns.map((r) => (
            <li key={r.id}>
              {formatDateTime(r.created_at)} · {formatPence(r.refund_pence)} ({statusLabel(r.status).toLowerCase()})
              {r.reason && ` · ${r.reason}`}
            </li>
          ))}
        </ul>
      )}

      {refundable <= 0 ? (
        <p className="text-sm text-white/60">This sale is fully refunded.</p>
      ) : requestPending || filed ? (
        !filed && (
          <p className="text-sm text-white/70">
            A refund request for this sale is waiting for a decision.{" "}
            <Link to={withShopId("/admin/refunds", shopId)} className="text-gold underline underline-offset-2">
              Review it on Refunds
            </Link>
          </p>
        )
      ) : (
        <form
          key={formKey}
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-2">
            {detail.items.map((item) => {
              const returnable = item.quantity - item.returned_quantity;
              return (
                <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-[9rem] flex-1 text-white/70">
                    {item.name}
                    <span className="ml-2 text-xs text-white/60">
                      {formatPence(item.unit_price_pence)} × {item.quantity}
                      {item.returned_quantity > 0 && ` · ${item.returned_quantity} returned`}
                    </span>
                  </span>
                  {returnable > 0 ? (
                    <>
                      <div className="w-24">
                        <Input
                          label={`Quantity of ${item.name} to refund`}
                          hideLabel
                          type="number" min="0" max={returnable} step="1" inputMode="numeric"
                          placeholder={`Up to ${returnable}`}
                          value={qtys[item.id] ?? ""}
                          onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                        />
                      </div>
                      {item.item_type === "product" && (
                        <label className="tap-target flex cursor-pointer items-center gap-2 text-xs text-white/70">
                          <input
                            type="checkbox"
                            checked={restock[item.id] ?? true}
                            onChange={(e) => setRestock((r) => ({ ...r, [item.id]: e.target.checked }))}
                            className="h-4 w-4 rounded border-white/40 bg-white/5 text-gold focus:ring-gold"
                          />
                          Put back in stock
                        </label>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-white/60">Fully returned</span>
                  )}
                </div>
              );
            })}
          </div>
          <RefundRequestFields
            reason={reason}
            onReasonChange={setReason}
            reasonError={tried ? reasonProblem : null}
            file={file}
            onFileChange={setFile}
            disabled={busy}
          />
          <p className="text-xs text-white/60">
            This files a request. No money moves and nothing is restocked until the owner approves it on the Refunds
            page. Tips are not refunded. Back-bar products used during a service are not restocked.
          </p>
          <Button type="submit" size="sm" disabled={busy || lines.length === 0}>
            {busy
              ? "Filing…"
              : lines.length === 0
                ? "Choose items to refund"
                : `Request refund of ${formatPence(amount)}`}
          </Button>
        </form>
      )}
    </section>
  );
}
