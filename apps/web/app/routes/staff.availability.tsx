// Availability is now part of /staff/bookings (tab=availability)
// This file redirects for any direct hits to /staff/availability
import { redirect } from "@remix-run/cloudflare";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";

export function loader(args: LoaderFunctionArgs) {
  void args;
  return redirect("/staff/bookings?tab=availability");
}
