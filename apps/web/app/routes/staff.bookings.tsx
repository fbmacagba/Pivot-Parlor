import { useLoaderData, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  let bookings: never[] = [];
  try { bookings = await api.get("/api/staff/bookings"); } catch { /* empty */ }
  return json({ bookings });
}

export default function StaffBookings() {
  const { bookings } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") ?? "upcoming";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-white">My Bookings</h1>
        <div className="flex gap-2">
          {["upcoming", "past"].map((f) => (
            <button
              key={f}
              onClick={() => setParams({ filter: f })}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                filter === f ? "bg-gold/20 text-gold" : "text-white/50 hover:text-white"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-white/10 bg-dark-100 p-8 text-center text-white/40">
        {bookings.length === 0 ? "No bookings to show." : `${bookings.length} bookings`}
      </div>
    </div>
  );
}
