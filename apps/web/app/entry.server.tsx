import type { AppLoadContext, EntryContext } from "@remix-run/cloudflare";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { CspNonceContext } from "./lib/cspNonce";
import type { WebLoadContext } from "./lib/loadContext";
import { reportServerError, type ReportingContext } from "./lib/serverErrors";

// Loader, action and render errors reach the owner's alert email (app/lib/serverErrors.ts).
export { handleError } from "./lib/serverErrors";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
  loadContext: AppLoadContext
) {
  // The router types the load context as an open record; app/lib/loadContext.ts builds it.
  const { env, waitUntil, cspNonce } = loadContext as ReportingContext & Pick<WebLoadContext, "cspNonce">;
  // The request's nonce (functions/_middleware.ts) goes on every inline script
  // this render writes: Remix's (root.tsx reads the context) and React's own.
  const body = await renderToReadableStream(
    <CspNonceContext.Provider value={cspNonce}>
      <RemixServer context={remixContext} url={request.url} nonce={cspNonce} />
    </CspNonceContext.Provider>,
    {
      nonce: cspNonce,
      signal: request.signal,
      onError(error: unknown) {
        reportServerError(error, { request, env, waitUntil, where: "render" });
        responseStatusCode = 500;
      },
    }
  );

  if (isbot(request.headers.get("user-agent") ?? "")) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}
