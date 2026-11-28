import { useFetcher } from "react-router";
import { useState } from "react";
import { formatPence } from "@repo/utils";
import { RefundRequestFields } from "~/components/admin/RefundRequestFields";
import { Button } from "~/components/ui/Button";
import { refundEvidenceProblem, refundReasonProblem } from "~/lib/refundRequests";

type Answer = { ok: boolean; error?: string; message?: string };

/**
 * Ask the owner to refund the deposit on a staff member's own booking. Posts
 * `intent=refund_request` to the booking page's action, which files a request:
 * no money moves and the booking stands until the owner approves it.
 */
export function DepositRefundRequest({
  depositPence,
  requested,
  readOnly,
}: {
  /** The deposit that could still go back, in pence. */
  depositPence: number;
  /** A request for this deposit already waits for the owner. */
  requested: boolean;
  /** A developer viewing a staff member's screen. */
  readOnly: boolean;
}) {
  const fetcher = useFetcher<Answer>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);

  const busy = fetcher.state !== "idle";
  const filed = fetcher.data?.ok === true;
  const failed = !busy && fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? "The request could not be filed.") : null;
  const reasonProblem = refundReasonProblem(reason.trim());
  const fileProblem = refundEvidenceProblem(file);

  return (
    <section className="rounded-xl border border-white/10 bg-dark-100 p-5" aria-label="Deposit">
      <h2 className="font-heading text-base font-semibold text-white">Deposit</h2>
      <p className="mt-1 text-sm text-white/70">The customer paid a deposit of {formatPence(depositPence)}.</p>

      {requested || filed ? (
        <p role="status" className="mt-3 text-sm text-amber-200">
          A refund request for this deposit is waiting for the owner. No money has moved.
        </p>
      ) : readOnly ? null : !open ? (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setOpen(true)}>
          Ask for the deposit back
        </Button>
      ) : (
        <form
          className="mt-4 space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (reasonProblem || fileProblem) return;
            const form = new FormData();
            form.append("intent", "refund_request");
            form.append("reason", reason.trim());
            if (file) form.append("evidence", file, file.name);
            fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
          }}
        >
          <RefundRequestFields
            reason={reason}
            onReasonChange={setReason}
            reasonError={tried ? reasonProblem : null}
            file={file}
            onFileChange={setFile}
            disabled={busy}
          />
          <p className="text-xs text-white/60">
            This files a request. No money moves until the owner approves it. If they approve, the booking is cancelled
            and the deposit goes back to the customer.
          </p>
          {failed && (
            <p role="alert" className="text-sm text-red-400">
              {failed}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Filing…" : `Request refund of ${formatPence(depositPence)}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
