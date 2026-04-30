import { Link, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Clock, ArrowRight, CheckCircle } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";

interface TodayBooking {
  id: string;
  start_time: string;
  end_time: string;
  status: string;
  customer_name: string;
  service_name: string;
  duration_min: number;
  amount: number;
  notes?: string | null;
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let todayBookings: TodayBooking[] = [];
  try {
    todayBookings = await api.get<TodayBooking[]>("/api/staff/me/today");
    if (!Array.isArray(todayBookings)) todayBookings = [];
  } catch { /* empty */ }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const displayName = user.sub ?? "there";

  return json({ todayBookings, greeting, displayName });
}

export default function StaffToday() {
  const { todayBookings, greeting } = useLoaderData<typeof loader>();

  const upcoming  = todayBookings.filter(b => b.status !== "completed" && b.status !== "cancelled");
  const completed = todayBookings.filter(b => b.status === "completed");
  const next      = upcoming[0] ?? null;

  const minsUntilNext = next ? minutesUntil(next.start_time) : null;

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">{greeting}</h1>
          <p className="mt-0.5 text-sm text-white/40">
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <Link to="/staff/bookings" className="flex items-center gap-1.5 text-sm text-gold hover:text-gold/80">
          All bookings <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {/* Next appointment card */}
      {next ? (
        <div className="rounded-xl border border-gold/25 bg-gold/5 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gold/70 mb-3">Next appointment</p>
          <div className="flex items-start gap-4">
            <div className="flex flex-col items-center justify-center rounded-lg bg-gold/10 px-4 py-3 min-w-[72px]">
              <span className="text-xl font-bold text-gold">{formatTime(next.start_time)}</span>
              <span className="text-xs text-gold/60 mt-0.5">{next.duration_min}m</span>
            </div>
            <div className="flex-1">
              <p className="text-base font-semibold text-white">{next.customer_name}</p>
              <p className="text-sm text-white/60 mt-0.5">{next.service_name}</p>
              {next.notes && <p className="text-xs text-white/40 mt-1 italic">{next.notes}</p>}
            </div>
            <div className="text-right">
              {minsUntilNext !== null && minsUntilNext > 0 && (
                <div className="flex items-center gap-1.5 text-sm text-white/50">
                  <Clock className="h-3.5 w-3.5" />
                  in {minsUntilNext < 60
                    ? `${minsUntilNext}m`
                    : `${Math.floor(minsUntilNext / 60)}h ${minsUntilNext % 60}m`}
                </div>
              )}
              {minsUntilNext !== null && minsUntilNext <= 0 && (
                <Badge variant="gold">Now</Badge>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-white/10 p-8 text-center">
          <p className="text-white/30 text-sm">No more appointments today.</p>
        </div>
      )}

      {/* Today's schedule */}
      {upcoming.length > 0 && (
        <div>
          <h2 className="font-heading text-base font-semibold text-white mb-3">
            Today&apos;s schedule
            <span className="ml-2 text-xs font-normal text-white/40">
              {upcoming.length} remaining · {completed.length} done
            </span>
          </h2>
          <div className="space-y-2">
            {upcoming.map((b, i) => (
              <div key={b.id}
                className={`flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors ${
                  i === 0
                    ? "border-gold/20 bg-gold/5"
                    : "border-white/8 bg-dark-100 hover:border-white/15"
                }`}>
                <div className="w-14 shrink-0 text-center">
                  <p className="text-sm font-semibold text-white">{formatTime(b.start_time)}</p>
                  <p className="text-xs text-white/35">{b.duration_min}m</p>
                </div>
                <div className="h-8 w-px bg-white/10 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{b.customer_name}</p>
                  <p className="text-xs text-white/50 truncate">{b.service_name}</p>
                </div>
                <Badge variant={b.status === "in_progress" ? "gold" : b.status === "confirmed" ? "outline" : "default"}>
                  {b.status.replace("_"," ")}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed (collapsible) */}
      {completed.length > 0 && (
        <details>
          <summary className="flex cursor-pointer items-center gap-2 py-1 text-xs text-white/30 hover:text-white/50 list-none">
            <CheckCircle className="h-3.5 w-3.5" />
            {completed.length} completed
          </summary>
          <div className="mt-2 space-y-2">
            {completed.map(b => (
              <div key={b.id} className="flex items-center gap-4 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 opacity-55">
                <div className="w-14 shrink-0 text-center">
                  <p className="text-sm text-white/60">{formatTime(b.start_time)}</p>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/60 truncate">{b.customer_name}</p>
                  <p className="text-xs text-white/35 truncate">{b.service_name}</p>
                </div>
                <Badge variant="success">done</Badge>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
