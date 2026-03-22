import { Link, useLocation } from "@remix-run/react";
import {
  BarChart3,
  Bot,
  Calendar,
  CalendarDays,
  Clock,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
  ShoppingBag,
  Users,
} from "lucide-react";
import { clsx } from "clsx";
import type { UserRole } from "@repo/types";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

const DEV_NAV: NavItem[] = [
  { href: "/dev", label: "Overview", icon: LayoutDashboard },
  { href: "/dev/shops", label: "Shops", icon: ShoppingBag },
  { href: "/dev/revenue", label: "Revenue", icon: BarChart3 },
  { href: "/dev/ai-deploy", label: "AI Deploy", icon: Bot },
  { href: "/dev/enquiries", label: "Enquiries", icon: MessageSquare },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/staff", label: "Staff", icon: Users },
  { href: "/admin/schedule", label: "Schedule", icon: Calendar },
  { href: "/admin/bookings", label: "Bookings", icon: CalendarDays },
  { href: "/admin/revenue", label: "Revenue", icon: BarChart3 },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

const STAFF_NAV: NavItem[] = [
  { href: "/staff", label: "Today", icon: LayoutDashboard },
  { href: "/staff/bookings", label: "My Bookings", icon: CalendarDays },
  { href: "/staff/availability", label: "Availability", icon: Clock },
];

const NAV_MAP: Record<UserRole, NavItem[]> = {
  developer: DEV_NAV,
  admin: ADMIN_NAV,
  staff: STAFF_NAV,
  customer: [],
};

interface SidebarProps {
  role: UserRole;
  shopName?: string;
  userName?: string;
}

export function Sidebar({ role, shopName, userName }: SidebarProps) {
  const { pathname } = useLocation();
  const navItems = NAV_MAP[role] ?? [];

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-white/10 bg-dark">
      {/* Logo / Shop name */}
      <div className="border-b border-white/10 px-5 py-4">
        <p className="font-heading text-lg font-bold text-white">
          Pivot <span className="text-gold">Parlor</span>
        </p>
        {shopName && (
          <p className="mt-0.5 text-xs text-white/50 truncate">{shopName}</p>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active =
              href === pathname ||
              (href !== "/dev" &&
                href !== "/admin" &&
                href !== "/staff" &&
                pathname.startsWith(href));
            return (
              <li key={href}>
                <Link
                  to={href}
                  className={clsx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-gold/10 text-gold"
                      : "text-white/60 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
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
          <p className="mb-2 px-2 text-xs text-white/40 truncate">{userName}</p>
        )}
        <form action="/logout" method="post">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-red-400"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
