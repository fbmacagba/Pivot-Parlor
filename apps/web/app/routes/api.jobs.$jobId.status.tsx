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

  const res = await fetch(`${env.API_URL}/api/jobs/${jobId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as unknown;
  return json(body, { status: res.status });
}

export default function JobStatusApi() {
  return null;
}
