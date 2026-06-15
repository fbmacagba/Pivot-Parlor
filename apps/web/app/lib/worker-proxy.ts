import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

/**
 * Proxy a simple authenticated shop action (POST + JSON body) to the Worker,
 * forwarding the Worker's `{ success, data, error }` envelope and status code
 * verbatim — unlike `createApiClient`, which unwraps the envelope.
 *
 * Shared by the uniform `api.shops.$shopId.*` passthrough routes
 * (activate, pause, settings, save-image). Routes with custom needs
 * (multipart upload-image, delete's POST→DELETE fallback, the generation-prefs
 * GET loader, generate-image/generate-site content negotiation) keep their own
 * handlers — do not force them through this helper.
 *
 * @param segment   the path segment under `/api/shops/:shopId/` (e.g. "activate")
 * @param forwardBody when true, forward the request body (falling back to "{}");
 *                    when false, send "{}" (for actions that take no input)
 */
export async function proxyShopPost(
  { request, params, context }: ActionFunctionArgs,
  segment: string,
  opts: { forwardBody?: boolean } = {}
) {
  const shopId = params.shopId;
  if (!shopId) return json({ error: "Missing shop id" }, 400);
  const token = getSessionToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const env = context.env as { API_URL: string };
  const body = opts.forwardBody ? (await request.text()) || "{}" : "{}";
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/${segment}`, {
    method: "POST",
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      "Content-Type": "application/json",
    },
    body,
  });
  if (!workerResponseLooksLikeJson(res)) return json({ error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}
