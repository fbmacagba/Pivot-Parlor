import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

/**
 * Proxies developer shop delete to the Worker.
 * Prefer POST …/delete (matches /activate BFF pattern); if the worker returns 404 { error: "Not found" }
 * (Hono notFound — e.g. older deploy missing POST …/delete), fall back to DELETE /api/shops/:shopId.
 */
export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, { status: 400 });
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });
  const env = context.env as { API_URL: string };
  const seg = encodeURIComponent(shopId);
  const base = `${env.API_URL}/api/shops/${seg}`;
  const authHeaders = buildWorkerUpstreamHeaders(request, token);

  let res = await fetch(`${base}/delete`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: "{}",
  });

  if (workerResponseLooksLikeJson(res) && res.status === 404) {
    const probe = (await res.clone().json()) as { error?: string };
    if (probe.error === "Not found") {
      res = await fetch(base, { method: "DELETE", headers: authHeaders });
    }
  }

  if (!workerResponseLooksLikeJson(res)) {
    return json({ success: false, error: "Bad gateway" }, { status: 502 });
  }
  const payload = (await res.json()) as { success?: boolean; error?: string };
  return json(payload, { status: res.status });
}

export default function ApiShopDelete() {
  return null;
}
