import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, decodeToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { BookingTimeline, type TimelineBooking } from "~/components/dashboards/BookingTimeline";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const payload = token ? decodeToken(token) : null;
  const api = createApiClient(env.API_URL, token);

  let todayBookings: TimelineBooking[] = [];
  let nextBooking = null;
  try {
    todayBookings = await api.get("/api/staff/today");
    nextBooking = todayBookings[0] ?? null;
  } catch {
    // empty
  }

  return json({ userName: payload?.sub ?? "there", todayBookings, nextBooking });
}

export default function StaffToday() {
  const { userName, todayBookings } = useLoaderData<typeof loader>();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl font-bold text-white">
        {greeting}, <span className="text-gold">{userName}</span>
      </h1>
      <div>
        <h2 className="font-heading text-lg font-semibold text-white mb-4">Today&apos;s schedule</h2>
        <BookingTimeline bookings={todayBookings} />
      </div>
    </div>
  );
}
