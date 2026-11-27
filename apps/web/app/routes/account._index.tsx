import { Link, useLoaderData, useOutletContext, useRevalidator, useSearchParams, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { Calendar, Check, Clock, ArrowRight, RefreshCw, MailWarning } from "lucide-react";
import { formatPence } from "@repo/utils";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { getSessionToken, requireRole } from "~/lib/auth";
import { bookingInstantMs, formatDate, formatDay, formatTime } from "~/lib/dateFormat";
import { pageTitle } from "~/lib/pageTitle";

export const meta = () => pageTitle("Your bookings");

type Me = { id: string; name: string | null; email: string; phone?: string | null; role: string };

interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  amount_pence: number;
  customer_name: string;
  service_name: string;
  duration_min?: number;
  staff_name: string;
  shop_name: string;
  shop_slug: string;
  notes?: string | null;
}

interface BookingData { upcoming: Booking[]; past: Booking[] }

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Each list grows by this many, up to the most the API gives. */
const PAGE = 20;
const CAP = 100;

function pageLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= PAGE) return PAGE;
  return Math.min(CAP, Math.ceil(n / PAGE) * PAGE);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "customer", env.API_URL);
  const token = getSessionToken(request);
  const limit = pageLimit(new URL(request.url).searchParams.get("limit"));

  // Read by hand rather than through createApiClient: the "verify your email
  // first" refusal is told apart from a failed load by its `code`.
  let bookings: BookingData | null = null;
  let unverified = false;
  let loadError = false;
  try {
    const res = await fetch(`${env.API_URL}/api/me/bookings?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as
      { success?: boolean; data?: BookingData; code?: string } | null;
    if (body?.code === "email_unverified") unverified = true;
    else if (res.ok && body?.success && Array.isArray(body.data?.upcoming) && Array.isArray(body.data?.past)) {
      bookings = { upcoming: body.data.upcoming, past: body.data.past };
    } else loadError = true;
  } catch {
    loadError = true;
  }

  // "Now" is read once here, so the server's page and the browser's first
  // render agree on which bookings can still be cancelled.
  return json({ bookings, unverified, loadError, limit, now: Date.now() });
}

/**
 * When the booking starts, or null when it cannot be read. start_time is an
 * instant for an online booking and the shop's own clock reading ("09:30")
 * for a walk-in or deposit booking, which new Date() cannot read.
 */
function bookingStartMs(b: Booking): number | null {
  return bookingInstantMs(b.booking_date, b.start_time);
}

/** More than 2 hours before start: online cancel allowed (the server enforces the same rule). */
function canCancelOnline(b: Booking, now: number): boolean {
  const t = bookingStartMs(b);
  return t != null && t - now > TWO_HOURS_MS;
}

function formatBookingWhen(b: Booking) {
  const day = formatDay(b.booking_date, { weekday: "short", day: "numeric", month: "short" });
  const time = formatTime(b.start_time, { hour: "2-digit", minute: "2-digit" });
  const t = bookingStartMs(b);
  // An instant gives its own London day; a clock reading belongs to booking_date.
  const date = t != null ? formatDate(t, { weekday: "short", day: "numeric", month: "short" }) : day;
  return time ? `${date} · ${time}` : date;
}

function UpcomingBookingCard({
  booking,
  now,
  onCancelled,
}: {
  booking: Booking;
  now: number;
  onCancelled: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState("");

  const startMs = bookingStartMs(booking);
  const cancellable = booking.status === "pending" || booking.status === "confirmed";
  const cancelAllowed = cancellable && canCancelOnline(booking, now);
  const bookUrl = `/${booking.shop_slug}/book`;

  async function cancelBooking() {
    if (!cancelAllowed || cancelling) return;
    setCancelling(true);
    setCancelErr("");
    try {
      const res = await fetch("/api/me/bookings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "cancel", bookingId: booking.id }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (data?.success) {
        setConfirming(false);
        onCancelled();
      } else {
        setCancelErr(data?.error ?? "This booking was not cancelled. Try again, or contact the shop.");
      }
    } catch {
      setCancelErr("This booking was not cancelled: we could not reach the server. Check your connection and try again.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <li className="rounded-xl border border-white/10 bg-dark-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white break-words">{booking.service_name}</p>
          <p className="text-xs text-white/60 mt-0.5">{booking.shop_name} · with {booking.staff_name}</p>
          <p className="text-sm text-white/80 mt-1 flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {formatBookingWhen(booking)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="text-sm font-bold text-gold">{formatPence(booking.amount_pence)}</p>
          <StatusBadge status={booking.status} />
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-white/5 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* When it can still be cancelled here, Cancel leads: booking another
              time does not move this booking, it adds a second one. */}
          {cancelAllowed && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setCancelErr("");
                setConfirming(true);
              }}
            >
              Cancel booking
            </Button>
          )}
          <Button asChild variant="secondary" size="sm">
            <Link to={bookUrl}>
              Book another time
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </Button>
        </div>
        <p className="text-xs text-white/60">
          {cancelAllowed
            ? "Booking a new time does not cancel this one. Cancel it here if you no longer need it."
            : !cancellable
              ? "Booking a new time does not change this booking."
              : startMs == null
                ? "We could not read this booking's time, so it cannot be cancelled here. Contact the shop to cancel or move it. Booking a new time does not cancel this one."
                : "This appointment starts within two hours, so it cannot be cancelled here. Contact the shop to cancel or move it. Booking a new time does not cancel this one."}
        </p>
      </div>

      <ConfirmDialog
        open={confirming}
        onCancel={() => {
          setConfirming(false);
          setCancelErr("");
        }}
        onConfirm={cancelBooking}
        title="Cancel this booking?"
        confirmLabel="Cancel booking"
        cancelLabel="Keep booking"
        destructive
        pending={cancelling}
        pendingLabel="Cancelling…"
        error={cancelErr || null}
      >
        <p>
          {booking.service_name} at {booking.shop_name}, {formatBookingWhen(booking)}. Your time is given up
          and cannot be taken back here: to come in after all you would need to book again.
        </p>
        {/* The bookings list does not say whether a deposit was paid, so this
            is shown for every booking. Cancelling never refunds by itself. */}
        <p>
          If you paid a deposit, the shop will decide whether to refund it. Contact the shop if you need it
          back.
        </p>
      </ConfirmDialog>
    </li>
  );
}

/** Shown when the worker gates bookings behind email verification (SEC-3). */
function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function resend() {
    if (state === "sending") return;
    setState("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/me/resend-verification", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && data?.success) {
        setState("sent");
      } else {
        setErrorMsg(data?.error ?? "Could not send the email. Please try again later.");
        setState("error");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setState("error");
    }
  }

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <MailWarning className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-300">Verify your email to see your bookings</p>
          <p className="mt-1 text-sm text-white/70">
            We need to confirm you own <span className="text-white">{email}</span> before showing
            bookings made with that address. Check your inbox for the verification link.
          </p>
          {state !== "sent" && (
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={resend} disabled={state === "sending"}>
              {state === "sending" ? "Sending…" : "Resend verification email"}
            </Button>
          )}
          <p role="status" className="mt-3 text-sm text-emerald-300">
            {state === "sent" ? "Verification email sent. Check your inbox (and spam folder)." : ""}
          </p>
          {errorMsg && <p role="alert" className="mt-2 text-sm text-red-300">{errorMsg}</p>}
        </div>
      </div>
    </div>
  );
}

function ProfileCard({ me, onSaved }: { me: Me; onSaved: (profile: { name: string; phone: string }) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.name ?? "");
  const [phone, setPhone] = useState(me.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (saving) return;
    setSaving(true); setErr(""); setSaved(false);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (data?.success) {
        setSaved(true); setEditing(false);
        onSaved({ name: name.trim(), phone: phone.trim() });
      } else {
        setErr(data?.error ?? "Your details were not saved. Check them and try again.");
      }
    } catch {
      setErr("Your details were not saved: we could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-dark-100 p-5" aria-labelledby="pp-account-profile">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 id="pp-account-profile" className="font-heading text-base font-semibold text-white">Profile</h2>
        <div className="flex items-center gap-3">
          {/* Always in the page, so a screen reader hears "Saved" arrive. */}
          <span role="status" className="flex items-center gap-1 text-sm text-emerald-300">
            {saved && !editing && (
              <>
                <Check className="h-4 w-4" aria-hidden /> Saved
              </>
            )}
          </span>
          {!editing && (
            <Button type="button" variant="ghost" size="sm" className="text-gold" onClick={() => { setSaved(false); setEditing(true); }}>
              Edit<span className="sr-only"> profile</span>
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input label="Name" type="text" autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          <Input
            label="Phone (optional)"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+44 7700 900000"
          />
          <div>
            <p className="text-sm font-medium text-white/80">Email</p>
            <p className="mt-1 break-words text-sm text-white/70">{me.email} (cannot be changed here)</p>
          </div>
          {err && <p role="alert" className="text-sm text-red-300">{err}</p>}
          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              disabled={saving}
              onClick={() => { setEditing(false); setErr(""); setName(me.name ?? ""); setPhone(me.phone ?? ""); }}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving ? "Saving…" : "Save profile"}
            </Button>
          </div>
          {/* Point-of-collection notice (LEG-3): platform account data. */}
          <p className="text-xs text-white/60">
            We use these details to run your account and manage your bookings.
            See our{" "}
            <Link to="/privacy" className="underline hover:text-white/80">
              Privacy Policy
            </Link>
            .
          </p>
        </form>
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/60">Name</dt>
            <dd className="min-w-0 break-words text-white">{me.name?.trim() || "Not set"}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/60">Email</dt>
            <dd className="min-w-0 break-words text-white">{me.email}</dd>
          </div>
          {me.phone?.trim() && (
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 text-white/60">Phone</dt>
              <dd className="text-white">{me.phone}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

export default function AccountIndex() {
  const { me: loadedMe } = useOutletContext<{ me: Me }>();
  const { bookings, unverified, loadError, limit, now } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();

  // What was just saved shows at once (the greeting too); the reload that
  // follows brings the same values back from the account itself.
  const [savedProfile, setSavedProfile] = useState<{ name: string; phone: string } | null>(null);
  const me: Me = savedProfile ? { ...loadedMe, name: savedProfile.name, phone: savedProfile.phone } : loadedMe;
  const displayName = me.name?.trim() || "there";

  const upcoming = bookings?.upcoming ?? [];
  const past     = bookings?.past     ?? [];
  // A full list may have more behind it; the API has no count to say for sure.
  const full = upcoming.length >= limit || past.length >= limit;
  const moreHref = () => {
    const n = new URLSearchParams(params);
    n.set("limit", String(Math.min(CAP, limit + PAGE)));
    return `?${n}`;
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">
          Hey, <span className="text-gold">{displayName}</span>
        </h1>
        <p className="mt-1 text-sm text-white/60">Signed in as {me.email}</p>
      </div>

      {/* Profile card */}
      <ProfileCard
        me={me}
        onSaved={(profile) => {
          setSavedProfile(profile);
          void revalidator.revalidate();
        }}
      />

      {/* Email verification gate (SEC-3) */}
      {unverified && <VerifyEmailBanner email={me.email} />}

      {/* Upcoming bookings */}
      <section className="space-y-3" aria-labelledby="pp-account-upcoming">
        <h2 id="pp-account-upcoming" className="font-heading text-base font-semibold text-white flex items-center gap-2">
          <Calendar className="h-4 w-4 text-gold" aria-hidden /> Upcoming bookings
        </h2>

        {unverified ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-white/60">
            Verify your email above to see your bookings.
          </div>
        ) : loadError ? (
          <LoadError what="your bookings" />
        ) : upcoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
            <p className="text-sm text-white/70">You have no upcoming bookings.</p>
            <p className="mt-1 text-sm text-white/60">Your bookings appear here after you book with a shop.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {upcoming.map((b) => (
              <UpcomingBookingCard key={b.id} booking={b} now={now} onCancelled={() => void revalidator.revalidate()} />
            ))}
          </ul>
        )}
      </section>

      {/* Past bookings */}
      {past.length > 0 && (
        <section className="space-y-3" aria-labelledby="pp-account-past">
          <h2 id="pp-account-past" className="font-heading text-base font-semibold text-white/80 flex items-center gap-2">
            <Clock className="h-4 w-4" aria-hidden /> Past bookings
          </h2>
          <ul className="space-y-2">
            {past.map(b => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm font-medium text-white/80 break-words">{b.service_name}</p>
                  <p className="text-xs text-white/60">{b.shop_name} · {formatBookingWhen(b)}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <StatusBadge status={b.status} />
                  {/* Takes them to the shop's site, to book again */}
                  <Link
                    to={`/${b.shop_slug}`}
                    className="tap-target flex items-center gap-1 text-sm text-gold hover:text-gold/80 transition-colors"
                    aria-label={`Book ${b.service_name} at ${b.shop_name} again`}
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Book again
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Both lists come 20 at a time */}
      {!unverified && !loadError && full && limit < CAP && (
        <div className="text-center">
          <Button asChild variant="secondary">
            <Link to={moreHref()} preventScrollReset replace>
              Show more bookings
            </Link>
          </Button>
        </div>
      )}
      {!unverified && !loadError && full && limit >= CAP && (
        <p role="status" className="text-center text-sm text-white/60">
          Showing up to {CAP} upcoming and {CAP} past bookings, which is as many as this page holds. Contact the
          shop about anything older.
        </p>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/account" homeLabel="Back to your bookings" />;
}
