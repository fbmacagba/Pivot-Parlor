import { useEffect, useState, useMemo } from "react";
import { Link, useLoaderData, useFetcher, useNavigation, useSearchParams, data as json } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { BookingsCalendar } from "~/components/admin/BookingsCalendar";
import { BookingStatusSelect } from "~/components/admin/BookingStatusSelect";
import {
  BOOKINGS_LIMIT,
  bookingsQuery,
  bookingsWindow,
  matchesBookingSearch,
} from "~/components/admin/bookingsWindow";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { StatusBadge, statusLabel } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";
import { useModalA11y } from "~/lib/useModalA11y";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { clockOf, formatCount, formatDate as formatUkDate, formatDay, ukToday } from "~/lib/dateFormat";
import { pageShopId, withShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { RefundRequestFields } from "~/components/admin/RefundRequestFields";
import {
  evidenceFrom,
  fileRefundRequest,
  refundEvidenceProblem,
  refundReasonProblem,
  type RefundRequest,
} from "~/lib/refundRequests";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Bookings");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

export type BookingStatus = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  service_name: string;
  staff_name: string;
  status: BookingStatus;
  duration_min: number;
  amount_pence: number;
  commission_pence: number;
  notes: string | null;
  created_at: string;
  // Deposit state (customer-facing deposits, migration 041); null for
  // bookings with no deposit.
  deposit_amount_pence: number | null;
  deposit_paid_at: string | null;
  deposit_tx_status: string | null;
}

/** Every status a booking can be filtered by. */
const FILTER_STATUSES: BookingStatus[] = ["pending", "confirmed", "completed", "cancelled", "no_show"];
/** The statuses the API lets an owner move a booking to (pending is only ever where one starts). */
const TARGET_STATUSES: BookingStatus[] = ["confirmed", "completed", "cancelled", "no_show"];

/** A captured customer deposit that has not been refunded or credited to a
 *  sale: cancelling this booking keeps it, and it goes back only through a
 *  refund request the owner approves. */
function hasCapturedDeposit(b: Booking): boolean {
  return (
    Boolean(b.deposit_paid_at) &&
    b.deposit_tx_status === "captured" &&
    (b.deposit_amount_pence ?? 0) > 0
  );
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "";
  const today = ukToday();
  // Always a dated window: the person's From and To, or 30 days back to 90
  // days ahead (components/admin/bookingsWindow.ts).
  const range = bookingsWindow(url.searchParams.get("from"), url.searchParams.get("to"), today);

  let bookings: Booking[] = [];
  let loadError = false;
  // Bookings whose deposit already has a refund request waiting.
  let pendingRefundBookingIds: string[] = [];
  if (shopId) {
    const [bookingsRes, pendingRes] = await Promise.allSettled([
      api.get<Booking[]>(`/api/shops/${shopId}/bookings${bookingsQuery(range, statusFilter)}`),
      api.get<RefundRequest[]>(`/api/shops/${shopId}/refund-requests?status=pending`),
    ]);
    if (bookingsRes.status === "fulfilled") bookings = bookingsRes.value ?? [];
    else loadError = true;
    if (pendingRes.status === "fulfilled") {
      pendingRefundBookingIds = (pendingRes.value ?? []).flatMap((r) => (r.booking_id ? [r.booking_id] : []));
    }
  }

  const todayCount = bookings.filter((b) => b.booking_date === today).length;
  const pendingCount = bookings.filter((b) => b.status === "pending").length;
  const completedRevenuePence = bookings
    .filter((b) => b.status === "completed")
    .reduce((sum, b) => sum + b.amount_pence, 0);

  return json({
    bookings,
    shopId,
    loadError,
    pendingRefundBookingIds,
    window: range,
    today,
    // The API stops at the limit, oldest first: the latest days asked for are missing.
    truncated: bookings.length >= BOOKINGS_LIMIT,
    stats: { total: bookings.length, todayCount, pendingCount, completedRevenuePence },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: UNREADABLE_FORM }, { status: 400 });
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "") || null);
  if (!shopId) return json({ ok: false, error: "Choose a shop first." }, { status: 400 });
  const bookingId = form.get("bookingId") as string;

  // A deposit refund is requested here, never issued: the reason and any
  // evidence go on the Refunds page, where the owner approves or declines.
  if (form.get("intent") === "request_refund") {
    if (!token) return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const reason = String(form.get("reason") ?? "").trim();
    const reasonProblem = refundReasonProblem(reason);
    if (reasonProblem) return json({ ok: false, error: reasonProblem }, { status: 400 });
    const evidence = evidenceFrom(form);
    const evidenceProblem = refundEvidenceProblem(evidence);
    if (evidenceProblem) return json({ ok: false, error: evidenceProblem }, { status: 400 });
    try {
      // Filed first: if it is refused, the booking is left exactly as it was.
      await fileRefundRequest(env.API_URL, token, shopId, { kind: "deposit", booking_id: bookingId, reason }, evidence);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "The request could not be filed";
      return json({ ok: false, error: message }, { status: 400 });
    }
    if (form.get("cancel") === "1") {
      try {
        await api.put(`/api/shops/${shopId}/bookings/${bookingId}/status`, { status: "cancelled", refund_deposit: false });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Something went wrong";
        return json(
          { ok: false, error: `The refund request was filed, but the booking was not cancelled: ${message}` },
          { status: 502 },
        );
      }
    }
    return json({ ok: true });
  }

  // The shop itself is cancelling. Its terms promise the customer that money
  // back, so this files the request as a shop cancellation and approves it in
  // the same step. Both are recorded, marked as a shop cancellation.
  if (form.get("intent") === "shop_cancel") {
    if (!token) return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    let requestId: string;
    try {
      // Filed first: if it is refused, the booking is left exactly as it was.
      const filed = await fileRefundRequest(
        env.API_URL,
        token,
        shopId,
        { kind: "deposit", booking_id: bookingId, shop_cancelled: true },
        null,
      );
      requestId = filed.id;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "The cancellation could not be started";
      return json({ ok: false, error: message }, { status: 400 });
    }
    try {
      await api.put(`/api/shops/${shopId}/bookings/${bookingId}/status`, {
        status: "cancelled",
        refund_deposit: true,
        refund_request_id: requestId,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Something went wrong";
      return json(
        {
          ok: false,
          error: `The refund did not go through: ${message} The request is waiting on the Refunds page, where you can approve it again.`,
        },
        { status: 502 },
      );
    }
    return json({ ok: true });
  }

  const newStatus = form.get("status") as BookingStatus;
  try {
    await api.put(`/api/shops/${shopId}/bookings/${bookingId}/status`, {
      status: newStatus,
      // Sent only by the deposit dialog's "keep" choice. This form can never
      // ask for a refund: that takes a request and the owner's approval.
      ...(form.get("refund_deposit") === "0" ? { refund_deposit: false } : {}),
    });
    return json({ ok: true });
  } catch (e: unknown) {
    // Surfaces worker errors (e.g. "Deposit refund failed. The booking was
    // not cancelled.") instead of crashing to the error boundary.
    const message = e instanceof Error ? e.message : "Something went wrong";
    return json({ ok: false, error: message }, { status: 502 });
  }
}

/** "9:05am": a walk-in's own clock time, or an instant on the London clock
 *  (app/lib/dateFormat.ts). Anything else is shown as it is. */
function formatTime(start: string) {
  const clock = clockOf(start);
  if (!clock) return start;
  const { hour: h, minute: m } = clock;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

/** A booking's calendar day, "12 Nov 2026". */
function formatDate(d: string) {
  return formatDay(d, { day: "numeric", month: "short", year: "numeric" });
}

/** The status changes that are asked about first: each does something that
 *  is not undone by picking another status. Confirming a booking, or
 *  reinstating one, saves at once. */
type ConfirmedStep = "completed" | "cancelled" | "no_show";

function isConfirmedStep(status: string): status is ConfirmedStep {
  return status === "completed" || status === "cancelled" || status === "no_show";
}

const STEP_COPY: Record<ConfirmedStep, { title: string; confirmLabel: string; pendingLabel: string; destructive: boolean }> = {
  completed: { title: "Mark this booking as completed?", confirmLabel: "Mark as completed", pendingLabel: "Saving…", destructive: false },
  cancelled: { title: "Cancel this booking?", confirmLabel: "Cancel booking", pendingLabel: "Cancelling…", destructive: true },
  no_show: { title: "Mark this booking as a no show?", confirmLabel: "Mark as no show", pendingLabel: "Saving…", destructive: true },
};

function StatusSelect({
  booking,
  onRequestCancelWithDeposit,
}: {
  booking: Booking;
  onRequestCancelWithDeposit: () => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [step, setStep] = useState<ConfirmedStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.ok) setStep(null);
    else setError(data.error ?? "The status could not be changed. Try again.");
  });

  const options = (TARGET_STATUSES.includes(booking.status) ? TARGET_STATUSES : [booking.status, ...TARGET_STATUSES]).map(
    (s) => ({ value: s, label: statusLabel(s) }),
  );

  return (
    <>
      <BookingStatusSelect
        bookingId={booking.id}
        status={booking.status}
        label={`Change status for ${booking.customer_name}`}
        options={options}
        onBeforeChange={(next) => {
          // A captured deposit makes cancellation a money decision: hand off
          // to the keep-or-request-a-refund dialog instead of submitting.
          if (next === "cancelled" && hasCapturedDeposit(booking)) {
            onRequestCancelWithDeposit();
            return true;
          }
          if (isConfirmedStep(next)) {
            setError(null);
            setStep(next);
            return true;
          }
          return false;
        }}
      />
      <ConfirmDialog
        open={step !== null}
        onCancel={() => setStep(null)}
        onConfirm={() => {
          if (!step) return;
          setError(null);
          fetcher.submit({ bookingId: booking.id, status: step }, { method: "post" });
        }}
        title={step ? STEP_COPY[step].title : ""}
        confirmLabel={step ? STEP_COPY[step].confirmLabel : ""}
        cancelLabel="Go back"
        destructive={step ? STEP_COPY[step].destructive : false}
        pending={fetcher.state !== "idle"}
        pendingLabel={step ? STEP_COPY[step].pendingLabel : undefined}
        error={error}
      >
        {step === "completed" && (
          <>
            <p>
              {booking.customer_name} is emailed a request to leave a review, unless you have switched review
              requests off in Settings. {formatPence(booking.amount_pence)} then counts as completed revenue, with
              commission of {formatPence(booking.commission_pence)}.
            </p>
            <p>You can change the status again afterwards, but an email that has been sent cannot be taken back.</p>
          </>
        )}
        {step === "cancelled" && (
          <>
            <p>
              {booking.customer_name}&apos;s time on {formatDate(booking.booking_date)} at{" "}
              {formatTime(booking.start_time)} is given up, and people on your waitlist for that day may be told a
              slot has opened.
            </p>
            <p>You can reinstate the booking later only if nobody else has taken the time.</p>
          </>
        )}
        {step === "no_show" && (
          <>
            <p>
              This records that {booking.customer_name} did not turn up on {formatDate(booking.booking_date)} at{" "}
              {formatTime(booking.start_time)}.
            </p>
            <p>You can reinstate the booking later only if nobody else has taken the time.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

function CancelDepositDialog({
  booking,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  // The second step: say why the deposit should go back, and attach evidence.
  const [asking, setAsking] = useState(false);
  // The other second step: the shop itself is cancelling, so the deposit goes back.
  const [shopCancelling, setShopCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  // A request in flight must not be dismissible (backdrop/Escape) or the
  // outcome is lost on the admin.
  const guardedClose = () => {
    if (!busy) onClose();
  };
  const dialogRef = useModalA11y<HTMLDivElement>({ active: true, onClose: guardedClose, lockScroll: false });
  const reasonProblem = refundReasonProblem(reason);
  const fileProblem = refundEvidenceProblem(file);
  const deposit = formatPence(booking.deposit_amount_pence ?? 0);

  function keepDeposit() {
    const fd = new FormData();
    fd.set("bookingId", booking.id);
    fd.set("status", "cancelled");
    fd.set("refund_deposit", "0");
    fetcher.submit(fd, { method: "post" });
  }

  function shopCancel() {
    const fd = new FormData();
    fd.set("intent", "shop_cancel");
    fd.set("bookingId", booking.id);
    fetcher.submit(fd, { method: "post" });
  }

  function requestRefund() {
    setTried(true);
    if (reasonProblem || fileProblem) return;
    const fd = new FormData();
    fd.set("intent", "request_refund");
    fd.set("bookingId", booking.id);
    fd.set("cancel", "1");
    fd.set("reason", reason.trim());
    if (file) fd.set("evidence", file, file.name);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  // Close once the cancellation lands; stay open to show an error.
  const done = fetcher.state === "idle" && Boolean(fetcher.data?.ok);
  useEffect(() => {
    if (done) onClose();
  }, [done, onClose]);
  if (done) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-[60]" onClick={guardedClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-deposit-title"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[calc(100%-2rem)] max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-dark-100 p-6 shadow-2xl"
      >
        <h3 id="cancel-deposit-title" className="font-heading text-lg font-semibold text-white">
          {shopCancelling
            ? "Cancel as the shop and refund?"
            : asking
              ? "Cancel and ask for a refund?"
              : "Cancel this booking?"}
        </h3>
        <p className="mt-2 text-sm text-white/60">
          {shopCancelling
            ? `Use this only when the shop is the one cancelling. The booking is cancelled and the ${deposit} deposit goes back to the customer's card now, as your terms promise. It is recorded as a shop cancellation.`
            : asking
            ? `The booking is cancelled now and the ${deposit} deposit stays held. It goes back to the customer only when the owner approves your request on the Refunds page.`
            : `The customer paid a ${deposit} deposit. Cancelling keeps it: standard commission applies to the amount kept. To give it back, file a refund request with the reason. If the shop is the one cancelling, the deposit is refunded.`}
        </p>
        {fetcher.data && !fetcher.data.ok && fetcher.data.error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
            {fetcher.data.error}
          </p>
        )}
        {shopCancelling ? (
          <div className="mt-5 flex flex-col gap-2">
            <Button type="button" onClick={shopCancel} disabled={busy} className="w-full">
              {busy ? "Working…" : `Cancel booking and refund ${deposit}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShopCancelling(false)}
              disabled={busy}
              className="w-full text-white/70"
            >
              Go back
            </Button>
          </div>
        ) : asking ? (
          <form
            className="mt-4 space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              requestRefund();
            }}
          >
            <RefundRequestFields
              reason={reason}
              onReasonChange={setReason}
              reasonError={tried ? reasonProblem : null}
              file={file}
              onFileChange={setFile}
              disabled={busy}
              canApprove
            />
            <div className="flex flex-col gap-2">
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Working…" : "Cancel booking and file request"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAsking(false)} disabled={busy} className="w-full text-white/70">
                Go back
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            <Button type="button" onClick={keepDeposit} disabled={busy} className="w-full">
              {busy ? "Working…" : "Cancel and keep deposit"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setAsking(true)} disabled={busy} className="w-full">
              Cancel and ask for a refund
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShopCancelling(true)}
              disabled={busy}
              className="w-full"
            >
              The shop is cancelling
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="w-full text-white/70">
              Go back
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5 flex items-center gap-4">
      <div aria-hidden className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center text-gold">{icon}</div>
      <div>
        <p className="text-xs text-white/60 font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
      </div>
    </div>
  );
}

const SECTION_HEADING = "text-xs font-semibold text-white/60 uppercase tracking-wide";

function BookingDrawer({
  booking,
  onClose,
  pendingRefund,
}: {
  booking: Booking;
  onClose: () => void;
  /** A refund request for this booking's deposit is waiting for a decision. */
  pendingRefund: boolean;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Focus trap, focus-in, Escape-to-close, scroll-lock and focus-restore.
  // Kept in-place (not a Radix portal) so the fetcher-driven StatusSelect
  // inside keeps submitting normally. While the nested cancel dialog is open,
  // Escape bubbles from its trap to this one: guard so one press closes only
  // the dialog, not the whole drawer.
  const dialogRef = useModalA11y<HTMLDivElement>({
    active: true,
    onClose: () => {
      if (!confirmCancel) onClose();
    },
  });
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-drawer-title"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 w-full max-w-md bg-dark border-l border-white/10 z-50 flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
          <div>
            <h2 id="booking-drawer-title" className="font-heading font-semibold text-white">Booking detail</h2>
            <p className="text-xs text-white/60 mt-0.5">#{booking.id.slice(0, 8).toUpperCase()}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close booking detail" className="text-white/70">
            <svg aria-hidden className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <StatusBadge status={booking.status} />
            <StatusSelect booking={booking} onRequestCancelWithDeposit={() => setConfirmCancel(true)} />
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 grid grid-cols-2 gap-4">
            <div><p className="text-xs text-white/60 mb-1">Date</p><p className="text-sm font-semibold text-white">{formatDate(booking.booking_date)}</p></div>
            <div><p className="text-xs text-white/60 mb-1">Time</p><p className="text-sm font-semibold text-white">{formatTime(booking.start_time)} · {booking.duration_min} min</p></div>
          </div>
          <div>
            <p className={`${SECTION_HEADING} mb-3`}>Customer</p>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div aria-hidden className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center text-sm font-semibold text-gold">{booking.customer_name.charAt(0)}</div>
                <span className="text-sm font-medium text-white">{booking.customer_name}</span>
              </div>
              <a href={`mailto:${booking.customer_email}`} className="tap-target flex items-center gap-2 text-sm text-white/70 hover:text-gold transition-colors">
                <svg aria-hidden className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                <span className="break-all">{booking.customer_email}</span>
              </a>
              {booking.customer_phone && (
                <a href={`tel:${booking.customer_phone}`} className="tap-target flex items-center gap-2 text-sm text-white/70 hover:text-gold transition-colors">
                  <svg aria-hidden className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                  {booking.customer_phone}
                </a>
              )}
            </div>
          </div>
          <div>
            <p className={`${SECTION_HEADING} mb-3`}>Service</p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
              {[["Service", booking.service_name], ["Staff", booking.staff_name], ["Duration", `${booking.duration_min} min`]].map(([l, v]) => (
                <div key={l} className="flex justify-between gap-3">
                  <span className="text-sm text-white/60">{l}</span>
                  <span className="text-sm font-medium text-white text-right">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className={`${SECTION_HEADING} mb-3`}>Payment</p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
              <div className="flex justify-between"><span className="text-sm text-white/60">Total</span><span className="text-sm font-semibold text-gold">{formatPence(booking.amount_pence)}</span></div>
              <div className="flex justify-between"><span className="text-sm text-white/60">Commission</span><span className="text-sm text-white/70">{formatPence(booking.commission_pence)}</span></div>
              {booking.deposit_paid_at &&
                (booking.deposit_tx_status === "refunded" ? (
                  <div className="flex justify-between">
                    <span className="text-sm text-white/60">Deposit</span>
                    <span className="text-sm text-white/80">Refunded</span>
                  </div>
                ) : (booking.deposit_amount_pence ?? 0) > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-sm text-white/60">Deposit paid</span>
                    <span className="text-sm text-white/80">{formatPence(booking.deposit_amount_pence ?? 0)}</span>
                  </div>
                ) : null)}
              <div className="border-t border-white/10 pt-2 flex justify-between"><span className="text-sm text-white/60">Net to shop</span><span className="text-sm font-semibold text-white">{formatPence(booking.amount_pence - booking.commission_pence)}</span></div>
              {booking.status === "cancelled" && hasCapturedDeposit(booking) && (
                <RequestDepositRefund
                  bookingId={booking.id}
                  amountPence={booking.deposit_amount_pence ?? 0}
                  pending={pendingRefund}
                />
              )}
            </div>
          </div>
          {booking.notes && (
            <div>
              <p className={`${SECTION_HEADING} mb-2`}>Notes</p>
              <p className="text-sm text-white/70 rounded-xl border border-white/10 bg-white/5 p-4">{booking.notes}</p>
            </div>
          )}
          <p className="text-xs text-white/60">Created {formatUkDate(booking.created_at, { day: "numeric", month: "short", year: "numeric" })}</p>
        </div>
      </div>
      {confirmCancel && (
        <CancelDepositDialog booking={booking} onClose={() => setConfirmCancel(false)} />
      )}
    </>
  );
}

/** A cancelled booking still holding its captured deposit (the customer
 *  cancelled online, or the shop cancelled and kept it): the deposit goes
 *  back only through a refund request the owner approves. */
function RequestDepositRefund({
  bookingId,
  amountPence,
  pending,
}: {
  bookingId: string;
  amountPence: number;
  pending: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const { shopId } = useLoaderData<typeof loader>();
  const busy = fetcher.state !== "idle";
  const done = fetcher.state === "idle" && Boolean(fetcher.data?.ok);
  const reasonProblem = refundReasonProblem(reason);
  const fileProblem = refundEvidenceProblem(file);

  if (done || pending) {
    return (
      <p role={done ? "status" : undefined} className="pt-2 text-xs text-white/70">
        {done ? "Refund request filed. " : "A refund request for this deposit is waiting for a decision. "}
        <Link to={withShopId("/admin/refunds", shopId)} className="text-gold underline underline-offset-2">
          Open Refunds
        </Link>
      </p>
    );
  }
  if (!open) {
    return (
      <div className="pt-2">
        <Button type="button" variant="outline" onClick={() => setOpen(true)} className="w-full">
          Request refund of {formatPence(amountPence)} deposit
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-3 pt-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (reasonProblem || fileProblem) return;
        const fd = new FormData();
        fd.set("intent", "request_refund");
        fd.set("bookingId", bookingId);
        fd.set("reason", reason.trim());
        if (file) fd.set("evidence", file, file.name);
        fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
      }}
    >
      <RefundRequestFields
        reason={reason}
        onReasonChange={setReason}
        reasonError={tried ? reasonProblem : null}
        file={file}
        onFileChange={setFile}
        disabled={busy}
        canApprove
      />
      <p className="text-xs text-white/60">
        The {formatPence(amountPence)} deposit stays held until the owner approves this on the Refunds page.
      </p>
      {fetcher.data && !fetcher.data.ok && fetcher.data.error && (
        <p role="alert" className="text-xs text-red-400">{fetcher.data.error}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Filing…" : "File refund request"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy} className="text-white/70">
          Not now
        </Button>
      </div>
    </form>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
      <svg aria-hidden className="w-10 h-10 mx-auto mb-3 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      <div className="space-y-3 text-sm text-white/70">{children}</div>
    </div>
  );
}

function BookingsList({ bookings, onSelect }: { bookings: Booking[]; onSelect: (b: Booking) => void }) {
  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) { const arr = map.get(b.booking_date) ?? []; map.set(b.booking_date, [...arr, b]); }
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [bookings]);

  return (
    <div className="space-y-6">
      {grouped.map(([date, dayBookings]) => (
        <div key={date}>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-xs font-semibold text-white/60 uppercase tracking-wide">{formatDate(date)}</h2>
            <div aria-hidden className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-white/60">
              {dayBookings.length}
              <span className="sr-only"> booking{dayBookings.length !== 1 ? "s" : ""}</span>
            </span>
          </div>
          <div className="rounded-xl border border-white/10 bg-dark-100 overflow-hidden divide-y divide-white/5">
            {dayBookings.slice().sort((a, b) => a.start_time.localeCompare(b.start_time)).map((booking) => (
              <button key={booking.id} type="button" onClick={() => onSelect(booking)}
                className="w-full flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-white/[0.03] transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold">
                <div className="w-14 shrink-0"><span className="text-sm font-semibold text-white">{formatTime(booking.start_time)}</span></div>
                <div aria-hidden className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center text-sm font-semibold text-gold shrink-0">{booking.customer_name.charAt(0)}</div>
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm font-medium text-white truncate">{booking.customer_name}</p>
                  <p className="text-xs text-white/60 truncate">{booking.service_name} · {booking.staff_name}</p>
                </div>
                {/* Duration, status, amount: right-aligned, on their own line when a phone needs the room */}
                <div className="ml-auto flex shrink-0 items-center gap-4">
                  <span className="text-xs text-white/60 hidden sm:block">{booking.duration_min} min</span>
                  <StatusBadge status={booking.status} />
                  <div className="w-16 text-right"><span className="text-sm font-semibold text-gold">{formatPence(booking.amount_pence)}</span></div>
                  <svg aria-hidden className="w-4 h-4 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminBookings() {
  const { bookings, stats, loadError, window: loaded, today, truncated, pendingRefundBookingIds } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const [view, setView] = useState<"list" | "calendar">("list");
  // The id, not the row: the drawer always shows the booking as last loaded,
  // so a status change inside it is reflected at once.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const statusFilter = searchParams.get("status") ?? "";
  const datesChosen = !loaded.isDefault;
  const loading = navigation.state === "loading";

  const selectedBooking = selectedId ? bookings.find((b) => b.id === selectedId) ?? null : null;
  // A booking that left the loaded list (its new status no longer matches the
  // filter) cannot be shown: close the drawer and say why.
  useEffect(() => {
    if (selectedId && !selectedBooking && !loading) {
      setSelectedId(null);
      setNotice("That booking is no longer in the list shown. Change the status filter or the dates to find it.");
    }
  }, [selectedId, selectedBooking, loading]);

  function openBooking(b: Booking) {
    setNotice(null);
    setSelectedId(b.id);
  }

  const shown = useMemo(() => bookings.filter((b) => matchesBookingSearch(b, search)), [bookings, search]);
  const searching = search.trim() !== "";

  function setParams(changes: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true, preventScrollReset: true });
  }

  /** Drops the filters but keeps the rest of the query (a developer's ?shopId=). */
  function clearFilters() {
    setSearch("");
    setParams({ status: "", from: "", to: "" });
  }

  const period = `${formatDate(loaded.from)} to ${formatDate(loaded.to)}`;
  const todayInPeriod = today >= loaded.from && today <= loaded.to;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Bookings</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {period}
            {loaded.isDefault ? " (the last 30 days and the next 90)" : ""}
          </p>
        </div>
        <div className="flex items-center bg-white/5 border border-white/10 rounded-xl p-1 gap-0.5" role="group" aria-label="View">
          {(["list", "calendar"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
              className={`tap-target flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${view === v ? "bg-white/15 text-white font-semibold" : "text-white/60 font-medium hover:text-white"}`}>
              {v === "list"
                ? <svg aria-hidden className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                : <svg aria-hidden className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>}
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Filters apply to the list and the calendar alike, so they show in both. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Input
            label="Search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Customer, service or staff"
            autoComplete="off"
          />
        </div>
        <div className="w-40">
          <Select label="Status" value={statusFilter} onChange={(e) => setParams({ status: e.target.value })}>
            <option value="" className="bg-dark">All statuses</option>
            {FILTER_STATUSES.map((s) => (
              <option key={s} value={s} className="bg-dark">{statusLabel(s)}</option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Input label="From" type="date" value={loaded.from} max={loaded.to} onChange={(e) => setParams({ from: e.target.value, to: loaded.to })} />
        </div>
        <div className="w-40">
          <Input label="To" type="date" value={loaded.to} min={loaded.from} onChange={(e) => setParams({ from: loaded.from, to: e.target.value })} />
        </div>
        {(statusFilter || datesChosen || searching) && (
          <Button type="button" variant="ghost" onClick={clearFilters}>Clear filters</Button>
        )}
      </div>

      <div role="status" className={notice ? "rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80" : "sr-only"}>
        {notice}
      </div>

      {loadError ? (
        <LoadError what="your bookings" />
      ) : (
        <>
          {truncated && (
            <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              This list is cut short. Only the first {formatCount(BOOKINGS_LIMIT)} bookings from{" "}
              {formatDate(loaded.from)} are shown, so later days and the totals below are incomplete. Choose a shorter
              From and To range to see everything.
            </div>
          )}

          <section aria-labelledby="bookings-period-heading">
            <h2 id="bookings-period-heading" className="mb-3 text-sm font-medium text-white/70">
              {statusFilter ? `${statusLabel(statusFilter)} bookings, ` : "All bookings, "}
              {period}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard label="Bookings in this period" value={stats.total} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>} />
              <SummaryCard label="Today" value={todayInPeriod ? stats.todayCount : "Outside these dates"} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
              <SummaryCard label="Pending in this period" value={stats.pendingCount} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>} />
              <SummaryCard label="Completed revenue in this period" value={formatPence(stats.completedRevenuePence)} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
            </div>
          </section>

          {searching && (
            <p role="status" className="text-sm text-white/70">
              {shown.length} of {bookings.length} booking{bookings.length !== 1 ? "s" : ""} match &ldquo;{search.trim()}&rdquo;.
            </p>
          )}

          {view === "calendar" ? (
            <BookingsCalendar
              bookings={shown}
              onSelectBooking={openBooking}
              loadedFrom={loaded.from}
              loadedTo={loaded.to}
              loading={loading}
              onLoadMonth={(from, to) => setParams({ from, to })}
            />
          ) : bookings.length === 0 ? (
            <EmptyState>
              <p>
                No {statusFilter ? `${statusLabel(statusFilter).toLowerCase()} ` : ""}bookings between {formatDate(loaded.from)} and{" "}
                {formatDate(loaded.to)}.
              </p>
              {(statusFilter || datesChosen) && (
                <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
              )}
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState>
              <p>No bookings in this period match &ldquo;{search.trim()}&rdquo;.</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => setSearch("")}>Clear search</Button>
            </EmptyState>
          ) : (
            <BookingsList bookings={shown} onSelect={openBooking} />
          )}
        </>
      )}

      {selectedBooking && (
        <BookingDrawer
          key={selectedBooking.id}
          booking={selectedBooking}
          onClose={() => setSelectedId(null)}
          pendingRefund={pendingRefundBookingIds.includes(selectedBooking.id)}
        />
      )}
    </div>
  );
}
