import { useFetcher } from "react-router";
import { Select } from "~/components/ui/Select";

/**
 * A booking's status as a select that saves on change (the admin bookings
 * drawer). `onBeforeChange` may take over a change instead of saving it: a
 * cancellation with a captured deposit opens the refund-or-keep dialog, and
 * the steps that cannot be quietly taken back (completed, cancelled, no show)
 * go through a confirmation first. The select is controlled, so it snaps back
 * meanwhile.
 */
export function BookingStatusSelect({
  bookingId,
  status,
  options,
  onBeforeChange,
  label = "Change status",
  disabled = false,
}: {
  bookingId: string;
  status: string;
  options: Array<{ value: string; label: string }>;
  /** Return true when the change was handled elsewhere and must not be saved. */
  onBeforeChange?: (next: string) => boolean;
  /** The select's accessible name (it shows no visible label). */
  label?: string;
  disabled?: boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const optimistic = fetcher.formData?.get("status") as string | undefined;
  return (
    <fetcher.Form method="post" className="w-40">
      <input type="hidden" name="bookingId" value={bookingId} />
      <Select
        label={label}
        hideLabel
        name="status"
        value={optimistic ?? status}
        disabled={disabled}
        onChange={(e) => {
          if (onBeforeChange?.(e.currentTarget.value)) return;
          fetcher.submit(e.currentTarget.form);
        }}
        className="cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-dark">{o.label}</option>
        ))}
      </Select>
      {/* A refused change (e.g. reinstating a booking whose time is now
          taken) says why, instead of only snapping back. */}
      {fetcher.state === "idle" && fetcher.data && !fetcher.data.ok && fetcher.data.error && (
        <p role="alert" className="mt-1 max-w-[16rem] text-xs text-red-400">{fetcher.data.error}</p>
      )}
    </fetcher.Form>
  );
}
