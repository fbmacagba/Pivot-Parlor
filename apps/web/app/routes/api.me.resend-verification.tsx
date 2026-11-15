// apps/web/app/routes/api.me.resend-verification.tsx
// Proxies the verify-email resend for the signed-in customer (session cookie → Bearer).

import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { getSessionToken } from "~/lib/auth";

export async function action({ request, context }: ActionFunctionArgs) {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  const env = context.env as { API_URL: string };
  const res = await fetch(`${env.API_URL}/auth/resend-verification`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { success: false, error: text || "Upstream service error" };
  }
  return json(data, { status: res.status });
}
