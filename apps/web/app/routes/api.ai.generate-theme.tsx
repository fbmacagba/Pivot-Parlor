import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

export async function action({ request, context }: ActionFunctionArgs) {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);
  const env = context.env as { API_URL: string };

  const body = (await request.text()) || "{}";
  const res = await fetch(`${env.API_URL}/api/ai/generate-theme`, {
    method: "POST",
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      "Content-Type": "application/json",
    },
    body,
  });
  if (!workerResponseLooksLikeJson(res)) return json({ success: false, error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}
