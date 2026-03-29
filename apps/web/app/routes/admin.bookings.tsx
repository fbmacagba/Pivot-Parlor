// apps/web/app/routes/admin.bookings.tsx

import { useState, useMemo } from "react";
import { json } from "@remix-run/cloudflare";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { requireAdminSession } from "~/lib/auth.server";
import { AdminLayout } from "~/components/admin/AdminLayout";
import { BookingsCalendar } from "~/components/admin/BookingsCalendar";

// ─── Types ───────────────────────────────────────────────────────────────────

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show";

export interface Booking {
  id: string;
  booking_date: string;       // "YYYY-MM-DD"
  booking_time: string;       // "HH:MM"
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  service_name: string;
  staff_name: string;
  status: BookingStatus;
  duration_minutes: number;
  price: number;              // pence
  deposit_paid: number;       // pence
  notes: string | null;
  created_at: string;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await requireAdminSession(request, context);
  const { shop_id } = session;

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "all";
  const dateFrom = url.searchParams.get("from") ?? "";
  const dateTo = url.searchParams.get("to") ?? "";
  const search = url.searchParams.get("q") ?? "";

  // Build query
  let query = `
    SELECT
      b.id,
      b.booking_date,
      b.booking_time,
      b.status,
      b.duration_minutes,
      b.price,
      b.deposit_paid,
      b.notes,
      b.created_at,
      u.full_name  AS customer_name,
      u.email      AS customer_email,
      u.phone      AS customer_phone,
      svc.name     AS service_name,
      st.full_name AS staff_name
    FROM bookings b
    JOIN users       u   ON b.customer_id = u.id
    JOIN services    svc ON b.service_id  = svc.id
    JOIN staff       st  ON b.staff_id    = st.id
    WHERE b.shop_id = ?
  `;

  const params: (string | number)[] = [shop_id];

  if (statusFilter !== "all") {
    query += " AND b.status = ?";
    params.push(statusFilter);
  }
  if (dateFrom) {
    query += " AND b.booking_date >= ?";
    params.push(dateFrom);
  }
  if (dateTo) {
    query += " AND b.booking_date <= ?";
    params.push(dateTo);
  }
  if (search) {
    query += " AND (u.full_name LIKE ? OR u.email LIKE ? OR svc.name LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  query += " ORDER BY b.booking_date DESC, b.booking_time ASC";

  const { results } = await context.env.DB.prepare(query)
    .bind(...params)
    .all<Booking>();

  // Stats for summary cards
  const today = new Date().toISOString().slice(0, 10);
  const todayBookings = (results ?? []).filter((b) => b.booking_date === today);
  const pendingCount = (results ?? []).filter((b) => b.status === "pending").length;
  const revenue = (results ?? [])
    .filter((b) => b.status === "completed")
    .reduce((sum, b) => sum + b.price, 0);

  return json({
    bookings: results ?? [],
    stats: {
      total: results?.length ?? 0,
      todayCount: todayBookings.length,
      pendingCount,
      completedRevenue: revenue,
    },
  });
}

// ─── Action (status update) ───────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  const session = await requireAdminSession(request, context);
  const { shop_id } = session;

  const form = await request.formData();
  const intent = form.get("intent") as string;
  const bookingId = form.get("bookingId") as string;

  if (intent === "updateStatus") {
    const newStatus = form.get("status") as BookingStatus;
    await context.env.DB.prepare(
      `UPDATE bookings SET status = ? WHERE id = ? AND shop_id = ?`
    )
      .bind(newStatus, bookingId, shop_id)
      .run();
    return json({ ok: true });
  }

  return json({ ok: false }, 400);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<
  BookingStatus,
  { label: string; bg: string; text: string; dot: string }
> = {
  pending:   { label: "Pending",   bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-400"  },
  confirmed: { label: "Confirmed", bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
  completed: { label: "Completed", bg: "bg-blue-50",    text: "text-blue-700",    dot: "bg-blue-500"   },
  cancelled: { label: "Cancelled", bg: "bg-red-50",     text: "text-red-700",     dot: "bg-red-400"    },
  no_show:   { label: "No Show",   bg: "bg-gray-100",   text: "text-gray-600",    dot: "bg-gray-400"   },
};

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const p = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${p}`;
}

function formatPrice(pence: number) {
  return `£${(pence / 100).toFixed(2)}`;
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: BookingStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${m.bg} ${m.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function StatusSelect({
  bookingId,
  current,
}: {
  bookingId: string;
  current: BookingStatus;
}) {
  const fetcher = useFetcher();
  const optimistic = fetcher.formData?.get("status") as BookingStatus | undefined;
  const displayed = optimistic ?? current;

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="updateStatus" />
      <input type="hidden" name="bookingId" value={bookingId} />
      <select
        name="status"
        value={displayed}
        onChange={(e) => fetcher.submit(e.currentTarget.form)}
        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
      >
        {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
          <option key={s} value={s}>
            {STATUS_META[s].label}
          </option>
        ))}
      </select>
    </fetcher.Form>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${accent}`}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <p className="text-xl font-bold text-gray-900 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

// ─── Booking Detail Drawer ────────────────────────────────────────────────────

function BookingDrawer({
  booking,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Booking Detail</h2>
            <p className="text-xs text-gray-400 mt-0.5">#{booking.id.slice(0, 8).toUpperCase()}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Status */}
          <div className="flex items-center justify-between">
            <StatusBadge status={booking.status} />
            <StatusSelect bookingId={booking.id} current={booking.status} />
          </div>

          {/* Date / Time */}
          <div className="bg-gray-50 rounded-xl p-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Date</p>
              <p className="text-sm font-semibold text-gray-900">{formatDate(booking.booking_date)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Time</p>
              <p className="text-sm font-semibold text-gray-900">
                {formatTime(booking.booking_time)} · {booking.duration_minutes}min
              </p>
            </div>
          </div>

          {/* Customer */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Customer</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-semibold text-indigo-700">
                  {booking.customer_name.charAt(0)}
                </div>
                <span className="text-sm font-medium text-gray-900">{booking.customer_name}</span>
              </div>
              <a href={`mailto:${booking.customer_email}`} className="flex items-center gap-2 text-sm text-gray-500 hover:text-indigo-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {booking.customer_email}
              </a>
              {booking.customer_phone && (
                <a href={`tel:${booking.customer_phone}`} className="flex items-center gap-2 text-sm text-gray-500 hover:text-indigo-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  {booking.customer_phone}
                </a>
              )}
            </div>
          </div>

          {/* Service */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Service</p>
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Service</span>
                <span className="text-sm font-medium text-gray-900">{booking.service_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Staff</span>
                <span className="text-sm font-medium text-gray-900">{booking.staff_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Duration</span>
                <span className="text-sm font-medium text-gray-900">{booking.duration_minutes} min</span>
              </div>
            </div>
          </div>

          {/* Payment */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Payment</p>
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Total</span>
                <span className="text-sm font-semibold text-gray-900">{formatPrice(booking.price)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Deposit paid</span>
                <span className="text-sm font-medium text-emerald-600">{formatPrice(booking.deposit_paid)}</span>
              </div>
              <div className="border-t border-gray-200 pt-2 flex justify-between">
                <span className="text-sm text-gray-600">Balance due</span>
                <span className="text-sm font-semibold text-gray-900">
                  {formatPrice(Math.max(0, booking.price - booking.deposit_paid))}
                </span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {booking.notes && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Notes</p>
              <p className="text-sm text-gray-600 bg-gray-50 rounded-xl p-4">{booking.notes}</p>
            </div>
          )}

          <div>
            <p className="text-xs text-gray-400">
              Created {new Date(booking.created_at).toLocaleDateString("en-GB", {
                day: "numeric", month: "short", year: "numeric"
              })}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

function BookingsList({
  bookings,
  onSelect,
}: {
  bookings: Booking[];
  onSelect: (b: Booking) => void;
}) {
  if (bookings.length === 0) {
    return (
      <div className="text-center py-20 text-gray-400">
        <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="text-sm font-medium">No bookings found</p>
        <p className="text-xs mt-1">Try adjusting your filters</p>
      </div>
    );
  }

  // Group by date
  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) {
      const existing = map.get(b.booking_date) ?? [];
      map.set(b.booking_date, [...existing, b]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a));
  }, [bookings]);

  return (
    <div className="space-y-6">
      {grouped.map(([date, dayBookings]) => (
        <div key={date}>
          {/* Date separator */}
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {formatDate(date)}
            </span>
            <div className="flex-1 h-px bg-gray-100" />
            <span className="text-xs text-gray-400">{dayBookings.length}</span>
          </div>

          {/* Booking rows */}
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden divide-y divide-gray-100">
            {dayBookings
              .slice()
              .sort((a, b) => a.booking_time.localeCompare(b.booking_time))
              .map((booking) => (
                <button
                  key={booking.id}
                  onClick={() => onSelect(booking)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors text-left"
                >
                  {/* Time */}
                  <div className="w-14 shrink-0">
                    <span className="text-sm font-semibold text-gray-900">
                      {formatTime(booking.booking_time)}
                    </span>
                  </div>

                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-semibold text-indigo-700 shrink-0">
                    {booking.customer_name.charAt(0)}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{booking.customer_name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {booking.service_name} · {booking.staff_name}
                    </p>
                  </div>

                  {/* Duration */}
                  <span className="text-xs text-gray-400 shrink-0 hidden sm:block">
                    {booking.duration_minutes}min
                  </span>

                  {/* Status */}
                  <div className="shrink-0">
                    <StatusBadge status={booking.status} />
                  </div>

                  {/* Price */}
                  <div className="w-16 text-right shrink-0">
                    <span className="text-sm font-semibold text-gray-900">{formatPrice(booking.price)}</span>
                  </div>

                  {/* Chevron */}
                  <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminBookings() {
  const { bookings, stats } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

  const statusFilter = searchParams.get("status") ?? "all";
  const searchQuery = searchParams.get("q") ?? "";

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
    <AdminLayout>
      <div className="p-6 max-w-6xl mx-auto">

        {/* ── Page Header ── */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
            <p className="text-sm text-gray-500 mt-1">
              {stats.total} total · {stats.todayCount} today · {stats.pendingCount} pending
            </p>
          </div>

          {/* View toggle */}
          <div className="flex items-center bg-gray-100 rounded-xl p-1 gap-0.5">
            <button
              onClick={() => setView("list")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                view === "list"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              List
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                view === "calendar"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Calendar
            </button>
          </div>
        </div>

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <SummaryCard
            label="Total Bookings"
            value={stats.total}
            accent="bg-indigo-50"
            icon={
              <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />
          <SummaryCard
            label="Today"
            value={stats.todayCount}
            accent="bg-emerald-50"
            icon={
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <SummaryCard
            label="Pending"
            value={stats.pendingCount}
            accent="bg-amber-50"
            icon={
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
          />
          <SummaryCard
            label="Revenue"
            value={formatPrice(stats.completedRevenue)}
            accent="bg-blue-50"
            icon={
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
        </div>

        {/* ── Filters (list view only) ── */}
        {view === "list" && (
          <div className="flex flex-wrap gap-3 mb-6">
            {/* Search */}
            <div className="relative flex-1 min-w-48">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search customer, service…"
                value={searchQuery}
                onChange={(e) => updateFilter("q", e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              />
            </div>

            {/* Status filter */}
            <select
              value={statusFilter}
              onChange={(e) => updateFilter("status", e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="all">All statuses</option>
              {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>

            {/* Date range */}
            <input
              type="date"
              value={searchParams.get("from") ?? ""}
              onChange={(e) => updateFilter("from", e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <input
              type="date"
              value={searchParams.get("to") ?? ""}
              onChange={(e) => updateFilter("to", e.target.value)}
              className="text-sm border border-gray-200 rounded-xl px-3 py-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />

            {/* Clear */}
            {(statusFilter !== "all" || searchQuery || searchParams.get("from") || searchParams.get("to")) && (
              <button
                onClick={() => setSearchParams({}, { replace: true })}
                className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2.5 rounded-xl hover:bg-gray-100 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── Main Content ── */}
        {view === "calendar" ? (
          <BookingsCalendar
            bookings={bookings}
            onSelectBooking={setSelectedBooking}
          />
        ) : (
          <BookingsList bookings={bookings} onSelect={setSelectedBooking} />
        )}

      </div>

      {/* ── Detail Drawer ── */}
      {selectedBooking && (
        <BookingDrawer
          booking={selectedBooking}
          onClose={() => setSelectedBooking(null)}
        />
      )}
    </AdminLayout>
  );
}
