import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import {
  buildWorkerUpstreamHeaders,
  workerResponseLooksLikeJson,
} from "~/lib/worker-upstream-headers";

/** Proxy generation prefs from Worker (HttpOnly session cookie is not readable in the browser). */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, 400);

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token && !request.headers.get("Authorization")) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  const headers = buildWorkerUpstreamHeaders(request, token);
  try {
    const res = await fetch(`${env.API_URL}/api/shops/${shopId}/generation-prefs`, {
      headers,
    });
    if (!res.ok || !workerResponseLooksLikeJson(res)) {
      return json({ error: "API request failed", status: res.status }, { status: res.status });
    }
    const body = (await res.json()) as unknown;
    return json(body, { status: res.status });
  } catch {
    return json({ success: false, error: "Generation prefs service is unavailable" }, 502);
  }
}
