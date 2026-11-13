import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";

/**
 * BFF for the owner-review card (SiteCandidateCard): the pending version of a
 * regenerated live site. The Worker decides who may see or change it (a
 * developer, or the shop's own admin); this route only forwards the session.
 *
 *   GET            -> a summary of the pending version (the preview page reads
 *                     the full version itself, at /:slug?preview=candidate)
 *   POST publish   -> make it the public site
 *   POST discard   -> drop it; the public site is unchanged
 */

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type SiteCandidateSummary = {
  job_id: string;
  created_at: string;
  services_unchanged: boolean;
  headline: string | null;
};

type Envelope<T> = { success?: boolean; data?: T; error?: string };

function failure(error: string, status: number) {
  return json({ success: false as const, error }, { status, headers: NO_STORE });
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return failure("Missing shop id", 400);
  const token = getSessionToken(request);
  if (!token) return failure("Unauthorized", 401);
  const env = context.env as { API_URL: string };
  // Only one failure is worth showing on a dashboard: a version exists but
  // cannot be shown (409). Everything else (nothing waiting, not allowed, an
  // API without this route mid-deploy, an outage) renders no card at all,
  // the same way the shop page's preview falls back to the public site. It is
  // answered 200 so the browser logs no failed request on every dashboard view.
  const silent = () =>
    json({ success: false as const, none: true as const, error: "No new version to show" }, { headers: NO_STORE });
  try {
    const res = await fetch(`${env.API_URL}/api/shops/${encodeURIComponent(shopId)}/site-candidate`, {
      headers: buildWorkerUpstreamHeaders(request, token),
    });
    if (!workerResponseLooksLikeJson(res)) return silent();
    const body = (await res.json()) as Envelope<{
      job_id?: string;
      created_at?: string;
      services_unchanged?: boolean;
      site?: { headline?: string | null };
    }>;
    if (res.status === 409) {
      return failure(body.error ?? "A new version is waiting but cannot be shown. Regenerate the site.", 409);
    }
    if (!res.ok || !body.success || !body.data?.job_id) return silent();
    const summary: SiteCandidateSummary = {
      job_id: body.data.job_id,
      created_at: body.data.created_at ?? "",
      services_unchanged: body.data.services_unchanged !== false,
      headline: body.data.site?.headline ?? null,
    };
    return json({ success: true as const, data: summary }, { headers: NO_STORE });
  } catch {
    return silent();
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return failure("Missing shop id", 400);
  const token = getSessionToken(request);
  if (!token) return failure("Unauthorized", 401);
  const env = context.env as { API_URL: string };

  const form = await readFormData(request);
  if (!form) return failure(UNREADABLE_FORM, 400);
  const intent = String(form.get("intent") ?? "");
  const jobId = String(form.get("job_id") ?? "").trim();
  if (intent !== "publish" && intent !== "discard") return failure("Unknown action", 400);
  if (!jobId) return failure("Missing version id", 400);

  const base = `${env.API_URL}/api/shops/${encodeURIComponent(shopId)}/site-candidate`;
  const headers = buildWorkerUpstreamHeaders(request, token);
  try {
    const res =
      intent === "publish"
        ? await fetch(`${base}/publish`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ job_id: jobId }),
          })
        : await fetch(`${base}?job_id=${encodeURIComponent(jobId)}`, { method: "DELETE", headers });
    if (!workerResponseLooksLikeJson(res)) return failure("The site service returned an unexpected response.", 502);
    const body = (await res.json()) as Envelope<unknown>;
    if (!res.ok || !body.success) {
      return failure(body.error ?? "That did not work. Refresh and try again.", res.ok ? 500 : res.status);
    }
    return json({ success: true as const, intent }, { headers: NO_STORE });
  } catch {
    return failure("The site service is unavailable. Try again in a moment.", 502);
  }
}
