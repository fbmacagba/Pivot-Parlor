/**
 * WS-3 Phase 2: sales history and refund requests (admin only).
 * A refund is requested per line: pick quantities, choose whether product
 * lines go back into stock, say why, and attach evidence if there is any.
 * That files a request; the money moves only when the owner approves it on
 * the Refunds page (admin.refunds.tsx).
 */
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Receipt, Undo2 } from "lucide-react";
import { withShopId } from "~/lib/pageShop";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";
import { summariseSales, tenderLabel, type DaySummary } from "~/components/admin/salesSummary";
import { formatDay, formatTime } from "~/lib/dateFormat";
import { pageTitle } from "~/lib/pageTitle";
import { RefundPanel } from "~/components/admin/RefundPanel";
import { SALES_LIST_LIMIT, salesRefundAction, salesRefundLoader } from "~/lib/salesRefunds";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Sales");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

export function loader(args: LoaderFunctionArgs) {
  return salesRefundLoader(args, "admin");
}

export function action(args: ActionFunctionArgs) {
  return salesRefundAction(args, "admin");
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
          closeHref={`/admin/sales${baseQuery}`}
          reviewHref={withShopId("/admin/refunds", shopId)}
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
