import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";

/**
 * Headers for server-side fetch() to the Worker API: forwards browser Cookie (e.g. Cloudflare Access)
 * and Authorization when present, otherwise uses the Remix session JWT as Bearer.
 */
export function buildWorkerUpstreamHeaders(
  request: Request,
  sessionBearer: string | null
): Record<string, string> {
  const out: Record<string, string> = {};
  const cookie = request.headers.get("Cookie");
  if (cookie) out.Cookie = cookie;
  const incomingAuth = request.headers.get("Authorization");
  if (incomingAuth) out.Authorization = incomingAuth;
  else if (sessionBearer) out.Authorization = `Bearer ${sessionBearer}`;
  Object.assign(out, apiE2eHeadersFromCookieHeader(cookie));
  return out;
}

export function workerResponseLooksLikeJson(res: Response): boolean {
  const ct = res.headers.get("Content-Type") || "";
  return ct.includes("application/json");
}
