import { AsyncLocalStorage } from "node:async_hooks";
import { createPagesFunctionHandler } from "@remix-run/cloudflare-pages";
import type { ServerBuild } from "@remix-run/server-runtime";
import * as build from "../build/server/index.js";
import { CLIENT_IP_HEADER, createApiAwareFetch, originOf, type ApiRoute } from "../app/lib/apiTransport";
import { hasUnsafePathSegment } from "../app/lib/pathSafety";
import { withSecurityHeaders } from "../app/lib/securityHeaders";

interface Env {
  /** Service binding to the API worker (apps/web/wrangler.toml [[services]]). */
  API?: { fetch(request: Request): Promise<Response> };
  API_URL?: string;
}

// The route of the request each fetch belongs to. Requests run concurrently in
// one isolate, so this is per async context, not a module variable.
const apiRoute = new AsyncLocalStorage<ApiRoute>();

// Installed once per isolate. While a request is being served, any server-side
// fetch to env.API_URL goes over the API service binding carrying the visitor's
// IP; everything else is untouched. Why: app/lib/apiTransport.ts.
globalThis.fetch = createApiAwareFetch(globalThis.fetch.bind(globalThis), () => apiRoute.getStore());

const handleRequest = createPagesFunctionHandler({
  build: build as unknown as ServerBuild,
  /**
   * Expose Cloudflare environment bindings to Remix loaders/actions as
   * `context.env` so code like `context.env.API_URL` works.
   */
  getLoadContext(context) {
    return { env: context.env };
  },
});

// public/_headers covers static assets only; every response from here gets
// the security headers in code (app/lib/securityHeaders.ts).
export const onRequest: PagesFunction<Env> = async (context) => {
  // A path segment that decodes to a separator, a control character or
  // another encoding layer would become a route param that loaders put into
  // API URLs and links (app/lib/pathSafety.ts). No route takes one.
  if (hasUnsafePathSegment(new URL(context.request.url).pathname)) {
    return withSecurityHeaders(new Response("Not found", { status: 404 }));
  }
  return withSecurityHeaders(
    await apiRoute.run(
      {
        binding: context.env.API,
        origin: originOf(context.env.API_URL),
        clientIp: context.request.headers.get(CLIENT_IP_HEADER),
      },
      () => handleRequest(context)
    ),
    { apiOrigin: originOf(context.env.API_URL) }
  );
};
