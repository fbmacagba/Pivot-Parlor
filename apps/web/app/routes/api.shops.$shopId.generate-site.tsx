import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import type { DevGenerationPrefs } from "./dev.shops.$shopId";
import {
  buildWorkerUpstreamHeaders,
  workerResponseLooksLikeJson,
} from "~/lib/worker-upstream-headers";

/**
 * POST from Remix (form or JSON):
 * - Form `_action=regenerate-site`: same session + API pattern as dev.shops.$shopId._index — loads prefs via Worker, then POSTs generate-site to Worker. Returns JSON `{ ok, jobId, shopId }` so `useFetcher` callers can `navigate` (fetcher actions do not perform a document redirect).
 * - `application/json`: proxy to Worker (for programmatic callers).
 */
export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId;
  if (!shopId) return json({ success: false, error: "Missing shop id" }, 400);

  const ct = request.headers.get("Content-Type") || "";
  const isForm =
    ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data");

  if (isForm) {
    const form = await request.formData();
    if (form.get("_action") !== "regenerate-site") {
      return json({ ok: false, error: "Unknown action", shopId }, 400);
    }

    const env = context.env as { API_URL: string };
    const token = getSessionToken(request);
    if (!token) return json({ ok: false, error: "Unauthorized", shopId }, 401);

    const api = createApiClient(
      env.API_URL,
      token,
      apiE2eHeadersFromCookieHeader(request.headers.get("Cookie"))
    );

    let prefs: DevGenerationPrefs;
    try {
      prefs = await api.get<DevGenerationPrefs>(`/api/shops/${shopId}/generation-prefs`);
    } catch {
      prefs = {
        template: "minimal",
        design_notes: null,
        color_primary: null,
        color_accent: null,
      };
    }

    const designNotesFromForm = form.get("design_notes")?.toString() ?? "";
    const textModelFromForm = form.get("text_model")?.toString()?.trim();
    const imageModelFromForm = form.get("image_model")?.toString()?.trim();

    const body: Record<string, unknown> = {
      template: prefs.template?.trim() || "minimal",
      design_notes: designNotesFromForm,
    };
    if (prefs.color_primary?.trim()) body.color_primary = prefs.color_primary.trim();
    if (prefs.color_accent?.trim()) body.color_accent = prefs.color_accent.trim();
    if (textModelFromForm) body.text_model = textModelFromForm;
    if (imageModelFromForm) body.image_model = imageModelFromForm;

    try {
      const result = await api.post<{ jobId: string }>(`/api/shops/${shopId}/generate-site`, body);
      return json({ ok: true as const, jobId: result.jobId, shopId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Site generation failed";
      return json({ ok: false, error: msg, shopId }, 400);
    }
  }

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token && !request.headers.get("Authorization")) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  let bodyJson: unknown = {};
  if (ct.includes("application/json")) {
    try {
      bodyJson = await request.json();
    } catch {
      bodyJson = {};
    }
  }

  const headers: Record<string, string> = {
    ...buildWorkerUpstreamHeaders(request, token),
    "Content-Type": "application/json",
  };
  const res = await fetch(`${env.API_URL}/api/shops/${shopId}/generate-site`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyJson),
  });
  if (!res.ok || !workerResponseLooksLikeJson(res)) {
    return json({ error: "API request failed", status: res.status }, { status: res.status });
  }
  const body = (await res.json()) as unknown;
  return json(body, { status: res.status });
}
