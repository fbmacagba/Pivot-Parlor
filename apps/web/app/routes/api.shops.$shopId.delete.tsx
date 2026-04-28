import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

/** Proxies developer shop delete to the Worker (POST …/delete matches /activate pattern). */
export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, 400);
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });
  const env = context.env as { API_URL: string };
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/delete`, {
    method: "POST",
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!workerResponseLooksLikeJson(res)) {
    return json({ success: false, error: "Bad gateway" }, { status: 502 });
  }
  return json(await res.json(), { status: res.status });
}

export default function ApiShopDelete() {
  return null;
}
