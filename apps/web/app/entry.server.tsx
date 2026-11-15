import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { CspNonceContext } from "./lib/cspNonce";
import type { WebLoadContext } from "./lib/loadContext";
import { reportServerError, type ReportingContext } from "./lib/serverErrors";

// Loader, action and render errors reach the owner's alert email (app/lib/serverErrors.ts).
export { handleError } from "./lib/serverErrors";

// How long streamed (promise) loader data may take before the router settles it
// as an error. The render itself is aborted one second later, so a stuck stream
// never holds a Pages request open.
export const streamTimeout = 4_950;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext
) {
  // The router types the load context as an open record; app/lib/loadContext.ts builds it.
  const { env, waitUntil, cspNonce } = loadContext as ReportingContext & Pick<WebLoadContext, "cspNonce">;

  // Abort when the visitor goes away, or when the stream outlives streamTimeout.
  // Both stop watching once the render is over, including one that fails
  // before it streams anything.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("render timed out")), streamTimeout + 1_000);
  const onVisitorGone = () => abort.abort(request.signal.reason);
  if (request.signal.aborted) abort.abort(request.signal.reason);
  else request.signal.addEventListener("abort", onVisitorGone, { once: true });
  const done = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onVisitorGone);
  };

  // The request's nonce (functions/_middleware.ts) goes on every inline script
  // this render writes: the router's (root.tsx reads the context) and React's own.
  let body: Awaited<ReturnType<typeof renderToReadableStream>>;
  try {
    body = await renderToReadableStream(
      <CspNonceContext.Provider value={cspNonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={cspNonce} />
      </CspNonceContext.Provider>,
      {
        nonce: cspNonce,
        signal: abort.signal,
        onError(error: unknown) {
          reportServerError(error, { request, env, waitUntil, where: "render" });
          responseStatusCode = 500;
        },
      }
    );
  } catch (error) {
    done();
    throw error;
  }
  body.allReady.then(done, done);

  if (isbot(request.headers.get("user-agent") ?? "")) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}
