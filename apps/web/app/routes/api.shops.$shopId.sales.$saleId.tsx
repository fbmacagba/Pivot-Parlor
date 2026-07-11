/**
 * Resource route: the POS screen polls a pending Stripe sale here until the
 * webhook settles it. Pure server-side proxy to the worker (which forwards
 * to the booking worker); auth enforced downstream via the session token.
 */
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });

  const api = createApiClient(env.API_URL, token);
  try {
    const data = await api.get<Record<string, unknown>>(
      `/api/shops/${params.shopId}/sales/${params.saleId}`
    );
    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Lookup failed" }, { status: 400 });
  }
}
