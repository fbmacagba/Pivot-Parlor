import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import type { Booking, BookingStatus } from "@repo/types";

const STATUS_BADGE: Record<BookingStatus, "warning" | "success" | "error" | "outline" | "gold" | "default"> = {
  pending: "warning",
  confirmed: "gold",
  in_progress: "gold",
  completed: "success",
  cancelled: "error",
  no_show: "default",
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  let bookings: Booking[] = [];
  try { bookings = await api.get("/api/bookings"); } catch { /* empty */ }
  return json({ bookings });
}

export default function AdminBookings() {
  const { bookings } = useLoaderData<typeof loader>();

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">Bookings</h1>
      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {["Customer", "Service", "Date/Time", "Status", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {bookings.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-white/40">No bookings found.</td></tr>
            ) : (
              bookings.map((b) => (
                <tr key={b.id} className="hover:bg-white/2">
                  <td className="px-4 py-3 text-white">{b.customerId}</td>
                  <td className="px-4 py-3 text-white/60">{b.serviceId}</td>
                  <td className="px-4 py-3 text-white/60 text-xs font-mono">{b.startTime}</td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_BADGE[b.status]}>{b.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="sm">Manage</Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
