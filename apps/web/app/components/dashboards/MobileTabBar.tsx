import { Link, useLocation } from "@remix-run/react";
import { Menu } from "lucide-react";
import { clsx } from "clsx";
import type { UserRole } from "@repo/types";
import { NAV_MAP, isNavActive, type NavItem } from "./Sidebar";

/** Admin destinations that earn a thumb-reach tab; the rest live behind More. */
const ADMIN_TAB_HREFS = ["/admin", "/admin/bookings", "/admin/queue", "/admin/pos"];

/** A phone tab bar stays readable up to five tabs (More counts as one). */
const MAX_TABS = 5;

export function mobileTabsFor(role: UserRole): { tabs: NavItem[]; more: boolean } {
  const all = NAV_MAP[role] ?? [];
  if (all.length <= MAX_TABS) return { tabs: all, more: false };
  const picked = ADMIN_TAB_HREFS.map((href) => all.find((item) => item.href === href)).filter(
    (item): item is NavItem => item !== undefined
  );
  return { tabs: picked.length > 0 ? picked : all.slice(0, MAX_TABS - 1), more: true };
}

const TAB_CLASS =
  "flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 text-[0.6875rem] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold";

/**
 * Thumb-reach navigation for phones: the role's primary destinations along
 * the bottom edge, safe-area aware, hidden from md up where the rail is
 * visible. Roles with more destinations than fit get a More tab that opens
 * the drawer with the full list, so nothing is hidden on a phone.
 */
export function MobileTabBar({
  role,
  onMore,
  moreOpen = false,
}: {
  role: UserRole;
  onMore: () => void;
  moreOpen?: boolean;
}) {
  const { pathname } = useLocation();
  const { tabs, more } = mobileTabsFor(role);
  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-dark/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <ul className="flex">
        {tabs.map(({ href, label, short, icon: Icon }) => {
          const active = isNavActive(href, pathname);
          return (
            <li key={href} className="min-w-0 flex-1">
              <Link
                to={href}
                aria-current={active ? "page" : undefined}
                className={clsx(TAB_CLASS, active ? "text-gold" : "text-white/60 hover:text-white")}
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="max-w-full truncate">{short ?? label}</span>
              </Link>
            </li>
          );
        })}
        {more && (
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onMore}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-controls="pp-dash-drawer"
              className={clsx(TAB_CLASS, "text-white/60 hover:text-white")}
            >
              <Menu className="h-5 w-5" aria-hidden />
              <span>More</span>
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
