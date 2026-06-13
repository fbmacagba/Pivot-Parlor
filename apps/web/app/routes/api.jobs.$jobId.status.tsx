import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";

/** Proxy job status from Worker (HttpOnly cookie cannot be read by client-side poll). */
export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const jobId = params.jobId;
  if (!jobId) return json({ success: false, error: "Missing job id" }, 400);

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);

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
    return json(body, { status: res.status });
  } catch {
    return json({ success: false, error: "Job status service is unavailable" }, 502);
  }
}

export default function JobStatusApi() {
  return null;
}
