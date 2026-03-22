import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Calendar, DollarSign, Clock, Users } from "lucide-react";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { StatCard } from "~/components/dashboards/StatCard";
import { BookingTimeline, type TimelineBooking } from "~/components/dashboards/BookingTimeline";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let stats = { todays_bookings: 0, week_revenue: 0, active_staff: 0, waitlist_count: 0 };
  let todayBookings: TimelineBooking[] = [];
  try {
    // These endpoints are placeholders — replace with actual API calls
    stats = await api.get("/api/admin/stats");
  } catch {
    // use defaults
  }

  return json({ stats, todayBookings });
}

export default function AdminOverview() {
  const { stats, todayBookings } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-8">
      <h1 className="font-heading text-2xl font-bold text-white">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Today's bookings" value={stats.todays_bookings} icon={Calendar} />
        <StatCard label="This week revenue" value={`£${(stats.week_revenue ?? 0).toFixed(2)}`} icon={DollarSign} />
        <StatCard label="Active staff" value={stats.active_staff} icon={Users} />
        <StatCard label="Waitlist count" value={stats.waitlist_count} icon={Clock} />
      </div>
      <div>
        <h2 className="font-heading text-lg font-semibold text-white mb-4">Today&apos;s bookings</h2>
        <BookingTimeline bookings={todayBookings} />
      </div>
    </div>
  );
}
