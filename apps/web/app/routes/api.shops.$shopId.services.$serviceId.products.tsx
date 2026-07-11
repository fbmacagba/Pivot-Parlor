/**
 * Resource route: back-bar BOM for one service (WS-3 Phase 2).
 * GET  → the service's product list (proxied; auth enforced downstream).
 * POST → replaces the list (form field "products" = JSON [{product_id, quantity}]).
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });

  const api = createApiClient(env.API_URL, token);
  try {
    const data = await api.get<unknown[]>(
      `/api/shops/${params.shopId}/services/${params.serviceId}/products`
    );
    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Lookup failed" }, { status: 400 });
  }
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  let products: unknown;
  try {
    products = JSON.parse(String(form.get("products") ?? "[]"));
  } catch {
    return json({ success: false, error: "Invalid products payload" }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, token);
  try {
    const data = await api.put<unknown[]>(
      `/api/shops/${params.shopId}/services/${params.serviceId}/products`,
      { products }
    );
    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : "Save failed" }, { status: 400 });
  }
}
