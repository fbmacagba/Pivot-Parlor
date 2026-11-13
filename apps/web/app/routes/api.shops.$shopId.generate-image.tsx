import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";
import { readFormData } from "~/lib/formBody";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ error: "Missing shop id" }, 400);
  const token = getSessionToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const env = context.env as { API_URL: string };

  const ct = request.headers.get("Content-Type") || "";
  let forwardBody: string;
  if (/\bapplication\/json\b/i.test(ct)) {
    forwardBody = (await request.text()) || "{}";
  } else if (/\bapplication\/x-www-form-urlencoded\b/i.test(ct)) {
    const sp = new URLSearchParams(await request.text());
    const o: Record<string, string> = {};
    for (const [k, v] of sp) o[k] = v;
    forwardBody = JSON.stringify(o);
  } else {
    // Anything that is not a readable form goes on as {}: the API answers it
    // with its own 400 ("Empty request body ...").
    const fd = await readFormData(request);
    const o: Record<string, string> = {};
    for (const [k, v] of fd?.entries() ?? []) {
      if (typeof v === "string") o[k] = v;
    }
    forwardBody = JSON.stringify(o);
  }

  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/generate-image`, {
    method: "POST",
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      "Content-Type": "application/json",
    },
    body: forwardBody,
  });
  if (!workerResponseLooksLikeJson(res)) return json({ error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}
