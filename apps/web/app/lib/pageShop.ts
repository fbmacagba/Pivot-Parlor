/**
 * Which shop a dashboard page is for.
 *
 * An admin (or staff member) always works on their own shop: a ?shopId= in
 * the URL or a shopId form field is ignored. A developer has no shop of their
 * own, so they say which one with ?shopId= (or a shopId form field, which
 * wins). Form posts with no explicit action keep the page's query string, so
 * a developer's actions reach the same shop as the page.
 *
 * The value goes into API paths, so anything but a plain id is refused.
 */
import type { SessionPayload } from "~/lib/auth";

const SHOP_ID = /^[A-Za-z0-9_-]{1,100}$/;

function plainId(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && SHOP_ID.test(v) ? v : null;
}

export function pageShopId(
  request: Request,
  user: Pick<SessionPayload, "role" | "shop_id">,
  formShopId?: string | null,
): string | null {
  if (user.role !== "developer") return user.shop_id?.trim() || null;
  const fromQuery = new URL(request.url).searchParams.get("shopId");
  return plainId(formShopId) ?? plainId(fromQuery);
}

/** `href` with `?shopId=` set, so a developer's links stay on the same shop. */
export function withShopId(href: string, shopId: string | null | undefined): string {
  const id = plainId(shopId);
  if (!id) return href;
  const url = new URL(href, "http://x");
  url.searchParams.set("shopId", id);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An admin dashboard destination, which takes a developer's ?shopId=. */
export function isAdminHref(href: string): boolean {
  return href === "/admin" || href.startsWith("/admin/") || href.startsWith("/admin?");
}
