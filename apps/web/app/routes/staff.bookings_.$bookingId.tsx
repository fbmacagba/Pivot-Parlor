// One booking, for the staff member it belongs to: the notes and the
// customer's contact details (which the lists leave out), and the Start and
// Complete actions. The file name's trailing underscore keeps this page out
// of staff.bookings.tsx's own screen: it is /staff/bookings/:bookingId under
// the staff layout.
import { Link, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { formatPence } from "@repo/utils";
import { ErrorScreen } from "~/components/ErrorScreen";
import { BookingActions } from "~/components/staff/BookingActions";
import { DepositRefundRequest } from "~/components/staff/DepositRefundRequest";
import { bookingClock } from "~/components/staff/BookingRow";
import { Button } from "~/components/ui/Button";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { apiErrorStatus, createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatDay, ukToday } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { DEVELOPER_STAFF_READ_ONLY, pageStaffId, staffMePath } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { evidenceFrom, fileRefundRequest, refundEvidenceProblem, refundReasonProblem } from "~/lib/refundRequests";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useShopHref } from "~/lib/useShopHref";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Booking");

interface BookingDetail {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  notes: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  service_name: string;
  duration_min: number;
  amount_pence: number;
  /** The deposit that could still be refunded, or null when there is none. */
  deposit_refundable_pence?: number | null;
  /** A refund request for the deposit already waits for the owner. */
  deposit_refund_requested?: boolean;
}

/** The id goes into an API path, so anything but a plain id is refused. */
const BOOKING_ID = /^[A-Za-z0-9_-]{1,100}$/;

const STAFF_STATUSES = ["in_progress", "completed"] as const;

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  const bookingId = params.bookingId ?? "";
  if (!BOOKING_ID.test(bookingId)) throw new Response(null, { status: 404, statusText: "Booking not found" });
  const api = createApiClient(env.API_URL, getSessionToken(request));
  // A developer views the staff member they chose (staff.tsx), read-only.
  const readOnly = user.role === "developer";
  const staffId = pageStaffId(request, user);

  let booking: BookingDetail | null = null;
  let loadError = false;
  try {
    booking = await api.get<BookingDetail>(staffMePath(`/api/staff/me/bookings/${bookingId}`, staffId));
  } catch (error) {
    // Not this person's booking, or no such booking: a real "not found".
    // Anything else is a failed load, which must not read as one.
    if (apiErrorStatus(error) === 404) throw new Response(null, { status: 404, statusText: "Booking not found" });
    loadError = true;
  }

  return json({ booking, loadError, readOnly, today: ukToday() });
}

/**
 * POST { intent: "status", status: "in_progress" | "completed" }. The Today
 * screen, the bookings list and this page all post here (BookingActions).
 * POST { intent: "refund_request", reason, evidence? } asks the owner to
 * refund this booking's deposit (DepositRefundRequest). The API refuses a
 * booking that is not the staff member's own.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  if (user.role === "developer") {
    return json({ ok: false, error: DEVELOPER_STAFF_READ_ONLY }, { status: 403 });
  }
  const bookingId = params.bookingId ?? "";
  if (!BOOKING_ID.test(bookingId)) {
    return json({ ok: false, error: "That booking could not be found." }, { status: 404 });
  }
  const form = await readFormData(request);
  if (!form) return json({ ok: false, error: UNREADABLE_FORM }, { status: 400 });

  if (form.get("intent") === "refund_request") {
    const token = getSessionToken(request);
    if (!token || !user.shop_id) return json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const reason = String(form.get("reason") ?? "").trim();
    const evidence = evidenceFrom(form);
    const problem = refundReasonProblem(reason) ?? refundEvidenceProblem(evidence);
    if (problem) return json({ ok: false, error: problem }, { status: 400 });
    try {
      await fileRefundRequest(
        env.API_URL,
        token,
        user.shop_id,
        { kind: "deposit", booking_id: bookingId, reason },
        evidence,
      );
      return json({ ok: true, message: "Refund request filed. No money has moved: it waits for the owner." });
    } catch (e) {
      return json(
        { ok: false, error: e instanceof Error && e.message ? e.message : "The request could not be filed." },
        { status: 400 },
      );
    }
  }

  const status = String(form.get("status") ?? "");
  if (form.get("intent") !== "status" || !(STAFF_STATUSES as readonly string[]).includes(status)) {
    return json({ ok: false, error: "A booking can only be started or completed from here." }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, getSessionToken(request));
  try {
    await api.put(`/api/staff/me/bookings/${bookingId}/status`, { status });
    return json({ ok: true, status });
  } catch (error) {
    const upstream = apiErrorStatus(error);
    const doing = status === "completed" ? "complete" : "start";
    return json(
      {
        ok: false,
        error:
          upstream === 404
            ? "That booking is no longer on your list. Refresh the page to see your current bookings."
            : upstream !== undefined && upstream < 500 && error instanceof Error && error.message
              ? error.message
              : `We couldn't ${doing} this booking. Check your connection and try again.`,
      },
      { status: upstream !== undefined && upstream >= 400 && upstream < 500 ? upstream : 502 },
    );
  }
}

export default function StaffBookingDetail() {
  const { booking, loadError, readOnly, today } = useLoaderData<typeof loader>();
  const shopHref = useShopHref();

  return (
    <div className="max-w-2xl space-y-5">
      <Link
        to={shopHref("/staff/bookings")}
        className="tap-target inline-flex items-center gap-1.5 text-sm text-gold hover:text-gold/80"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> My bookings
      </Link>

      {loadError || !booking ? (
        <>
          <h1 className="font-heading text-2xl font-bold text-white">Booking</h1>
          <LoadError what="this booking" />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words font-heading text-2xl font-bold text-white">
              {booking.customer_name}
            </h1>
            <StatusBadge status={booking.status} />
          </div>

          <section className="rounded-xl border border-white/10 bg-dark-100 p-5" aria-label="Appointment">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-white/60">When</dt>
                <dd className="mt-0.5 text-white">
                  {formatDay(booking.booking_date, { weekday: "long", day: "numeric", month: "long" })}
                  {", "}
                  {bookingClock(booking.start_time)} to {bookingClock(booking.end_time)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-white/60">Service</dt>
                <dd className="mt-0.5 text-white">
                  {booking.service_name} · {booking.duration_min} minutes · {formatPence(booking.amount_pence)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-white/60">Notes from the customer</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-white">
                  {booking.notes?.trim() || <span className="text-white/60">None left.</span>}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-white/10 bg-dark-100 p-5">
            <h2 className="font-heading text-base font-semibold text-white">Contact {booking.customer_name}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {booking.customer_phone?.trim() ? (
                <Button asChild variant="secondary">
                  <a href={`tel:${booking.customer_phone.replace(/[^\d+]/g, "")}`}>
                    <Phone className="h-4 w-4" aria-hidden /> Call {booking.customer_phone}
                  </a>
                </Button>
              ) : (
                <p className="text-sm text-white/60">No phone number was given with this booking.</p>
              )}
              {booking.customer_email?.trim() && (
                <Button asChild variant="secondary" className="max-w-full">
                  <a href={`mailto:${booking.customer_email}`}>
                    <Mail className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">Email {booking.customer_email}</span>
                  </a>
                </Button>
              )}
            </div>
          </section>

          {typeof booking.deposit_refundable_pence === "number" && (
            <DepositRefundRequest
              depositPence={booking.deposit_refundable_pence}
              requested={booking.deposit_refund_requested === true}
              readOnly={readOnly}
            />
          )}

          {readOnly ? (
            <p className="rounded-xl border border-white/10 bg-dark-100 p-5 text-sm text-white/60">
              Bookings are started and completed by the staff member from their own screens.
            </p>
          ) : (
            <BookingActions booking={booking} today={today} show="all" />
          )}
        </>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/staff" homeLabel="Back to today" />;
}
