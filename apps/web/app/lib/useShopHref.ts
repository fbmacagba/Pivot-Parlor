import { useLocation } from "@remix-run/react";
import { dashboardHref } from "~/lib/pageShop";

/**
 * For links rendered inside the dashboard: carries the current page's
 * ?shopId= onto admin and staff destinations, and ?staffId= onto staff ones,
 * so a developer stays on the shop and the person they opened. The server
 * decides whether they apply (only for developers), so carrying them for
 * anyone is harmless.
 */
export function useShopHref(): (href: string) => string {
  const { search } = useLocation();
  const params = new URLSearchParams(search ?? "");
  const view = { shopId: params.get("shopId"), staffId: params.get("staffId") };
  return (href) => dashboardHref(href, view);
}
