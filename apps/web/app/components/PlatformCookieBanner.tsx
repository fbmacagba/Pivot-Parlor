// Platform-level cookie notice (PECR / UK GDPR).
//
// Pivot Parlor sets ONLY strictly-necessary cookies (login session + security
// checks). Under PECR no consent is required for those, so this is an
// INFORMATIONAL notice, not a consent choice — there are no optional /
// analytics / marketing cookies to toggle. It is shown once per browser and
// recorded in localStorage (pp_platform_consent) so it is not shown again;
// ShopSiteCookieConsent honours the same record to avoid a double notice on
// shops served under pivotparlor.com/<slug>.
//
// SUPPRESSION: shop pages (/:shopSlug/*) render their own ShopSiteCookieConsent
// via CommercialShopChrome, so this notice must not render on those routes.

import { useState, useEffect } from "react";
import { useLocation, Link } from "@remix-run/react";

const CONSENT_KEY = "pp_platform_consent";

// Known platform route prefixes; anything else is treated as a shop route
// (which renders its own notice).
const PLATFORM_ROUTE_PREFIXES = [
  "/admin",
  "/staff",
  "/account",
  "/dev",
  "/setup",
  "/onboarding",
  "/login",
  "/logout",
  "/invite",
  "/api",
  "/about",
  "/features",
  "/pricing",
  "/contact",
  "/privacy",
  "/terms",
  "/cookies",
];

function isShopRoute(pathname: string): boolean {
  if (pathname === "/") return false;
  for (const prefix of PLATFORM_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return false;
  }
  return true;
}

function alreadyAcknowledged(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { decided?: boolean };
    return parsed?.decided === true;
  } catch {
    return false;
  }
}

export function PlatformCookieBanner() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show on shop routes — they render their own notice.
    if (isShopRoute(location.pathname)) return;
    if (!alreadyAcknowledged()) setVisible(true);
  }, [location.pathname]);

  const dismiss = () => {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        JSON.stringify({ decided: true, timestamp: new Date().toISOString() }),
      );
    } catch {
      /* ignore — private browsing */
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed bottom-0 inset-x-0 z-50 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-md shadow-2xl"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex-1 text-sm text-white/70 leading-relaxed">
          We use only strictly necessary cookies to keep Pivot Parlor working,
          such as your login session and security checks. We don&rsquo;t use
          analytics, advertising, or tracking cookies. See our{" "}
          <Link
            to="/cookies"
            className="text-gold underline decoration-gold/50 hover:decoration-gold"
          >
            Cookie Policy
          </Link>
          .
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="min-h-10 shrink-0 rounded-lg bg-gold px-5 text-sm font-semibold text-dark hover:bg-gold/90 transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
