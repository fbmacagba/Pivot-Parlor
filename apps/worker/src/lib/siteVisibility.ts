/**
 * Who may read a shop's generated site. The public may read it only once it
 * is live; before that (draft) or while it is taken down (paused), only a
 * developer or the shop's own admin may, for the developer preview and
 * onboarding. Shared by GET /api/shops/:shopId/site and the public services
 * list, which carries the site's generated copy.
 */
import type { Bindings } from "../bindings.js";
import { optionalSessionUser } from "../middleware/auth.js";

/** "live" is the only state in which the public may read a generated site. */
export function isLiveSite(site: { website_status?: string | null }): boolean {
  return (site.website_status ?? "draft").toLowerCase() === "live";
}

/**
 * Whether the request's session may read a site that is not live. `shopId`
 * must be the RESOLVED shop id: the route parameter may be a slug, and an
 * admin's session names their shop by id.
 */
export async function canReadUnpublishedSite(
  c: { env: Bindings; req: { raw: Request } },
  shopId: string,
): Promise<boolean> {
  const user = await optionalSessionUser(c);
  if (!user) return false;
  return user.role === "developer" || (user.role === "admin" && user.shop_id === shopId);
}
