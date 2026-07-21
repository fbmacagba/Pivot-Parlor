import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";

// A progress poll must never be cached: a stale "research"/"running" response
// served to a later poll would freeze the progress UI on an early step even
// after the job has completed.
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Proxy job status from Worker (HttpOnly cookie cannot be read by client-side poll). */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const jobId = params.jobId;
  if (!jobId) return json({ success: false, error: "Missing job id" }, { status: 400, headers: NO_STORE });

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  // This endpoint is polled client-side, so it must always return a JSON
  // envelope — a worker outage or non-JSON upstream must not surface as a
  // bare 500 that breaks the poller.
  try {
    const res = await fetch(`${env.API_URL}/api/jobs/${jobId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { success: false, error: "Upstream returned a non-JSON response" };
    }
    return json(body, { status: res.status, headers: NO_STORE });
  } catch {
    return json({ success: false, error: "Job status service is unavailable" }, { status: 502, headers: NO_STORE });
  }
}
