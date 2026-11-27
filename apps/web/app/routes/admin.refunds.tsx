/**
 * Refund review (admin only). Every refund starts as a request with a written
 * reason and, where there is one, an evidence file. Nothing is paid back until
 * the owner approves the request here; a declined request can never be paid.
 */
import { Link, useFetcher, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { FileText, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { formatPence } from "@repo/utils";
import { pageShopId, withShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/Dialog";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { Textarea } from "~/components/ui/Textarea";
import { ErrorScreen } from "~/components/ErrorScreen";
import { tenderLabel } from "~/components/admin/salesSummary";
import { formatDateTime, formatDay } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { selfApprovalBlocked, type RefundRequest } from "~/lib/refundRequests";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Refunds");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

type ActionData = { ok: true; message: string } | { error: string };

const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const api = createApiClient(env.API_URL, getSessionToken(request));
  const shopId = pageShopId(request, user, null);

  let requests: RefundRequest[] = [];
  let loadError = false;
  if (shopId) {
    try {
      requests = (await api.get<RefundRequest[]>(`/api/shops/${shopId}/refund-requests`)) ?? [];
    } catch {
      loadError = true;
    }
  }
  return json({
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
    // Who is looking: their own requests need evidence before they approve.
    userId: user.sub,
    requests,
    loadError,
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
  const requestId = String(form.get("requestId") ?? "").trim();
  const intent = String(form.get("intent") ?? "");
  if (!shopId || !REQUEST_ID.test(requestId)) {
    return json<ActionData>({ error: "Missing shop or refund request." }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, token);
  try {
    if (intent === "decline") {
      const note = String(form.get("note") ?? "").trim();
      await api.post(`/api/shops/${shopId}/refund-requests/${requestId}/decline`, note ? { note } : {});
      return json<ActionData>({ ok: true, message: "Request declined. No money has moved." });
    }
    if (intent !== "approve") return json<ActionData>({ error: "Unknown action." }, { status: 400 });

    // What the request is for comes from the API, never from the form: an
    // approval can only refund the booking or sale the request was filed for.
    const pending = await api.get<RefundRequest[]>(`/api/shops/${shopId}/refund-requests?status=pending`);
    const target = (pending ?? []).find((r) => r.id === requestId);
    if (!target) {
      return json<ActionData>(
        { error: "This request has already been decided. Reload to see it." },
        { status: 409 }
      );
    }
    if (target.kind === "sale" && target.sale_id) {
      const result = await api.post<{ customer_refund_pence: number; status: string }>(
        `/api/shops/${shopId}/sales/${target.sale_id}/refund`,
        { refund_request_id: requestId }
      );
      return json<ActionData>({
        ok: true,
        message:
          result.status === "completed"
            ? `Approved. ${formatPence(result.customer_refund_pence)} is recorded as refunded.`
            : `Approved. ${formatPence(result.customer_refund_pence)} was sent to Stripe and completes when Stripe confirms.`,
      });
    }
    if (target.kind === "deposit" && target.booking_id) {
      await api.put(`/api/shops/${shopId}/bookings/${target.booking_id}/status`, {
        status: "cancelled",
        refund_deposit: true,
        refund_request_id: requestId,
      });
      return json<ActionData>({
        ok: true,
        message: `Approved. The ${formatPence(target.amount_pence)} deposit is on its way back to the customer's card.`,
      });
    }
    return json<ActionData>({ error: "This request names nothing to refund." }, { status: 400 });
  } catch (e) {
    return json<ActionData>({ error: e instanceof Error ? e.message : "That did not go through." }, { status: 400 });
  }
}

/** "Deposit for Sam Carter, 12 Nov 2026" or "Till sale to Sam Carter, 12 Nov 2026, 14:05". */
function subjectOf(r: RefundRequest): string {
  const who = r.customer_name ? ` ${r.kind === "deposit" ? "for" : "to"} ${r.customer_name}` : "";
  if (r.kind === "deposit") {
    const day = r.booking_date ? `, booked for ${formatDay(r.booking_date, { day: "numeric", month: "short", year: "numeric" })}` : "";
    return `Booking deposit${who}${day}`;
  }
  const when = r.sale_created_at ? `, ${formatDateTime(r.sale_created_at)}` : "";
  return `Till sale${who}${when}`;
}

/** Where approved money goes, in the words the confirmation uses. */
function destinationOf(r: RefundRequest): string {
  if (r.kind === "deposit" || r.sale_tender_type === "stripe") return "to the customer's card";
  if (r.sale_tender_type === "cash") return "in cash, by you at the till";
  if (r.sale_tender_type === "card_external") return "on your card machine";
  return r.sale_tender_type ? `by ${tenderLabel(r.sale_tender_type).toLowerCase()}` : "";
}

export default function AdminRefunds() {
  const { shopId, developerNeedsShop, userId, requests, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [approving, setApproving] = useState<RefundRequest | null>(null);
  const [declining, setDeclining] = useState<RefundRequest | null>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ActionData | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    setResult(data);
    if ("ok" in data) {
      setApproving(null);
      setDeclining(null);
      setNote("");
    }
  });

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");
  const dialogOpen = approving !== null || declining !== null;

  const send = (intent: "approve" | "decline", r: RefundRequest) => {
    setResult(null);
    const form = new FormData();
    if (shopId) form.append("shopId", shopId);
    form.append("intent", intent);
    form.append("requestId", r.id);
    if (intent === "decline") form.append("note", note);
    fetcher.submit(form, { method: "post" });
  };

  const evidenceHref = (r: RefundRequest) =>
    shopId ? `/api/shops/${shopId}/refund-requests/${r.id}/evidence` : "#";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Refunds</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Every refund is requested with a reason, then approved or declined here. Nothing is paid back until you approve it.
        </p>
      </div>

      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to review refunds as a developer.
        </div>
      )}

      {result && "ok" in result && (
        <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {result.message}
        </p>
      )}
      {result && "error" in result && !dialogOpen && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {result.error}
        </p>
      )}

      {loadError ? (
        <LoadError what="the refund requests" />
      ) : (
        <>
          <section aria-labelledby="refunds-waiting" className="space-y-3">
            <h2 id="refunds-waiting" className="font-heading text-lg font-semibold text-white">
              Waiting for your decision
              {pending.length > 0 && <span className="ml-2 text-sm font-normal text-white/60">{pending.length}</span>}
            </h2>
            {pending.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
                <ShieldCheck aria-hidden className="mx-auto mb-3 h-8 w-8 text-white/40" />
                <p className="text-sm text-white/70">No refund is waiting for a decision.</p>
                <p className="mt-1 text-sm text-white/60">
                  A refund is requested from{" "}
                  <Link to={withShopId("/admin/sales", shopId)} className="text-gold underline underline-offset-2">
                    Sales
                  </Link>{" "}
                  or from a cancelled booking in{" "}
                  <Link to={withShopId("/admin/bookings", shopId)} className="text-gold underline underline-offset-2">
                    Bookings
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {pending.map((r) => {
                  const own = r.requested_by === userId;
                  const blocked = selfApprovalBlocked(r, userId);
                  return (
                  <li key={r.id} className="rounded-xl border border-white/10 bg-dark-100 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <p className="min-w-0 text-sm font-medium text-white">{subjectOf(r)}</p>
                      <p className="text-base font-semibold text-white">{formatPence(r.amount_pence)}</p>
                    </div>
                    <p className="mt-1 text-xs text-white/60">
                      Requested by {r.requested_by_name ?? "someone at the shop"} on {formatDateTime(r.requested_at)}
                    </p>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm text-white/80">{r.reason}</p>
                    {r.has_evidence ? (
                      <a
                        href={evidenceHref(r)}
                        target="_blank"
                        rel="noreferrer"
                        className="tap-target mt-2 inline-flex items-center gap-2 text-sm text-gold underline underline-offset-2"
                      >
                        <FileText aria-hidden className="h-4 w-4" />
                        View evidence{r.evidence_name ? `: ${r.evidence_name}` : ""}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <p className="mt-2 text-xs text-amber-200">No evidence file was attached.</p>
                    )}
                    {blocked ? (
                      <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                        You filed this request without evidence, so you cannot approve it yourself. Decline it and file
                        it again with evidence, or have another owner approve it.
                      </p>
                    ) : (
                      own && (
                        <p className="mt-3 text-xs text-white/60">
                          You filed this request. If you approve it, the audit trail records it as self-approved.
                        </p>
                      )
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {!blocked && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            setResult(null);
                            setApproving(r);
                          }}
                          disabled={busy}
                        >
                          Approve refund
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setResult(null);
                          setNote("");
                          setDeclining(r);
                        }}
                        disabled={busy}
                      >
                        Decline
                      </Button>
                    </div>
                  </li>
                  );
                })}
              </ul>
            )}
          </section>

          {decided.length > 0 && (
            <section aria-labelledby="refunds-decided" className="space-y-3">
              <h2 id="refunds-decided" className="font-heading text-lg font-semibold text-white">
                Decided
              </h2>
              <ul className="divide-y divide-white/10 rounded-xl border border-white/10 bg-dark-100">
                {decided.map((r) => (
                  <li key={r.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                      <p className="min-w-0 text-sm font-medium text-white">{subjectOf(r)}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-white">{formatPence(r.refunded_pence ?? r.amount_pence)}</span>
                        <StatusBadge status={r.status} />
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-white/60">
                      {r.status === "approved" ? "Approved" : "Declined"} by {r.reviewed_by_name ?? "the owner"}
                      {r.reviewed_at ? ` on ${formatDateTime(r.reviewed_at)}` : ""}. Requested by{" "}
                      {r.requested_by_name ?? "someone at the shop"}.
                    </p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/70">{r.reason}</p>
                    {r.review_note && <p className="mt-1 text-sm text-white/60">Decision note: {r.review_note}</p>}
                    {r.has_evidence && (
                      <a
                        href={evidenceHref(r)}
                        target="_blank"
                        rel="noreferrer"
                        className="tap-target mt-1 inline-flex items-center gap-2 text-xs text-gold underline underline-offset-2"
                      >
                        <FileText aria-hidden className="h-3.5 w-3.5" />
                        View evidence
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={approving !== null}
        onCancel={() => setApproving(null)}
        onConfirm={() => approving && send("approve", approving)}
        title={approving ? `Refund ${formatPence(approving.amount_pence)} ${destinationOf(approving)}?` : "Approve this refund?"}
        confirmLabel={approving ? `Approve and refund ${formatPence(approving.amount_pence)}` : "Approve"}
        cancelLabel="Go back"
        destructive
        pending={busy}
        pendingLabel="Refunding…"
        error={result && "error" in result ? result.error : null}
      >
        {approving && (
          <>
            <p>{subjectOf(approving)}.</p>
            <p>
              {approving.kind === "deposit"
                ? "The deposit goes back in full, our commission on it included. If the booking is still open, approving also cancels it."
                : approving.sale_tender_type === "stripe"
                  ? "The money goes back to the card the customer paid with and completes when Stripe confirms."
                  : "This records that you handed the money back. No money moves by itself."}
            </p>
            {!approving.has_evidence && <p>No evidence file was attached. You are approving on the written reason alone.</p>}
            <p>This cannot be undone.</p>
          </>
        )}
      </ConfirmDialog>

      <Dialog
        open={declining !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeclining(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this refund request?</DialogTitle>
            <DialogDescription>
              {declining ? `${subjectOf(declining)}, ${formatPence(declining.amount_pence)}. ` : ""}
              No money moves. A declined request cannot be approved later; a new one would have to be filed.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (declining) send("decline", declining);
            }}
          >
            <Textarea
              label="Note for the record (optional)"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why it was declined"
            />
            {result && "error" in result && (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {result.error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDeclining(null)} disabled={busy}>
                Go back
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Declining…" : "Decline request"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
