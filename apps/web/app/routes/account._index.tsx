import { Link, useOutletContext } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Calendar, Clock, ArrowRight, RefreshCw, MailWarning } from "lucide-react";
import { formatPence } from "@repo/utils";
import { formatDate, formatTime } from "~/lib/dateFormat";

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

function bookingStartMs(b: Booking): number | null {
  const t = new Date(b.start_time).getTime();
  return Number.isNaN(t) ? null : t;
}

/** More than 2 hours before start — online cancel allowed (server enforces the same rule). */
function canCancelOnline(b: Booking): boolean {
  const t = bookingStartMs(b);
  return t != null && t - Date.now() > TWO_HOURS_MS;
}

function formatBookingWhen(b: Booking) {
  const t = bookingStartMs(b);
  if (t == null) return b.booking_date;
  return `${formatDate(t, { weekday: "short", day: "numeric", month: "short" })} · ${formatTime(t, { hour: "2-digit", minute: "2-digit" })}`;
}

const STATUS_PILL: Record<string, string> = {
  pending:     "bg-amber-500/10 text-amber-400",
  confirmed:   "bg-gold/10 text-gold",
  in_progress: "bg-blue-500/10 text-blue-400",
  completed:   "bg-emerald-500/10 text-emerald-400",
  cancelled:   "bg-red-500/10 text-red-400",
  no_show:     "bg-white/5 text-white/50",
};


function UpcomingBookingCard({
  booking,
  onCancelled,
}: {
  booking: Booking;
  onCancelled: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState("");

  const cancelAllowed = canCancelOnline(booking);
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
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (data.success) onCancelled();
      else setCancelErr(data.error ?? "Could not cancel this booking.");
    } catch {
      setCancelErr("Network error. Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{booking.service_name}</p>
          <p className="text-xs text-white/50 mt-0.5">{booking.shop_name} · with {booking.staff_name}</p>
          <p className="text-xs text-white/60 mt-1 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatBookingWhen(booking)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-gold">{formatPence(booking.amount_pence)}</p>
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[booking.status] ?? "bg-white/5 text-white/60"}`}>
            {booking.status.replace("_", " ")}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-white/5 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={bookUrl}
            className="tap-target inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors"
          >
            {cancelAllowed ? "Change time" : "Look for another time"}
            <ArrowRight className="h-3 w-3 opacity-70" />
          </Link>
          {cancelAllowed && (
            <button
              type="button"
              onClick={cancelBooking}
              disabled={cancelling}
              className="tap-target inline-flex items-center rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel booking"}
            </button>
          )}
        </div>
        {!cancelAllowed && (
          <p className="text-xs text-white/60">
            This appointment starts within two hours, so it can’t be cancelled here. You can still check the booking page for another free slot if you need a different time.
          </p>
        )}
        {cancelErr && <p className="text-xs text-red-400">{cancelErr}</p>}
      </div>
    </div>
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
        <MailWarning className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-300">Verify your email to see your bookings</p>
          <p className="mt-1 text-xs text-white/50">
            We need to confirm you own <span className="text-white/80">{email}</span> before showing
            bookings made with that address. Check your inbox for the verification link.
          </p>
          {state === "sent" ? (
            <p className="mt-3 text-xs text-emerald-400">
              Verification email sent. Check your inbox (and spam folder).
            </p>
          ) : (
            <button
              type="button"
              onClick={resend}
              disabled={state === "sending"}
              className="tap-target mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              {state === "sending" ? "Sending…" : "Resend verification email"}
            </button>
          )}
          {errorMsg && <p className="mt-2 text-xs text-red-400">{errorMsg}</p>}
        </div>
      </div>
    </div>
  );
}

function ProfileCard({ me }: { me: Me }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.name ?? "");
  const [phone, setPhone] = useState(me.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (data.success) {
        setSaved(true); setEditing(false);
        setTimeout(() => setSaved(false), 3000);
      } else {
        setErr(data.error ?? "Failed to save.");
      }
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-dark-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-heading text-base font-semibold text-white">Profile</h2>
        {!editing && (
          <button onClick={() => setEditing(true)}
            className="tap-target text-xs text-gold hover:text-gold/80 transition-colors font-medium">
            Edit
          </button>
        )}
        {saved && <span className="text-xs text-emerald-400">Saved ✓</span>}
      </div>

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-white/60 mb-1">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Phone (optional)</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="+44 7700 900000"
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs text-white/60 mb-1">Email</label>
            <p className="text-sm text-white/50">{me.email} <span className="text-white/60">(cannot change)</span></p>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setEditing(false); setName(me.name ?? ""); setPhone(me.phone ?? ""); }}
              className="tap-target flex-1 py-2 rounded-lg border border-white/20 text-sm text-white/60 hover:bg-white/5 transition-colors">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className="tap-target flex-1 py-2 rounded-lg bg-gold text-dark text-sm font-semibold hover:bg-gold/90 transition-colors disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
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
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/60">Name</dt>
            <dd className="text-white">{me.name?.trim() || "—"}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/60">Email</dt>
            <dd className="min-w-0 break-words text-white">{me.email}</dd>
          </div>
          {me.phone && (
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
  const { me } = useOutletContext<{ me: Me }>();
  const displayName = me.name?.trim() || "there";

  const [data, setData]           = useState<BookingData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(false);
  const [unverified, setUnverified] = useState(false);

  function reloadBookings() {
    setLoading(true);
    setError(false);
    fetch("/api/me/bookings", { credentials: "include" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as
          { success?: boolean; data?: BookingData; code?: string } | null;
        if (j?.code === "email_unverified") { setUnverified(true); return null; }
        if (!r.ok || !j?.success || !j.data) throw new Error("bad response");
        setUnverified(false);
        return j.data;
      })
      .then((d) => { if (d) setData(d); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch("/api/me/bookings", { credentials: "include" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as
          { success?: boolean; data?: BookingData; code?: string } | null;
        if (j?.code === "email_unverified") {
          if (!cancelled) setUnverified(true);
          return null;
        }
        if (!r.ok || !j?.success || !j.data) throw new Error("bad response");
        return j.data;
      })
      .then((d) => { if (!cancelled && d) setData(d); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const upcoming = data?.upcoming ?? [];
  const past     = data?.past     ?? [];

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
      <ProfileCard me={me} />

      {/* Email verification gate (SEC-3) */}
      {unverified && <VerifyEmailBanner email={me.email} />}

      {/* Upcoming bookings */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-white flex items-center gap-2">
            <Calendar className="h-4 w-4 text-gold" /> Upcoming bookings
          </h2>
          {loading && <span className="text-xs text-white/50 animate-pulse">Loading…</span>}
        </div>

        {unverified ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-white/50">
            Verify your email above to see your bookings.
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
            Could not load bookings. Try refreshing the page.
          </div>
        ) : loading && data === null ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-white/50">
            Loading your bookings…
          </div>
        ) : upcoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
            <p className="text-white/60 text-sm">You have no bookings to show.</p>
            <a href="/" className="tap-target mt-3 inline-flex items-center gap-1.5 text-sm text-gold hover:text-gold/80">
              Browse shops <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {upcoming.map((b) => (
              <UpcomingBookingCard key={b.id} booking={b} onCancelled={reloadBookings} />
            ))}
          </div>
        )}
      </section>

      {/* Past bookings */}
      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-heading text-base font-semibold text-white/60 flex items-center gap-2">
            <Clock className="h-4 w-4" /> Past bookings
          </h2>
          <div className="space-y-2">
            {past.map(b => (
              <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 opacity-70">
                <div className="min-w-[9rem] flex-1">
                  <p className="text-sm font-medium text-white truncate">{b.service_name}</p>
                  <p className="text-xs text-white/60">{b.shop_name} · {formatBookingWhen(b)}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[b.status] ?? "bg-white/5 text-white/60"}`}>
                    {b.status.replace("_"," ")}
                  </span>
                  {/* Rebook link — takes them to the shop booking page */}
                  <Link
                    to={`/${b.shop_slug}`}
                    className="tap-target flex items-center gap-1 text-xs text-gold/70 hover:text-gold transition-colors"
                    title="Book again"
                  >
                    <RefreshCw className="h-3 w-3" /> Rebook
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
