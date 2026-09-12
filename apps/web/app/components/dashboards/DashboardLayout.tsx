import "./dashboard-shell.css";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "@remix-run/react";
import { Menu } from "lucide-react";
import type { UserRole } from "@repo/types";
import { useModalA11y } from "~/lib/useModalA11y";
import { MobileTabBar } from "./MobileTabBar";
import { Sidebar } from "./Sidebar";

interface DashboardLayoutProps {
  role: UserRole;
  shopName?: string;
  userName?: string;
  topBarTitle?: string;
  topBanner?: React.ReactNode;
  /** True when a developer is viewing this dashboard (admin/staff) so Switch View stays available. */
  showDeveloperViewSwitcher?: boolean;
}

/**
 * Back-office shell for every dashboard role.
 *
 * From md (768px) up it is the fixed-height app layout: the 15rem rail on the
 * left, a 3.5rem top bar, and a main area that scrolls on its own. Below md the
 * page scrolls as a document under a sticky top bar, the rail becomes an
 * off-canvas drawer behind the menu button (and the More tab), and the primary
 * destinations sit in a thumb-reach tab bar along the bottom edge.
 *
 * Installed (standalone) mode: the top bar and the tab bar pad themselves by
 * the device safe-area insets; dashboard-shell.css stops the body doing the
 * same, otherwise the sticky bar would be double-padded at rest and jump on
 * the first scroll.
 */
export function DashboardLayout({
  role,
  shopName,
  userName,
  topBarTitle,
  topBanner,
  showDeveloperViewSwitcher = false,
}: DashboardLayoutProps) {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Navigating closes the drawer. So does growing past md while it is open:
  // the rail takes over there and a stranded scroll lock would freeze the page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const rail = window.matchMedia("(min-width: 768px)");
    if (rail.matches) {
      setMenuOpen(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false);
    };
    rail.addEventListener("change", onChange);
    return () => rail.removeEventListener("change", onChange);
  }, [menuOpen]);

  const drawerRef = useModalA11y<HTMLDivElement>({ active: menuOpen, onClose: closeMenu });
  const title = topBarTitle ?? shopName ?? "Pivot Parlor Platform";
  const sidebarProps = { role, shopName, userName, showDeveloperViewSwitcher };

  return (
    <div className="pp-dashboard bg-dark text-white md:flex md:h-screen md:overflow-hidden md:supports-[height:100dvh]:h-dvh">
      {/* Desktop rail */}
      <div className="hidden md:flex md:h-full md:w-60 md:shrink-0 md:border-r md:border-white/10">
        <Sidebar {...sidebarProps} />
      </div>

      <div className="flex min-h-screen flex-col supports-[height:100dvh]:min-h-dvh md:min-h-0 md:flex-1 md:overflow-hidden">
        {/* Top bar: sticky on phones, in flow inside the fixed shell from md up */}
        <header className="sticky top-0 z-30 shrink-0 border-b border-white/10 bg-dark/95 pt-[env(safe-area-inset-top)] backdrop-blur-md md:static md:bg-dark md:pt-0 md:backdrop-blur-none">
          <div className="flex h-14 items-center justify-between gap-3 pl-1 pr-4 md:px-6">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={openMenu}
                aria-label="Open menu"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                aria-controls="pp-dash-drawer"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold md:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
              <p className="truncate text-sm font-medium text-white/70">{title}</p>
            </div>
            {userName && (
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/20 text-xs font-semibold text-gold"
                title={userName}
                aria-hidden
              >
                {userName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        </header>
        {topBanner && <div className="px-4 md:px-6">{topBanner}</div>}
        {/* Main content: the bottom padding clears the fixed tab bar on phones */}
        <main className="flex-1 px-4 py-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:overflow-y-auto md:px-6 md:py-6 md:pb-6">
          <Outlet />
        </main>
      </div>

      <MobileTabBar role={role} onMore={openMenu} moreOpen={menuOpen} />

      {/* Phone drawer: the same Sidebar, off-canvas, focus-trapped */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="pp-dash-scrim absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={closeMenu}
            aria-hidden
          />
          <div
            ref={drawerRef}
            id="pp-dash-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="pp-dash-drawer absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-dark pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl"
          >
            <Sidebar {...sidebarProps} onNavigate={closeMenu} onClose={closeMenu} />
          </div>
        </div>
      )}
    </div>
  );
}
