import { useState } from "react";
import { useFetcher } from "react-router";
import { Check, Play } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { useShopHref } from "~/lib/useShopHref";
import { staffBookingActions, type StaffBookingAction } from "./today";

interface ActionBooking {
  id: string;
  booking_date: string;
  status: string;
  customer_name: string;
  service_name: string;
}

/**
 * "Start" and "Complete" for a staff member's own booking. Both post to the
 * booking's own page (routes/staff.bookings_.$bookingId.tsx), which checks
 * the role and calls the API; the page that shows the buttons reloads when
 * it answers. Completing sends the customer a review request and counts
 * towards commission, so it asks first. Starting does not.
 *
 * `show="next"` renders the single most likely action (a list row);
 * `show="all"` renders every action the booking allows.
 */
export function BookingActions({
  booking,
  today,
  show = "all",
  size = "default",
  className,
}: {
  booking: ActionBooking;
  /** Today on the shop's calendar, "YYYY-MM-DD", from the loader. */
  today: string;
  show?: "next" | "all";
  size?: "default" | "sm";
  className?: string;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const shopHref = useShopHref();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      setConfirming(false);
      setError(null);
    } else {
      setError(data.error ?? "That did not save. Check your connection and try again.");
    }
  });

  const allowed = staffBookingActions(booking.status, booking.booking_date, today);
  const actions = show === "next" ? allowed.slice(0, 1) : allowed;
  if (actions.length === 0) return null;

  const busy = fetcher.state !== "idle";
  const sending = busy ? String(fetcher.formData?.get("status") ?? "") : "";
  const send = (status: StaffBookingAction) => {
    setError(null);
    void fetcher.submit(
      { intent: "status", status },
      { method: "post", action: shopHref(`/staff/bookings/${booking.id}`) },
    );
  };

  return (
    <>
      <div className={`flex shrink-0 flex-wrap items-center gap-2 ${className ?? ""}`}>
        {actions.includes("in_progress") && (
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={busy}
            onClick={() => send("in_progress")}
            aria-label={`Start ${booking.customer_name}'s ${booking.service_name}`}
          >
            <Play className="h-3.5 w-3.5" aria-hidden />
            {sending === "in_progress" ? "Starting…" : "Start"}
          </Button>
        )}
        {actions.includes("completed") && (
          <Button
            type="button"
            size={size}
            disabled={busy}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            aria-label={`Complete ${booking.customer_name}'s ${booking.service_name}`}
          >
            <Check className="h-3.5 w-3.5" aria-hidden />
            {sending === "completed" ? "Completing…" : "Complete"}
          </Button>
        )}
      </div>
      {error && !confirming && (
        <p role="alert" className="basis-full text-sm text-red-300">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() => send("completed")}
        title="Complete this booking?"
        confirmLabel="Complete booking"
        cancelLabel="Not yet"
        pending={busy}
        pendingLabel="Completing…"
        error={confirming ? error : null}
      >
        <p>
          This marks {booking.customer_name}&apos;s {booking.service_name} as completed. The customer is
          emailed a review request and the booking counts towards the shop&apos;s commission.
        </p>
        <p>You cannot undo this from your screens. Ask the shop owner if it was a mistake.</p>
      </ConfirmDialog>
    </>
  );
}
