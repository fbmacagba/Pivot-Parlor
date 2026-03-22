import { Outlet } from "@remix-run/react";
import { Sidebar } from "./Sidebar";
import type { UserRole } from "@repo/types";

interface DashboardLayoutProps {
  role: UserRole;
  shopName?: string;
  userName?: string;
  topBarTitle?: string;
  topBanner?: React.ReactNode;
}

export function DashboardLayout({
  role,
  shopName,
  userName,
  topBarTitle,
  topBanner,
}: DashboardLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-dark">
      <Sidebar role={role} shopName={shopName} userName={userName} />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-dark px-6">
          <p className="text-sm font-medium text-white/70">
            {topBarTitle ?? shopName ?? "Pivot Parlor Platform"}
          </p>
          {userName && (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gold/20 text-xs font-semibold text-gold">
              {userName.charAt(0).toUpperCase()}
            </div>
          )}
        </header>
        {topBanner && <div className="px-6">{topBanner}</div>}
        {/* Main content */}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
