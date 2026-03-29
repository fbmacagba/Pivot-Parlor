// apps/web/app/routes/api.shops.$shopId.reviews.tsx
// Proxies review submission from browser → worker (no auth required)

import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { shopId } = params;
  if (!shopId) return json({ success: false, error: "Missing shopId" }, 400);

  const env = context.env as { API_URL: string };
  const body = await request.json();

  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return json(data, { status: res.status });
}

export default function ApiShopReviews() {
  return null;
}
