import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useState } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { formatDay, formatTime as formatUkTime } from "~/lib/dateFormat";
import { DEVELOPER_STAFF_READ_ONLY, pageStaffId, staffMePath } from "~/lib/pageShop";

interface Booking {
  id: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
}

interface TimeOff {
  id: string;
  from_date: string;
  to_date: string;
  reason: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

interface ScheduleRow { day_of_week: number; start_time: string; end_time: string; is_active: number }

const DAY_LABELS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const STATUS_BADGE: Record<string, "warning"|"success"|"error"|"gold"|"outline"|"default"> = {
  pending:   "warning",
  confirmed: "gold",
  in_progress: "gold",
  completed: "success",
  cancelled: "error",
  no_show:   "default",
};

/** A calendar day ("2026-11-12": booking_date, from_date, to_date) as "12 Nov 2026". */
function formatDate(day: string) {
  return formatDay(day, { day: "numeric", month: "short", year: "numeric" });
}
/** "09:05" on the London clock (app/lib/dateFormat.ts). */
function formatTime(iso: string) {
  return formatUkTime(iso, { hour: "2-digit", minute: "2-digit" }) || iso;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "upcoming";
  const tab    = url.searchParams.get("tab")    ?? "bookings";
  // A developer views the staff member they chose (staff.tsx), read-only.
  const readOnly = user.role === "developer";
  const staffId = pageStaffId(request, user);
  const needsStaff = readOnly && !staffId;

  let bookings: Booking[] = [];
  let schedule: ScheduleRow[] = [];
  let timeOff: TimeOff[] = [];

  if (!needsStaff) {
    const path = (p: string) => staffMePath(p, staffId);
    try { bookings = await api.get<Booking[]>(path(`/api/staff/me/bookings?filter=${encodeURIComponent(filter)}`)); } catch { /* empty */ }
    try { schedule = await api.get<ScheduleRow[]>(path("/api/staff/me/schedule")); } catch { /* empty */ }
    try { timeOff = await api.get<TimeOff[]>(path("/api/staff/me/time-off")); } catch { /* empty */ }
  }

  return json({ bookings, schedule, timeOff, filter, tab, readOnly, needsStaff });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  if (user.role === "developer") {
    return json({ ok: false, error: DEVELOPER_STAFF_READ_ONLY }, { status: 403 });
  }
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const body = await request.json() as { from_date?: string; to_date?: string; reason?: string };

  try {
    await api.post("/api/staff/me/time-off", body);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Failed" }, { status: 400 });
  }
}

export default function StaffBookingsAvailability() {
  const { bookings, schedule, timeOff, filter, readOnly, needsStaff } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [toast, setToast] = useState<{ type: "success"|"error"; text: string } | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate]     = useState("");
  const [reason, setReason]     = useState("");

  const activeTab = params.get("tab") ?? "bookings";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      setToast({ type: "success", text: "Time-off request submitted." });
      setFromDate(""); setToDate(""); setReason("");
    } else {
      setToast({ type: "error", text: fetcher.data.error ?? "Failed." });
    }
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg md:bottom-6 md:right-6 ${
          toast.type === "success" ? "border-emerald-500/40 bg-emerald-950/90 text-emerald-100" : "border-red-500/40 bg-red-950/90 text-red-100"
        }`} role="status">{toast.text}</div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-white/10 pb-0">
        {[
          { key: "bookings",     label: "My Bookings" },
          { key: "availability", label: "Availability" },
        ].map(t => (
          <button key={t.key}
            onClick={() => setParams(prev => { const n = new URLSearchParams(prev); n.set("tab", t.key); return n; })}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === t.key
                ? "border-gold text-gold"
                : "border-transparent text-white/50 hover:text-white"
            }`}
          >{t.label}</button>
        ))}
      </div>

      {/* ── BOOKINGS TAB ── */}
      {activeTab === "bookings" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            {["upcoming","past","today"].map(f => (
              <button key={f}
                onClick={() => setParams(prev => { const n = new URLSearchParams(prev); n.set("filter", f); n.set("tab","bookings"); return n; })}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  filter === f ? "bg-gold/20 text-gold" : "text-white/50 hover:text-white"
                }`}
              >{f}</button>
            ))}
          </div>

          {bookings.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/50 text-sm">
              {needsStaff ? "Choose a staff member above to see their bookings." : `No ${filter} bookings.`}
            </div>
          ) : (
            <div className="space-y-2">
              {bookings.map(b => (
                <div key={b.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/8 bg-dark-100 px-4 py-3 hover:border-white/15 transition-colors">
                  <div className="w-16 shrink-0 text-center">
                    <p className="text-sm font-semibold text-white">{formatTime(b.start_time)}</p>
                    <p className="text-xs text-white/50">{formatDate(b.booking_date)}</p>
                  </div>
                  <div className="h-8 w-px bg-white/10 shrink-0" />
                  <div className="min-w-[9rem] flex-1">
                    <p className="text-sm font-medium text-white truncate">{b.customer_name}</p>
                    <p className="text-xs text-white/50 truncate">{b.service_name} · {b.duration_min}m</p>
                  </div>
                  <Badge className="ml-auto shrink-0" variant={STATUS_BADGE[b.status] ?? "default"}>{b.status.replace("_"," ")}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ── */}
      {activeTab === "availability" && (
        <div className="space-y-6 max-w-2xl">
          {/* Weekly schedule (read-only) */}
          <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
            <h2 className="font-heading text-base font-semibold text-white mb-1">Weekly schedule</h2>
            <p className="text-xs text-white/60 mb-4">Set by your manager. Contact them to make changes.</p>
            <div className="space-y-2">
              {DAY_LABELS.map((label, d) => {
                const row = schedule.find(s => s.day_of_week === d);
                const isOn = row?.is_active === 1;
                return (
                  <div key={d} className="flex items-center gap-4 text-sm">
                    <span className="w-24 font-medium text-white/80">{label}</span>
                    {isOn && row
                      ? <span className="text-white/70">{row.start_time} to {row.end_time}</span>
                      : <span className="text-white/50">Off</span>
                    }
                  </div>
                );
              })}
            </div>
          </div>

          {/* Time off request form: the staff member's own; a developer only views. */}
          {readOnly ? (
            <p className="rounded-xl border border-white/10 bg-dark-100 p-5 text-sm text-white/60">
              Time off is requested by the staff member from their own screens.
            </p>
          ) : (
          <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
            <h2 className="font-heading text-base font-semibold text-white mb-4">Request time off</h2>
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Input label="From date" name="from" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                <Input label="To date"   name="to"   type="date" value={toDate}   onChange={e => setToDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Reason (optional)</label>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="flex w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-gold resize-none"
                  placeholder="Optional reason…"
                />
              </div>
              <Button
                type="button"
                size="sm"
                disabled={!fromDate || !toDate || fetcher.state !== "idle"}
                onClick={() => fetcher.submit(
                  { from_date: fromDate, to_date: toDate, reason: reason || undefined } as unknown as Record<string,string>,
                  { method: "POST", encType: "application/json" }
                )}
              >
                {fetcher.state !== "idle" ? "Submitting…" : "Submit request"}
              </Button>
            </div>
          </div>
          )}

          {/* Pending requests */}
          {timeOff.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
              <div className="px-5 py-4 border-b border-white/10">
                <h2 className="font-heading text-base font-semibold text-white">My requests</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    {["From","To","Reason","Status"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/60 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {timeOff.map(r => (
                    <tr key={r.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-white/80">{formatDate(r.from_date)}</td>
                      <td className="px-4 py-3 text-white/80">{formatDate(r.to_date)}</td>
                      <td className="px-4 py-3 text-white/50">{r.reason ?? "No reason given"}</td>
                      <td className="px-4 py-3">
                        <Badge variant={r.status === "approved" ? "success" : r.status === "denied" ? "error" : "warning"}>
                          {r.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
