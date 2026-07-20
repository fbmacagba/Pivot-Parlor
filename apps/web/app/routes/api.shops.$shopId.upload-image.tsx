import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ error: "Missing shop id" }, 400);
  const token = getSessionToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const ct = request.headers.get("Content-Type");
  if (!ct?.toLowerCase().includes("multipart/")) {
    return json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const env = context.env as { API_URL: string };
  const buf = await request.arrayBuffer();
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/upload-image`, {
    method: "POST",
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      "Content-Type": ct,
    },
    body: buf,
  });
  if (!workerResponseLooksLikeJson(res)) return json({ error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}
