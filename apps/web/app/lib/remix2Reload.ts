/** Tabs still running the Remix 2 client after React Router 7 deploys.
 *
 *  Remix 2 asks for page data with `?_data=<route id>`. React Router 7 never
 *  sends `_data`, and it reads such a request as a document request: an old
 *  tab's form post would run the action and get an HTML page back, which the
 *  old client shows as an error (on the till: a sale recorded, then a screen
 *  inviting a second one). Remix 2's client hard-reloads when a data answer
 *  carries `X-Remix-Redirect` with `X-Remix-Reload-Document`, so those requests
 *  get that answer instead, before the router runs anything, and the tab comes
 *  back on the new client.
 *
 *  Only page routes: a resource route ignores `_data` and answers JSON, which an
 *  old tab reads as it always did. Remove this once no Remix 2 tab can still be
 *  open (React Router 7 went live 2026-11-15; a till tab can stay open for days). */

/** The answer for a Remix 2 page data request, or null for every other request. */
export function remix2ReloadResponse(request: Request, pageRoutes: ReadonlySet<string>): Response | null {
  const url = new URL(request.url);
  const routeId = url.searchParams.get("_data");
  if (routeId === null || !pageRoutes.has(routeId)) return null;
  // A document navigation is never the old client's data call; let the router
  // render it rather than answer a page with nothing.
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") return null;
  return new Response(null, {
    status: 204,
    headers: {
      "X-Remix-Redirect": reloadTarget(request, url),
      "X-Remix-Reload-Document": "true",
      "X-Remix-Replace": "true",
      "Cache-Control": "no-store",
    },
  });
}

/** The page the visitor is on (the Referer, same site only), else the requested page. */
function reloadTarget(request: Request, url: URL): string {
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const from = new URL(referer);
      if (from.origin === url.origin) return pathOf(from);
    } catch {
      // Not a URL: fall back to the requested page.
    }
  }
  return pathOf(url);
}

function pathOf(url: URL): string {
  if (!url.searchParams.has("_data")) return url.pathname + url.search;
  const copy = new URL(url.href);
  copy.searchParams.delete("_data");
  return copy.pathname + copy.search;
}
