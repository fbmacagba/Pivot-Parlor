import { useLocation } from "@remix-run/react";
import { isAdminHref, withShopId } from "~/lib/pageShop";

/**
 * For links rendered inside the dashboard: carries the current page's
 * ?shopId= onto admin destinations, so a developer stays on the shop they
 * opened. The server decides whether it applies (only for developers), so
 * carrying it for anyone is harmless.
 */
export function useShopHref(): (href: string) => string {
  const { search } = useLocation();
  const shopId = new URLSearchParams(search ?? "").get("shopId");
  return (href) => (isAdminHref(href) ? withShopId(href, shopId) : href);
}
