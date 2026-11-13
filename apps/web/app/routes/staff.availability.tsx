// Availability is now part of /staff/bookings (tab=availability)
// This file redirects for any direct hits to /staff/availability, keeping the
// query string (a developer's ?shopId= and ?staffId=, staff.tsx).
import { redirect } from "@remix-run/cloudflare";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";

export function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  params.set("tab", "availability");
  return redirect(`/staff/bookings?${params}`);
}
