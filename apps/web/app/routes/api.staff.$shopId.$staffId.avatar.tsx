// apps/web/app/routes/api.staff.$shopId.$staffId.avatar.tsx
// Proxies multipart avatar upload from browser → Hono worker

import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const { shopId, staffId } = params;
  if (!shopId || !staffId) return json({ success: false, error: "Missing params" }, 400);

  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  const env = context.env as { API_URL: string };

  // Forward the multipart body as-is
  const formData = await request.formData();
  const res = await fetch(
    `${env.API_URL}/api/shops/${shopId}/staff/${staffId}/avatar`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    }
  );

  const data = await res.json();
  return json(data, { status: res.status });
}
