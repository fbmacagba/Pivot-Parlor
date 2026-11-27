import { Link, useFetcher } from "react-router";
import { useState } from "react";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { statusLabel } from "~/components/ui/StatusBadge";
import { RefundRequestFields } from "~/components/admin/RefundRequestFields";
import { refundAmountPence, tenderLabel } from "~/components/admin/salesSummary";
import { formatDateTime } from "~/lib/dateFormat";
import { refundEvidenceProblem, refundReasonProblem } from "~/lib/refundRequests";
import type { SaleDetail, SalesRefundActionData } from "~/lib/salesRefunds";
import { useFetcherResult } from "~/lib/useFetcherResult";

interface RefundPanelProps {
  shopId: string | null;
  detail: SaleDetail;
  /** Where "Close" goes: the page's own list, without the open sale. */
  closeHref: string;
  /** The owner's review page, for those who can open it; null for staff. */
  reviewHref: string | null;
  /** A request for this sale is already waiting for a decision. */
  requestPending: boolean;
}

/**
 * Ask for a refund on one till sale: pick quantities, choose whether product
 * lines go back into stock, say why, attach evidence if there is any. Posts
 * to the page's own action (lib/salesRefunds.ts), which files a request.
 */
export function RefundPanel({ shopId, detail, closeHref, reviewHref, requestPending }: RefundPanelProps) {
  const fetcher = useFetcher<SalesRefundActionData>();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [result, setResult] = useState<SalesRefundActionData | null>(null);
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
        <Link to={closeHref} className="tap-target inline-flex items-center text-xs text-white/70 hover:text-white">
          Close
        </Link>
      </div>

      {result && "ok" in result && (
        <p role="status" className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {result.message}
          {reviewHref && (
            <>
              {" "}
              <Link to={reviewHref} className="underline underline-offset-2">
                Open Refunds
              </Link>
            </>
          )}
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
            A refund request for this sale is waiting for {reviewHref ? "a decision" : "the owner's decision"}.
            {reviewHref && (
              <>
                {" "}
                <Link to={reviewHref} className="text-gold underline underline-offset-2">
                  Review it on Refunds
                </Link>
              </>
            )}
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
            This files a request. No money moves and nothing is restocked until the owner approves it
            {reviewHref ? " on the Refunds page" : ""}. Tips are not refunded. Back-bar products used during a service
            are not restocked.
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
