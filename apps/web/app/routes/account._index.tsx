import { Link, useOutletContext } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Calendar, Clock, ArrowRight, RefreshCw } from "lucide-react";

type Me = { id: string; name: string | null; email: string; phone?: string | null; role: string };

interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  amount: number;
  customer_name: string;
  service_name: string;
  duration_min?: number;
  staff_name: string;
  shop_name: string;
  shop_slug: string;
  notes?: string | null;
}

interface BookingData { upcoming: Booking[]; past: Booking[] }

function formatDateTime(isoDate: string, isoTime: string) {
  try {
    const d = new Date(isoTime);
    return `${d.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" })} · ${d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" })}`;
  } catch { return isoDate; }
}

const STATUS_PILL: Record<string, string> = {
  pending:     "bg-amber-500/10 text-amber-400",
  confirmed:   "bg-gold/10 text-gold",
  in_progress: "bg-blue-500/10 text-blue-400",
  completed:   "bg-emerald-500/10 text-emerald-400",
  cancelled:   "bg-red-500/10 text-red-400",
  no_show:     "bg-white/5 text-white/30",
};


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
            className="text-xs text-gold hover:text-gold/80 transition-colors font-medium">
            Edit
          </button>
        )}
        {saved && <span className="text-xs text-emerald-400">Saved ✓</span>}
      </div>

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-white/40 mb-1">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1">Phone (optional)</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="+44 7700 900000"
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <div>
            <label className="block text-xs text-white/40 mb-1">Email</label>
            <p className="text-sm text-white/50">{me.email} <span className="text-white/25">(cannot change)</span></p>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setEditing(false); setName(me.name ?? ""); setPhone(me.phone ?? ""); }}
              className="flex-1 py-2 rounded-lg border border-white/20 text-sm text-white/60 hover:bg-white/5 transition-colors">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className="flex-1 py-2 rounded-lg bg-gold text-dark text-sm font-semibold hover:bg-gold/90 transition-colors disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/40">Name</dt>
            <dd className="text-white">{me.name?.trim() || "—"}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-white/40">Email</dt>
            <dd className="text-white">{me.email}</dd>
          </div>
          {me.phone && (
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 text-white/40">Phone</dt>
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

  const [data, setData]       = useState<BookingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/me/bookings", { credentials: "include" })
      .then(r => r.json())
      .then((j: { success?: boolean; data?: BookingData }) => {
        if (!cancelled && j.success && j.data) setData(j.data);
        else if (!cancelled) setError(true);
      })
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
        <p className="mt-1 text-sm text-white/40">Signed in as {me.email}</p>
      </div>

      {/* Profile card */}
      <ProfileCard me={me} />

      {/* Upcoming bookings */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-white flex items-center gap-2">
            <Calendar className="h-4 w-4 text-gold" /> Upcoming bookings
          </h2>
          {loading && <span className="text-xs text-white/30 animate-pulse">Loading…</span>}
        </div>

        {error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 text-sm text-red-300">
            Could not load bookings. Try refreshing the page.
          </div>
        ) : !loading && upcoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
            <p className="text-white/30 text-sm">No upcoming bookings.</p>
            <a href="/" className="mt-3 inline-flex items-center gap-1.5 text-sm text-gold hover:text-gold/80">
              Browse shops <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {upcoming.map(b => (
              <div key={b.id} className="rounded-xl border border-white/10 bg-dark-100 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{b.service_name}</p>
                    <p className="text-xs text-white/50 mt-0.5">{b.shop_name} · with {b.staff_name}</p>
                    <p className="text-xs text-white/40 mt-1 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDateTime(b.booking_date, b.start_time)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-gold">£{b.amount.toFixed(2)}</p>
                    <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[b.status] ?? "bg-white/5 text-white/40"}`}>
                      {b.status.replace("_"," ")}
                    </span>
                  </div>
                </div>
              </div>
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
              <div key={b.id} className="flex items-center gap-4 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 opacity-70">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{b.service_name}</p>
                  <p className="text-xs text-white/40">{b.shop_name} · {formatDateTime(b.booking_date, b.start_time)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[b.status] ?? "bg-white/5 text-white/40"}`}>
                    {b.status.replace("_"," ")}
                  </span>
                  {/* Rebook link — takes them to the shop booking page */}
                  <Link
                    to={`/${b.shop_slug}`}
                    className="flex items-center gap-1 text-xs text-gold/70 hover:text-gold transition-colors"
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
