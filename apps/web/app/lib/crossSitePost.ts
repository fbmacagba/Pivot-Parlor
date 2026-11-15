// A post from another website. React Router 7 refuses one sent to a page (no
// allowedActionOrigins is set), but checks pages only: a cross-site post to an
// action with no page (a resource route, such as /logout) ran, so any site
// could sign a visitor out. functions/_middleware.ts applies this rule to every
// route, before the router. serverErrors.ts uses it to recognise the router's
// own refusals, which then never reach the error reports.

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * True for a POST, PUT, PATCH or DELETE whose Origin header is present and is
 * not the request's own origin. "null", an empty value and anything that is not
 * a URL count as another site. No Origin is let through, as React Router does:
 * browsers send one on every post, and other clients can call the API directly.
 */
export function isCrossSitePost(request: Request): boolean {
  if (!MUTATIONS.has(request.method)) return false;
  const origin = request.headers.get("Origin");
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

/** The answer to a cross-site post: nothing ran. */
export function crossSitePostRefusal(): Response {
  return new Response("Forbidden: this request came from another website.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
