/**
 * Staff: ask for a refund on a till sale, and see what became of the
 * requests you filed. Nothing here moves money: a request carries a written
 * reason and, if there is one, an evidence file, and the owner approves or
 * declines it on their Refunds page (admin.refunds.tsx).
 */
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Receipt, Undo2 } from "lucide-react";
import { formatPence } from "@repo/utils";
import { ErrorScreen } from "~/components/ErrorScreen";
import { AddEvidence } from "~/components/admin/AddEvidence";
import { RefundPanel } from "~/components/admin/RefundPanel";
import { tenderLabel } from "~/components/admin/salesSummary";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { formatDateTime, formatDay, formatTime } from "~/lib/dateFormat";
import { pageTitle } from "~/lib/pageTitle";
import type { RefundRequest } from "~/lib/refundRequests";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { SALES_LIST_LIMIT, salesRefundAction, salesRefundLoader } from "~/lib/salesRefunds";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Refunds");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/staff" homeLabel="Back to today" />;
}

export function loader(args: LoaderFunctionArgs) {
  return salesRefundLoader(args, "staff");
}

export function action(args: ActionFunctionArgs) {
  return salesRefundAction(args, "staff");
}

/** What a request is for, in a line. */
function subjectOf(r: RefundRequest): string {
  const who = r.customer_name?.trim();
  if (r.kind === "deposit") return who ? `Booking deposit for ${who}` : "Booking deposit";
  const when = r.sale_created_at ? ` of ${formatDateTime(r.sale_created_at)}` : "";
  return who ? `Sale${when} to ${who}` : `Counter sale${when}`;
}

/** What happened to it, in a sentence. */
function outcomeOf(r: RefundRequest): string {
  const by = r.reviewed_by_name ?? "the owner";
  const on = r.reviewed_at ? ` on ${formatDateTime(r.reviewed_at)}` : "";
  if (r.status === "approved") return `Approved by ${by}${on}. ${formatPence(r.refunded_pence ?? r.amount_pence)} refunded.`;
  if (r.status === "declined") return `Declined by ${by}${on}. No money was refunded.`;
  return "Waiting for the owner's decision. No money has moved.";
}

export default function StaffRefunds() {
  const { shopId, date, sales, detail, loadError, detailError, pendingRefundSaleIds, myRequests, myRequestsError } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  const baseParams = new URLSearchParams(searchParams);
  baseParams.delete("sale");
  const baseQuery = baseParams.toString() ? `?${baseParams.toString()}` : "";

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Refunds</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Ask for a refund on a sale. The owner decides, and nothing is refunded until they approve.
        </p>
      </div>

      <section aria-labelledby="staff-refunds-sales" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="staff-refunds-sales" className="font-heading text-lg font-semibold text-white">
            Sales on {formatDay(date)}
          </h2>
          <Form method="get" className="flex items-end gap-2">
            <Input label="Date" type="date" name="date" defaultValue={date} className="tap-target" />
            <Button type="submit" variant="outline">Show</Button>
          </Form>
        </div>

        {detailError && <LoadError what="that sale" />}
        {detail && (
          <RefundPanel
            key={detail.id}
            shopId={shopId}
            detail={detail}
            closeHref={`/staff/refunds${baseQuery}`}
            reviewHref={null}
            requestPending={pendingRefundSaleIds.includes(detail.id)}
          />
        )}

        {loadError ? (
          <LoadError what={`the sales for ${formatDay(date)}`} />
        ) : sales.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 p-8 text-center text-sm text-white/60">
            No sales on {formatDay(date)}. Pick the day the sale was made.
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {sales.map((sale) => {
                const time = formatTime(sale.created_at, { hour: "2-digit", minute: "2-digit" });
                return (
                  <li
                    key={sale.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-dark-100 px-4 py-3"
                  >
                    <Receipt className="h-4 w-4 shrink-0 text-white/40" aria-hidden />
                    <div className="min-w-[9rem] flex-1">
                      <p className="truncate text-sm text-white">
                        {sale.customer_name || (sale.booking_id ? "Appointment checkout" : "Counter sale")}
                        <span className="ml-2 text-xs text-white/60">
                          {time}
                          {" · "}
                          {tenderLabel(sale.tender_type)}
                        </span>
                      </p>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-4">
                      <StatusBadge status={sale.status} />
                      <span className="w-20 text-right text-sm font-semibold text-gold">
                        {formatPence(sale.total_pence)}
                      </span>
                      {(sale.status === "completed" || sale.status === "refunded") && (
                        <Link
                          to={`/staff/refunds${baseQuery}${baseQuery ? "&" : "?"}sale=${sale.id}`}
                          className="tap-target flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/5 hover:text-white"
                          aria-label={`Ask for a refund on the ${formatPence(sale.total_pence)} sale at ${time}`}
                        >
                          <Undo2 className="h-3 w-3" aria-hidden /> Ask for refund
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {sales.length >= SALES_LIST_LIMIT && (
              <p className="text-xs text-white/60">Only the latest {SALES_LIST_LIMIT} sales of the day are listed.</p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="staff-refunds-mine" className="space-y-3">
        <h2 id="staff-refunds-mine" className="font-heading text-lg font-semibold text-white">
          Your requests
        </h2>
        {myRequestsError ? (
          <LoadError what="your refund requests" />
        ) : myRequests.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/20 p-6 text-sm text-white/60">
            You have not asked for a refund yet. Requests you file appear here with the owner&apos;s decision.
          </p>
        ) : (
          <ul className="space-y-2">
            {myRequests.map((r) => (
              <li key={r.id} className="rounded-xl border border-white/10 bg-dark-100 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <p className="min-w-0 break-words text-sm text-white">{subjectOf(r)}</p>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-sm font-semibold text-gold">{formatPence(r.amount_pence)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-white/60">
                  Asked on {formatDateTime(r.requested_at)}
                  {r.has_evidence ? " · evidence attached" : ""}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/70">{r.reason}</p>
                <p className="mt-2 text-sm text-white/70">{outcomeOf(r)}</p>
                {r.status === "pending" && !r.has_evidence && <AddEvidence shopId={shopId} requestId={r.id} />}
                {r.review_note && (
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/60">
                    Owner&apos;s note: {r.review_note}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
