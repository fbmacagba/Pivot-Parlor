// Proxy route for admin queue polling: keeps the auth token server-side.
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { pageShopId } from "~/lib/pageShop";

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  // An admin polls their own shop; a developer the shop in this URL.
  const shopId = pageShopId(request, user, params.shopId ?? null);
  if (!shopId) return json({ data: [] });
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  try {
    const data = await api.get(`/api/shops/${shopId}/walkin`);
    return json({ data });
  } catch {
    return json({ data: [] });
  }
}
