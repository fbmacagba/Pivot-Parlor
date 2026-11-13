import { useFetcher } from "@remix-run/react";

/**
 * A booking's status as a select that saves on change (the admin bookings
 * table). `onBeforeChange` may take over a change instead of saving it (a
 * cancellation with a captured deposit opens the refund-or-keep dialog); the
 * select is controlled, so it snaps back meanwhile.
 */
export function BookingStatusSelect({
  bookingId,
  status,
  options,
  onBeforeChange,
}: {
  bookingId: string;
  status: string;
  options: Array<{ value: string; label: string }>;
  /** Return true when the change was handled elsewhere and must not be saved. */
  onBeforeChange?: (next: string) => boolean;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const optimistic = fetcher.formData?.get("status") as string | undefined;
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="bookingId" value={bookingId} />
      <select
        name="status"
        value={optimistic ?? status}
        onChange={(e) => {
          if (onBeforeChange?.(e.currentTarget.value)) return;
          fetcher.submit(e.currentTarget.form);
        }}
        className="text-xs border border-white/20 rounded-lg px-2 py-1.5 bg-white/5 text-white/80 focus:outline-none focus:ring-2 focus:ring-gold cursor-pointer">
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-dark">{o.label}</option>
        ))}
      </select>
      {/* A refused change (e.g. reinstating a booking whose time is now
          taken) says why, instead of only snapping back. */}
      {fetcher.state === "idle" && fetcher.data && !fetcher.data.ok && fetcher.data.error && (
        <p role="alert" className="mt-1 max-w-[16rem] text-xs text-red-400">{fetcher.data.error}</p>
      )}
    </fetcher.Form>
  );
}
