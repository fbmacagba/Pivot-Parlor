/**
 * Resource route: the evidence file attached to a refund request, opened from
 * the Refunds page. A server-side pass-through to the API, which checks the
 * session and that the request belongs to the shop; the file lives in a
 * private bucket and is never given a public address.
 */
import { data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { getSessionToken } from "~/lib/auth";

const ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401 });
  const { shopId, requestId } = params;
  if (!shopId || !requestId || !ID.test(shopId) || !ID.test(requestId)) {
    return json({ success: false, error: "Not found" }, { status: 404 });
  }

  const upstream = await fetch(`${env.API_URL}/api/shops/${shopId}/refund-requests/${requestId}/evidence`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!upstream.ok) {
    return json(
      { success: false, error: upstream.status === 404 ? "Not found" : "This file could not be opened." },
      { status: upstream.status === 404 || upstream.status === 403 || upstream.status === 401 ? upstream.status : 502 }
    );
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": upstream.headers.get("Content-Disposition") ?? "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
