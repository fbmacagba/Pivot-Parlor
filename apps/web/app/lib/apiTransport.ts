/**
 * How the website's server code reaches the API.
 *
 * Loaders and actions call the API with plain `fetch(`${env.API_URL}...`)`. Sent
 * over the public internet, that is a cross-zone Worker subrequest, and
 * Cloudflare then sets `CF-Connecting-IP` to one fixed address
 * (2a06:98c0:3600::103) for every visitor. The API's per-IP rate limits and the
 * activity trail's IP therefore saw every website visitor as the same client:
 * one shared allowance of about 30 bookings an hour across all shops.
 *
 * The fix: a request aimed at the API goes over the `API` service binding
 * instead, carrying the `CF-Connecting-IP` of the request the website is
 * serving. Cloudflare's edge set that from the visitor's connection, so a
 * visitor cannot forge it. The API keeps reading `CF-Connecting-IP` exactly as
 * before, and a direct caller of the API's public URL still gets Cloudflare's
 * own value for that header.
 *
 * `functions/_middleware.ts` installs this as the global fetch, so the 70-odd
 * call sites need no change. Everything not aimed at the API passes through
 * untouched, request body included.
 */

/** The header the API's rate limiters and audit context read the client IP from. */
export const CLIENT_IP_HEADER = "CF-Connecting-IP";

export interface ApiRoute {
  /** The `API` service binding. Absent when the website runs without one. */
  binding?: { fetch(request: Request): Promise<Response> };
  /** Origin of `env.API_URL`, e.g. `https://api.pivotparlor.com`. Empty when unset. */
  origin: string;
  /** `CF-Connecting-IP` of the request the website is serving, or null. */
  clientIp: string | null;
}

/** The origin of an absolute URL, or "" when the value is not one. */
export function originOf(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// Read the URL without constructing a Request: building one from a streamed or
// FormData body would spend that body before the untouched path could send it.
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wraps `baseFetch` so a call aimed at the API origin goes over the service
 * binding with the visitor's IP. `currentRoute` returns the route of the request
 * being served, or undefined outside one (then nothing is rerouted).
 */
export function createApiAwareFetch(
  baseFetch: typeof fetch,
  currentRoute: () => ApiRoute | undefined,
  warn: (message: string) => void = (message) => console.warn(message)
): typeof fetch {
  let warned = false;
  return (input, init) => {
    const route = currentRoute();
    if (!route || !route.origin || originOf(urlOf(input)) !== route.origin) {
      return baseFetch(input, init);
    }
    if (!route.binding) {
      // Still works, but the API sees Cloudflare's shared address again. Say so
      // once per isolate rather than failing every page.
      if (!warned) {
        warned = true;
        warn(
          `[api-transport] no API service binding: calls to ${route.origin} go over the public internet, ` +
            "so the API sees one shared Cloudflare address instead of each visitor's IP"
        );
      }
      return baseFetch(input, init);
    }
    const request = new Request(input, init);
    // Never pass on a value the caller set; only the visitor's edge-set IP counts.
    if (route.clientIp) request.headers.set(CLIENT_IP_HEADER, route.clientIp);
    else request.headers.delete(CLIENT_IP_HEADER);
    return route.binding.fetch(request);
  };
}
