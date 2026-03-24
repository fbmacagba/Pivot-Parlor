import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";

type BookingStatus = "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";

interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: BookingStatus;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  service_name: string;
  duration_min: number;
  staff_name: string;
  amount: number;
  commission: number;
  notes: string | null;
}

const STATUS_BADGE: Record<BookingStatus, "warning" | "success" | "error" | "outline" | "gold" | "default"> = {
  pending:     "warning",
  confirmed:   "gold",
  in_progress: "gold",
  completed:   "success",
  cancelled:   "error",
  no_show:     "default",
};

// Status transitions allowed per current status
const NEXT_ACTIONS: Record<BookingStatus, { label: string; next: string }[]> = {
  pending:     [{ label: "Confirm",    next: "confirmed" },  { label: "Cancel", next: "cancelled" }],
  confirmed:   [{ label: "Start",      next: "in_progress" },{ label: "Cancel", next: "cancelled" }, { label: "No-show", next: "no_show" }],
  in_progress: [{ label: "Complete",   next: "completed" }],
  completed:   [],
  cancelled:   [],
  no_show:     [],
};

function formatDateTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;

  const url = new URL(request.url);
  const date   = url.searchParams.get("date")   ?? "";
  const status = url.searchParams.get("status") ?? "";

  let bookings: Booking[] = [];
  if (shopId) {
    try {
      const params = new URLSearchParams();
      if (date)   params.set("date", date);
      if (status) params.set("status", status);
      const qs = params.toString();
      bookings = await api.get<Booking[]>(`/api/shops/${shopId}/bookings${qs ? `?${qs}` : ""}`);
    } catch { /* empty */ }
  }

  return json({ bookings, shopId, date, status });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const bookingId = form.get("bookingId") as string;
  const newStatus = form.get("status") as string;
  const shopId = user.shop_id;

  if (!bookingId || !newStatus || !shopId) {
    return json({ error: "Missing fields" }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, token);
  try {
    await api.put(`/api/shops/${shopId}/bookings/${bookingId}/status`, { status: newStatus });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed" }, { status: 400 });
  }
}

export default function AdminBookings() {
  const { bookings, date, status } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-2xl font-bold text-white">Bookings</h1>
        {/* Filters */}
        <Form method="get" className="flex flex-wrap gap-2">
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <select
            name="status"
            defaultValue={status}
            className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
          >
            <option value="">All statuses</option>
            {["pending","confirmed","in_progress","completed","cancelled","no_show"].map(s => (
              <option key={s} value={s} className="bg-dark">{s.replace("_", " ")}</option>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline">Filter</Button>
          <Button type="reset" size="sm" variant="ghost" onClick={() => window.location.href = "/admin/bookings"}>Clear</Button>
        </Form>
      </div>

      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {["Customer", "Service", "Staff", "Date / Time", "Amount", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {bookings.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-white/30">
                  No bookings found.
                </td>
              </tr>
            ) : (
              bookings.map(b => {
                const actions = NEXT_ACTIONS[b.status] ?? [];
                return (
                  <tr key={b.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <p className="font-medium text-white">{b.customer_name}</p>
                      {b.customer_phone && (
                        <p className="text-xs text-white/40">{b.customer_phone}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-white/70">{b.service_name}</td>
                    <td className="px-4 py-3 text-white/60">{b.staff_name}</td>
                    <td className="px-4 py-3 text-white/60 whitespace-nowrap text-xs font-mono">
                      {formatDateTime(b.start_time)}
                    </td>
                    <td className="px-4 py-3 font-semibold text-gold whitespace-nowrap">
                      £{b.amount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_BADGE[b.status]}>{b.status.replace("_", " ")}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {actions.map(({ label, next }) => (
                          <Form key={next} method="post">
                            <input type="hidden" name="bookingId" value={b.id} />
                            <input type="hidden" name="status" value={next} />
                            <Button
                              type="submit"
                              size="sm"
                              variant={next === "completed" ? "default" : next === "cancelled" || next === "no_show" ? "destructive" : "outline"}
                              disabled={isSubmitting}
                            >
                              {label}
                            </Button>
                          </Form>
                        ))}
                        {b.notes && (
                          <span className="text-xs text-white/30 italic self-center" title={b.notes}>📝</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
