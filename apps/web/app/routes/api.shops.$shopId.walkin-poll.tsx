// Proxy route for admin queue polling — keeps auth token server-side
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  try {
    const data = await api.get(`/api/shops/${user.shop_id}/walkin`);
    return json({ data });
  } catch {
    return json({ data: [] });
  }
}
