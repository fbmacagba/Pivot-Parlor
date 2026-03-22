import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";

/** Proxy generate-site POST to Worker (browser uses same-origin /api with session cookie). */
export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, 400);

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  let bodyJson: unknown = {};
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    try {
      bodyJson = await request.json();
    } catch {
      bodyJson = {};
    }
  }

  const cookie = request.headers.get("Cookie");
  const extra = apiE2eHeadersFromCookieHeader(cookie);
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/generate-site`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: JSON.stringify(bodyJson),
  });
  const body = (await res.json()) as unknown;
  return json(body, { status: res.status });
}

export default function GenerateSiteApi() {
  return null;
}
