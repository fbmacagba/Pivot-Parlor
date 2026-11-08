// Proxies a customer's walk-in queue status poll (public, no auth), so the
// walk-in page talks to its own site's API for every environment. See
// api.walkin.$shopSlug.join.tsx.
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

export async function loader({ params, context }: LoaderFunctionArgs) {
  const { shopSlug, entryId } = params;
  if (!shopSlug || !entryId) return json({ success: false, error: "Missing shop or entry" }, 400);

  const env = context.env as { API_URL: string };
  const res = await fetch(
    `${env.API_URL}/api/walkin/${encodeURIComponent(shopSlug)}/status/${encodeURIComponent(entryId)}`
  );
  if (!workerResponseLooksLikeJson(res)) {
    return json({ success: false, error: "The queue is unavailable right now." }, 502);
  }
  return json(await res.json(), { status: res.status, headers: { "Cache-Control": "no-store" } });
}
