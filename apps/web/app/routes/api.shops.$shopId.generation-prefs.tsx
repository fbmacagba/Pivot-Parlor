import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";

/** Proxy generation prefs from Worker (HttpOnly session cookie is not readable in the browser). */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, 400);

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  const cookie = request.headers.get("Cookie");
  const extra = apiE2eHeadersFromCookieHeader(cookie);
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/generation-prefs`, {
    headers: { Authorization: `Bearer ${token}`, ...extra },
  });
  const body = (await res.json()) as unknown;
  return json(body, { status: res.status });
}

export default function GenerationPrefsApi() {
  return null;
}
