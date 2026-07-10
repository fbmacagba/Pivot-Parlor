import { useState, useMemo } from "react";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { BookingsCalendar } from "~/components/admin/BookingsCalendar";

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
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "";
  const dateFrom = url.searchParams.get("from") ?? "";
  const dateTo = url.searchParams.get("to") ?? "";

  let bookings: Booking[] = [];
  if (shopId) {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const qs = params.toString() ? `?${params}` : "";
      bookings = await api.get<Booking[]>(`/api/shops/${shopId}/bookings${qs}`);
    } catch {
      bookings = [];
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = bookings.filter((b) => b.booking_date === today).length;
  const pendingCount = bookings.filter((b) => b.status === "pending").length;
  const completedRevenuePence = bookings
    .filter((b) => b.status === "completed")
    .reduce((sum, b) => sum + b.amount_pence, 0);

  return json({ bookings, shopId, stats: { total: bookings.length, todayCount, pendingCount, completedRevenuePence } });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;
  const form = await request.formData();
  const bookingId = form.get("bookingId") as string;
  const newStatus = form.get("status") as BookingStatus;
  await api.put(`/api/shops/${shopId}/bookings/${bookingId}/status`, { status: newStatus });
  return json({ ok: true });
}

const STATUS_META: Record<BookingStatus, { label: string; bg: string; text: string; dot: string }> = {
  pending:   { label: "Pending",   bg: "bg-amber-500/10",   text: "text-amber-400",   dot: "bg-amber-400"  },
  confirmed: { label: "Confirmed", bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
  completed: { label: "Completed", bg: "bg-blue-500/10",    text: "text-blue-400",    dot: "bg-blue-400"   },
  cancelled: { label: "Cancelled", bg: "bg-red-500/10",     text: "text-red-400",     dot: "bg-red-400"    },
  no_show:   { label: "No Show",   bg: "bg-white/5",        text: "text-white/40",    dot: "bg-white/30"   },
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours(); const m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function StatusBadge({ status }: { status: BookingStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${m.bg} ${m.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />{m.label}
    </span>
  );
}

function StatusSelect({ bookingId, current }: { bookingId: string; current: BookingStatus }) {
  const fetcher = useFetcher();
  const optimistic = fetcher.formData?.get("status") as BookingStatus | undefined;
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="bookingId" value={bookingId} />
      <select name="status" value={optimistic ?? current} onChange={(e) => fetcher.submit(e.currentTarget.form)}
        className="text-xs border border-white/20 rounded-lg px-2 py-1.5 bg-white/5 text-white/80 focus:outline-none focus:ring-2 focus:ring-gold cursor-pointer">
        {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
          <option key={s} value={s} className="bg-dark">{STATUS_META[s].label}</option>
        ))}
      </select>
    </fetcher.Form>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5 flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center text-gold">{icon}</div>
      <div>
        <p className="text-xs text-white/40 font-medium">{label}</p>
        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
      </div>
    </div>
  );
}

function BookingDrawer({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-dark border-l border-white/10 z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
          <div>
            <h2 className="font-heading font-semibold text-white">Booking Detail</h2>
            <p className="text-xs text-white/30 mt-0.5">#{booking.id.slice(0, 8).toUpperCase()}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/50 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="flex items-center justify-between">
            <StatusBadge status={booking.status} />
            <StatusSelect bookingId={booking.id} current={booking.status} />
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 grid grid-cols-2 gap-4">
            <div><p className="text-xs text-white/40 mb-1">Date</p><p className="text-sm font-semibold text-white">{formatDate(booking.booking_date)}</p></div>
            <div><p className="text-xs text-white/40 mb-1">Time</p><p className="text-sm font-semibold text-white">{formatTime(booking.start_time)} · {booking.duration_min}min</p></div>
          </div>
          <div>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-3">Customer</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center text-sm font-semibold text-gold">{booking.customer_name.charAt(0)}</div>
                <span className="text-sm font-medium text-white">{booking.customer_name}</span>
              </div>
              <a href={`mailto:${booking.customer_email}`} className="flex items-center gap-2 text-sm text-white/50 hover:text-gold transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                {booking.customer_email}
              </a>
              {booking.customer_phone && (
                <a href={`tel:${booking.customer_phone}`} className="flex items-center gap-2 text-sm text-white/50 hover:text-gold transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                  {booking.customer_phone}
                </a>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-3">Service</p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
              {[["Service", booking.service_name], ["Staff", booking.staff_name], ["Duration", `${booking.duration_min} min`]].map(([l, v]) => (
                <div key={l} className="flex justify-between">
                  <span className="text-sm text-white/40">{l}</span>
                  <span className="text-sm font-medium text-white">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-3">Payment</p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
              <div className="flex justify-between"><span className="text-sm text-white/40">Total</span><span className="text-sm font-semibold text-gold">{formatPence(booking.amount_pence)}</span></div>
              <div className="flex justify-between"><span className="text-sm text-white/40">Commission</span><span className="text-sm text-white/60">{formatPence(booking.commission_pence)}</span></div>
              <div className="border-t border-white/10 pt-2 flex justify-between"><span className="text-sm text-white/40">Net to shop</span><span className="text-sm font-semibold text-white">{formatPence(booking.amount_pence - booking.commission_pence)}</span></div>
            </div>
          </div>
          {booking.notes && (
            <div>
              <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-2">Notes</p>
              <p className="text-sm text-white/60 rounded-xl border border-white/10 bg-white/5 p-4">{booking.notes}</p>
            </div>
          )}
          <p className="text-xs text-white/20">Created {new Date(booking.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
        </div>
      </div>
    </>
  );
}

function BookingsList({ bookings, onSelect }: { bookings: Booking[]; onSelect: (b: Booking) => void }) {
  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) { const arr = map.get(b.booking_date) ?? []; map.set(b.booking_date, [...arr, b]); }
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [bookings]);

  if (bookings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 p-16 text-center text-white/30">
        <svg className="w-10 h-10 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        <p className="text-sm">No bookings found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(([date, dayBookings]) => (
        <div key={date}>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-white/40 uppercase tracking-wide">{formatDate(date)}</span>
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-white/20">{dayBookings.length}</span>
          </div>
          <div className="rounded-xl border border-white/10 bg-dark-100 overflow-hidden divide-y divide-white/5">
            {dayBookings.slice().sort((a, b) => a.start_time.localeCompare(b.start_time)).map((booking) => (
              <button key={booking.id} onClick={() => onSelect(booking)}
                className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/[0.03] transition-colors text-left">
                <div className="w-14 shrink-0"><span className="text-sm font-semibold text-white">{formatTime(booking.start_time)}</span></div>
                <div className="w-8 h-8 rounded-full bg-gold/20 flex items-center justify-center text-sm font-semibold text-gold shrink-0">{booking.customer_name.charAt(0)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{booking.customer_name}</p>
                  <p className="text-xs text-white/40 truncate">{booking.service_name} · {booking.staff_name}</p>
                </div>
                <span className="text-xs text-white/30 shrink-0 hidden sm:block">{booking.duration_min}min</span>
                <div className="shrink-0"><StatusBadge status={booking.status} /></div>
                <div className="w-16 text-right shrink-0"><span className="text-sm font-semibold text-gold">{formatPence(booking.amount_pence)}</span></div>
                <svg className="w-4 h-4 text-white/20 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminBookings() {
  const { bookings, stats } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

  const statusFilter = searchParams.get("status") ?? "";
  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";

  function updateFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Bookings</h1>
          <p className="mt-0.5 text-sm text-white/40">{stats.total} total · {stats.todayCount} today · {stats.pendingCount} pending</p>
        </div>
        <div className="flex items-center bg-white/5 border border-white/10 rounded-xl p-1 gap-0.5">
          {(["list", "calendar"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all capitalize ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {v === "list"
                ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>}
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total bookings" value={stats.total} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>} />
        <SummaryCard label="Today" value={stats.todayCount} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
        <SummaryCard label="Pending" value={stats.pendingCount} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>} />
        <SummaryCard label="Completed revenue" value={formatPence(stats.completedRevenuePence)} icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
      </div>

      {view === "list" && (
        <div className="flex flex-wrap gap-3">
          <select value={statusFilter} onChange={(e) => updateFilter("status", e.target.value)}
            className="text-sm border border-white/20 rounded-xl px-3 py-2.5 bg-white/5 text-white focus:outline-none focus:ring-2 focus:ring-gold">
            <option value="" className="bg-dark">All statuses</option>
            {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
              <option key={s} value={s} className="bg-dark">{STATUS_META[s].label}</option>
            ))}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => updateFilter("from", e.target.value)}
            className="text-sm border border-white/20 rounded-xl px-3 py-2.5 bg-white/5 text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          <input type="date" value={dateTo} onChange={(e) => updateFilter("to", e.target.value)}
            className="text-sm border border-white/20 rounded-xl px-3 py-2.5 bg-white/5 text-white focus:outline-none focus:ring-2 focus:ring-gold" />
          {(statusFilter || dateFrom || dateTo) && (
            <button onClick={() => setSearchParams({}, { replace: true })} className="text-sm text-white/40 hover:text-white px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors">Clear</button>
          )}
        </div>
      )}

      {view === "calendar"
        ? <BookingsCalendar bookings={bookings} onSelectBooking={setSelectedBooking} />
        : <BookingsList bookings={bookings} onSelect={setSelectedBooking} />}

      {selectedBooking && <BookingDrawer booking={selectedBooking} onClose={() => setSelectedBooking(null)} />}
    </div>
  );
}
