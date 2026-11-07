import { Link, useLocation, useNavigate } from "@remix-run/react";
import {
  BarChart2,
  BarChart3,
  Bot,
  Boxes,
  Calendar,
  Users2,
  CalendarDays,
  Clock,
  CreditCard,
  Image as ImageIcon,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Package,
  Receipt,
  Scissors,
  ScrollText,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Users,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import type { UserRole } from "@repo/types";

export interface NavItem {
  href: string;
  label: string;
  /** Shorter label for the phone tab bar, where a fifth-width tab cannot fit the full one. */
  short?: string;
  icon: React.ElementType;
}

const DEV_NAV: NavItem[] = [
  { href: "/dev", label: "Overview", icon: LayoutDashboard },
  { href: "/dev/shops", label: "Shops", icon: ShoppingBag },
  { href: "/dev/revenue", label: "Revenue", icon: BarChart3 },
  { href: "/dev/ai-deploy", label: "AI Deploy", icon: Bot },
  { href: "/dev/activity", label: "Activity", icon: ScrollText },
  { href: "/dev/enquiries", label: "Enquiries", icon: MessageSquare },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/staff", label: "Staff", icon: Users },
  { href: "/admin/services", label: "Services", icon: Scissors },
  { href: "/admin/visuals", label: "Visuals", icon: ImageIcon },
  { href: "/admin/products", label: "Products", icon: Package },
  { href: "/admin/inventory", label: "Inventory", icon: Boxes },
  { href: "/admin/pos", label: "Point of Sale", short: "POS", icon: ShoppingCart },
  { href: "/admin/sales", label: "Sales", icon: Receipt },
  { href: "/admin/schedule", label: "Schedule", icon: Calendar },
  { href: "/admin/bookings", label: "Bookings", icon: CalendarDays },
  { href: "/admin/queue", label: "Queue", icon: Users2 },
  { href: "/admin/waitlist", label: "Waitlist", icon: Clock },
  { href: "/admin/revenue", label: "Revenue", icon: BarChart3 },
  { href: "/admin/analytics", label: "Analytics", icon: BarChart2 },
  { href: "/admin/payments", label: "Payments", icon: CreditCard },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

const STAFF_NAV: NavItem[] = [
  { href: "/staff", label: "Today", icon: LayoutDashboard },
  { href: "/staff/bookings", label: "My Bookings", short: "Bookings", icon: CalendarDays },
  { href: "/staff/pos", label: "Point of Sale", short: "POS", icon: ShoppingCart },
  { href: "/staff/availability", label: "Availability", icon: Clock },
];

export const NAV_MAP: Record<UserRole, NavItem[]> = {
  developer: DEV_NAV,
  admin: ADMIN_NAV,
  staff: STAFF_NAV,
  customer: [],
};

/** Dashboard roots match exactly; every other destination matches by prefix. */
const ROOT_HREFS = new Set(["/dev", "/admin", "/staff"]);

export function isNavActive(href: string, pathname: string): boolean {
  return href === pathname || (!ROOT_HREFS.has(href) && pathname.startsWith(href));
}

/** Current "Switch View" target for developers (SPA path). */
function developerViewSelectValue(pathname: string): string {
  if (pathname.startsWith("/admin")) return "/admin";
  if (pathname.startsWith("/staff")) return "/staff";
  if (pathname.startsWith("/account")) return "/account";
  return "/dev/dashboard";
}

interface SidebarProps {
  role: UserRole;
  shopName?: string;
  userName?: string;
  /** Show Switch View while browsing as admin/staff with a developer session. */
  showDeveloperViewSwitcher?: boolean;
  /** Called after a destination is tapped; the phone drawer closes itself with it. */
  onNavigate?: () => void;
  /** When set, a close button renders in the header (the phone drawer). */
  onClose?: () => void;
}

/**
 * The dashboard's navigation column. It fills whatever box it is given: the
 * 15rem rail from md up, or the off-canvas drawer on phones (DashboardLayout
 * owns both boxes). Touch targets grow on phones and settle back at md.
 */
export function Sidebar({
  role,
  shopName,
  userName,
  showDeveloperViewSwitcher = false,
  onNavigate,
  onClose,
}: SidebarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const navItems = NAV_MAP[role] ?? [];

  return (
    <aside className="flex h-full w-full flex-col bg-dark">
      {/* Logo / Shop name */}
      <div className="flex items-start justify-between gap-2 border-b border-white/10 py-4 pl-5 pr-3">
        <div className="min-w-0">
          <p className="font-heading text-lg font-bold text-white">
            Pivot <span className="text-gold">Parlor</span>
          </p>
          {shopName && (
            <p className="mt-0.5 truncate text-xs text-white/50">{shopName}</p>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-1 -mt-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Dashboard">
        {role === "developer" || showDeveloperViewSwitcher ? (
          <div className="mb-4 px-2">
            <label htmlFor="pp-dev-switch-view" className="mb-1.5 block text-xs font-medium text-white/60">
              Switch View
            </label>
            <select
              id="pp-dev-switch-view"
              className="w-full rounded-lg border border-white/15 bg-white/5 px-2.5 py-2.5 text-sm text-white focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/40 md:py-2"
              value={developerViewSelectValue(pathname)}
              onChange={(e) => navigate(e.target.value)}
            >
              <option className="bg-dark text-white" value="/dev/dashboard">
                Developer Dashboard
              </option>
              <option className="bg-dark text-white" value="/admin">
                Admin View
              </option>
              <option className="bg-dark text-white" value="/staff">
                Staff View
              </option>
              <option className="bg-dark text-white" value="/account">
                Customer View
              </option>
            </select>
          </div>
        ) : null}
        <ul className="space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = isNavActive(href, pathname);
            return (
              <li key={href}>
                <Link
                  to={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold md:py-2",
                    active
                      ? "bg-gold/10 text-gold"
                      : "text-white/60 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User + logout */}
      <div className="border-t border-white/10 p-3">
        {userName && (
          <p className="mb-2 truncate px-2 text-xs text-white/60">{userName}</p>
        )}
        <form action="/logout" method="post">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold md:py-2"
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
