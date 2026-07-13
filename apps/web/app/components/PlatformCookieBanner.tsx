// Platform-level PECR/UK GDPR cookie consent banner
// Shown on all Pivot Parlor platform routes (not shop-site routes)
// Persists to localStorage under key: pp_platform_consent
// Distinct from ShopSiteCookieConsent (which is per-shop template)
//
// SUPPRESSION: Shop pages (/:shopSlug/*) render their own ShopSiteCookieConsent
// via CommercialShopChrome. This banner must not render on those routes to
// avoid showing two cookie banners on the same page.

import { useState, useEffect, useCallback } from "react";
import { useLocation } from "@remix-run/react";

const CONSENT_KEY = "pp_platform_consent";

// Routes that have their own cookie consent (CommercialShopChrome)
// Pattern: /<shopSlug> and /<shopSlug>/* — identified by not matching known
// platform route prefixes.
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
  "/accept-invite",
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
  // If it starts with a known platform prefix it's not a shop route
  for (const prefix of PLATFORM_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return false;
  }
  // Anything else (e.g. /ferdym-barber-shop-001 or /ferdym-barber-shop-001/book)
  // is treated as a shop route
  return true;
}

type ConsentPrefs = {
  analytics: boolean;
  marketing: boolean;
  timestamp: string;
  decided: boolean;
};

function loadConsent(): ConsentPrefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw ? (JSON.parse(raw) as ConsentPrefs) : null;
  } catch {
    return null;
  }
}

function saveConsent(analytics: boolean, marketing: boolean): void {
  const payload: ConsentPrefs = {
    analytics,
    marketing,
    timestamp: new Date().toISOString(),
    decided: true,
  };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(payload));
  } catch {
    /* ignore – private browsing */
  }
}

export function PlatformCookieBanner() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    // Don't show on shop routes — they have their own banner
    if (isShopRoute(location.pathname)) return;
    const existing = loadConsent();
    if (!existing?.decided) setVisible(true);
  }, [location.pathname]);

  const dismiss = useCallback(
    (analyticsVal: boolean, marketingVal: boolean) => {
      saveConsent(analyticsVal, marketingVal);
      setVisible(false);
    },
    []
  );

  if (!visible) return null;

  return (
    <div
      role="dialog"
      // Not aria-modal: this is a non-blocking bottom banner and the page
      // behind it stays interactive. Claiming aria-modal here is a false
      // promise (no focus trap), so we only expose the dialog role + label
      // (matching ShopSiteCookieConsent).
      aria-label="Cookie consent"
      className="fixed bottom-0 inset-x-0 z-50 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-md shadow-2xl"
    >
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
        {!showPrefs ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <p className="flex-1 text-sm text-white/70 leading-relaxed">
              We use essential cookies to keep the platform running. With your
              consent, we also use analytics cookies to improve your experience.
              See our{" "}
              <a href="/cookies" className="text-gold underline decoration-gold/50 hover:decoration-gold">
                Cookie Policy
              </a>
              .
            </p>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <button type="button" onClick={() => setShowPrefs(true)}
                className="min-h-10 rounded-lg border border-white/20 px-4 text-sm font-medium text-white/80 hover:bg-white/5 transition-colors whitespace-nowrap">
                Manage
              </button>
              <button type="button" onClick={() => dismiss(false, false)}
                className="min-h-10 rounded-lg border border-white/10 px-4 text-sm font-medium text-white/60 hover:bg-white/5 transition-colors whitespace-nowrap">
                Reject optional
              </button>
              <button type="button" onClick={() => dismiss(true, true)}
                className="min-h-10 rounded-lg bg-gold px-5 text-sm font-semibold text-dark hover:bg-gold/90 transition-colors whitespace-nowrap">
                Accept all
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="font-heading text-base font-semibold text-white">Cookie preferences</p>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
              <div>
                <p className="text-sm font-medium text-white">Strictly necessary</p>
                <p className="mt-0.5 text-xs text-white/50">Session management, authentication, booking flow. Required to use the platform.</p>
              </div>
              <span className="shrink-0 rounded-full bg-gold/20 px-2.5 py-1 text-xs font-medium text-gold">Always on</span>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
              <div>
                <p className="text-sm font-medium text-white">Analytics</p>
                <p className="mt-0.5 text-xs text-white/50">Helps us understand how the platform is used. No personal data sold.</p>
              </div>
              <Toggle value={analytics} onChange={setAnalytics} />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
              <div>
                <p className="text-sm font-medium text-white">Marketing</p>
                <p className="mt-0.5 text-xs text-white/50">Used to show relevant offers and measure campaign performance. Optional.</p>
              </div>
              <Toggle value={marketing} onChange={setMarketing} />
            </div>

            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setShowPrefs(false)}
                className="min-h-10 rounded-lg border border-white/20 px-4 text-sm font-medium text-white/80 hover:bg-white/5 transition-colors">
                Back
              </button>
              <button type="button" onClick={() => dismiss(false, false)}
                className="min-h-10 rounded-lg border border-white/10 px-4 text-sm font-medium text-white/60 hover:bg-white/5 transition-colors">
                Reject all optional
              </button>
              <button type="button" onClick={() => dismiss(analytics, marketing)}
                className="min-h-10 rounded-lg bg-gold px-5 text-sm font-semibold text-dark hover:bg-gold/90 transition-colors">
                Save preferences
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark ${value ? "bg-gold" : "bg-white/20"}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${value ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export function getPlatformConsent(): ConsentPrefs | null {
  return loadConsent();
}
