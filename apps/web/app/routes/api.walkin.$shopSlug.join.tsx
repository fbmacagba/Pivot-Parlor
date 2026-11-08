// Proxies a customer joining a shop's walk-in queue (public, no auth).
// The walk-in page used to call the production API host straight from the
// browser, so a staging or preview site joined the PRODUCTION queue. Going
// through the site's own server uses env.API_URL for every environment, and the
// API still sees the customer's IP (see app/lib/apiTransport.ts).
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { shopSlug } = params;
  if (!shopSlug) return json({ success: false, error: "Missing shop" }, 400);
  if (request.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  const env = context.env as { API_URL: string };
  const res = await fetch(`${env.API_URL}/api/walkin/${encodeURIComponent(shopSlug)}/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: (await request.text()) || "{}",
  });
  if (!workerResponseLooksLikeJson(res)) {
    return json({ success: false, error: "The queue is unavailable right now. Please try again." }, 502);
  }
  return json(await res.json(), { status: res.status });
}
