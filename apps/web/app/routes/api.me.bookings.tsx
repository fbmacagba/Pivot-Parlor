import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { readJsonObject } from "@repo/utils";
import { getSessionToken } from "~/lib/auth";

/** GET /api/me/bookings — proxy to worker (session cookie → Bearer). */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  const env = context.env as { API_URL: string };
  const res = await fetch(`${env.API_URL}/api/me/bookings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { success: false, error: text || "Upstream service error" };
  }
  return json(body, { status: res.status });
}

/** POST { intent: "cancel", bookingId } — customer cancel within worker rules. */
export async function action({ request, context }: ActionFunctionArgs) {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

  const body: { intent?: string; bookingId?: string } = (await readJsonObject(request)) ?? {};
  if (body.intent !== "cancel" || typeof body.bookingId !== "string" || !body.bookingId.trim()) {
    return json({ success: false, error: "Invalid request" }, 400);
  }

  const env = context.env as { API_URL: string };
  const res = await fetch(`${env.API_URL}/api/me/bookings/${encodeURIComponent(body.bookingId.trim())}/cancel`, {
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
