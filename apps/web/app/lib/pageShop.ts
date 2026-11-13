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

/** A staff dashboard destination, which takes a developer's ?shopId= and ?staffId=. */
export function isStaffHref(href: string): boolean {
  return href === "/staff" || href.startsWith("/staff/") || href.startsWith("/staff?");
}

/**
 * Whose staff screens a developer is viewing: the URL's ?staffId=. Staff
 * View is one person's own day, and a developer is nobody's staff, so they
 * name the person. Staff and admins always see their own (null here).
 */
export function pageStaffId(request: Request, user: Pick<SessionPayload, "role">): string | null {
  if (user.role !== "developer") return null;
  return plainId(new URL(request.url).searchParams.get("staffId"));
}

/** Why a developer's write on a staff screen is refused: Staff View is read-only for them. */
export const DEVELOPER_STAFF_READ_ONLY = "Developers can view staff screens but not act for staff.";

/** A /api/staff/me/* path for the staff member a developer is viewing (unchanged when none). */
export function staffMePath(path: string, staffId: string | null | undefined): string {
  const id = plainId(staffId);
  if (!id) return path;
  return `${path}${path.includes("?") ? "&" : "?"}staffId=${encodeURIComponent(id)}`;
}

/**
 * A dashboard link that keeps what a developer is looking at: the shop on
 * admin and staff destinations, and the staff member on staff ones. Other
 * destinations are left alone. Carrying the values for anyone is harmless:
 * the server applies them only for a developer.
 */
export function dashboardHref(
  href: string,
  view: { shopId?: string | null; staffId?: string | null },
): string {
  if (isAdminHref(href)) return withShopId(href, view.shopId);
  if (!isStaffHref(href)) return href;
  const withShop = withShopId(href, view.shopId);
  const staffId = plainId(view.staffId);
  if (!staffId) return withShop;
  const url = new URL(withShop, "http://x");
  url.searchParams.set("staffId", staffId);
  return `${url.pathname}${url.search}${url.hash}`;
}
