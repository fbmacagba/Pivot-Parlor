import { AsyncLocalStorage } from "node:async_hooks";
import { createPagesFunctionHandler } from "@remix-run/cloudflare-pages";
import type { ServerBuild } from "@remix-run/server-runtime";
import * as build from "../build/server/index.js";
import { CLIENT_IP_HEADER, createApiAwareFetch, originOf, type ApiRoute } from "../app/lib/apiTransport";
import { CLIENT_ERRORS_PATH } from "../app/lib/browserErrors";
import { handleClientErrors, pageRouteIds, type BrowserErrorsBinding } from "../app/lib/clientErrorsEndpoint";
import { hasUnsafePathSegment } from "../app/lib/pathSafety";
import { newCspNonce, withSecurityHeaders } from "../app/lib/securityHeaders";
import { reportServerError, type WebErrorsBinding } from "../app/lib/serverErrors";

interface Env {
  /** Service binding to the API worker (apps/web/wrangler.toml [[services]]). */
  API?: { fetch(request: Request): Promise<Response> };
  API_URL?: string;
  /** The API's WebErrors entrypoint: server and browser errors reach the alert email. */
  WEB_ERRORS?: WebErrorsBinding & BrowserErrorsBinding;
}

// The routes a browser error can come from: the site's pages, never its
// resource routes (app/lib/clientErrorsEndpoint.ts).
const PAGE_ROUTES = pageRouteIds((build as unknown as ServerBuild).routes);

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
   * `context.env` so code like `context.env.API_URL` works, and waitUntil so
   * an error report outlives the response (app/lib/serverErrors.ts), and the
   * request's CSP nonce, which the render puts on its inline scripts
   * (entry.server.tsx).
   */
  getLoadContext(context) {
    return {
      env: context.env,
      waitUntil: (promise: Promise<unknown>) => context.waitUntil(promise),
      cspNonce: context.data.cspNonce as string | undefined,
    };
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
  // A visitor's browser reporting a JavaScript error: checked and passed on
  // here, before Remix (app/lib/clientErrorsEndpoint.ts). Always 204.
  if (context.request.method === "POST" && new URL(context.request.url).pathname === CLIENT_ERRORS_PATH) {
    return withSecurityHeaders(
      await handleClientErrors(context.request, {
        pageRoutes: PAGE_ROUTES,
        binding: context.env.WEB_ERRORS,
        waitUntil: (promise) => context.waitUntil(promise),
      })
    );
  }
  // One nonce per request, for this response's header and its inline scripts
  // (app/lib/securityHeaders.ts). The render reads it through getLoadContext.
  const nonce = newCspNonce();
  context.data.cspNonce = nonce;
  // Route errors reach Remix's handleError (entry.server.tsx). This catch is
  // for this file's own code; whatever fails inside Remix's Pages adapter
  // itself comes back as its bare "Internal Error" 500, not as a throw.
  try {
    return withSecurityHeaders(
      await apiRoute.run(
        {
          binding: context.env.API,
          origin: originOf(context.env.API_URL),
          clientIp: context.request.headers.get(CLIENT_IP_HEADER),
        },
        () => handleRequest(context)
      ),
      { apiOrigin: originOf(context.env.API_URL), nonce }
    );
  } catch (error) {
    reportServerError(error, {
      request: context.request,
      env: context.env,
      waitUntil: (promise) => context.waitUntil(promise),
      where: "middleware",
    });
    throw error;
  }
};
