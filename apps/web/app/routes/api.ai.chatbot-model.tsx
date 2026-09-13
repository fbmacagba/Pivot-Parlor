import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

/** Proxy for the platform chatbot model: GET reads it, POST { model_id } saves it. */
async function proxy(request: Request, context: LoaderFunctionArgs["context"], method: "GET" | "POST") {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);
  const env = context.env as { API_URL: string };

  const res = await fetch(`${env.API_URL}/api/ai/chatbot-model`, {
    method,
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: (await request.text()) || "{}" } : {}),
  });
  if (!workerResponseLooksLikeJson(res)) return json({ success: false, error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}

export const loader = ({ request, context }: LoaderFunctionArgs) => proxy(request, context, "GET");
export const action = ({ request, context }: ActionFunctionArgs) => proxy(request, context, "POST");
