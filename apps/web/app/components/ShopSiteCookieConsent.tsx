import { useCallback, useEffect, useState } from "react";

// Shop-site cookie consent
// KEY RULE: if the visitor already consented on the main Pivot Parlor platform
// (pp_platform_consent), we honour that and skip showing this banner entirely.
// This prevents double-banner on shops served under pivotparlor.com/slug.

const SHOP_KEY     = "pp_cookie_consent";
const PLATFORM_KEY = "pp_platform_consent";

function alreadyConsentedOnPlatform(): boolean {
  try {
    const raw = localStorage.getItem(PLATFORM_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { decided?: boolean };
    return parsed?.decided === true;
  } catch {
    return false;
  }
}

function alreadyConsentedOnShop(): boolean {
  try {
    return !!localStorage.getItem(SHOP_KEY);
  } catch {
    return false;
  }
}

export function ShopSiteCookieConsent({
  forceOpen,
  onClose,
}: {
  forceOpen: boolean;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    if (forceOpen) {
      setVisible(true);
      return;
    }
    // If the user already consented on the main platform site, skip entirely
    if (alreadyConsentedOnPlatform()) return;
    if (!alreadyConsentedOnShop()) setVisible(true);
  }, [forceOpen]);

  const persist = useCallback(
    (prefs: { analytics: boolean; marketing: boolean }) => {
      const payload = {
        essential: true,
        analytics: prefs.analytics,
        marketing: prefs.marketing,
        timestamp: new Date().toISOString(),
      };
      try {
        localStorage.setItem(SHOP_KEY, JSON.stringify(payload));
      } catch {
        /* ignore */
      }
      setVisible(false);
      onClose();
    },
    [onClose]
  );

  if (!visible) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 p-4 shadow-2xl backdrop-blur-md md:p-6"
      role="dialog"
      aria-label="Cookie preferences"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="pp-heading text-lg text-white">Cookies &amp; privacy</p>
          <p className="mt-1 max-w-xl text-sm text-white/60">
            We use essential cookies to run the site. You can opt in to analytics and marketing below.
          </p>
          <ul className="mt-4 space-y-3 text-sm text-white/80">
            <li className="flex items-center justify-between gap-4">
              <span>Essential</span>
              <input type="checkbox" checked disabled className="h-6 w-6 accent-[color:var(--color-accent)]" />
            </li>
            <li className="flex items-center justify-between gap-4">
              <span>Analytics</span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                className="h-6 w-6 accent-[color:var(--color-accent)]"
              />
            </li>
            <li className="flex items-center justify-between gap-4">
              <span>Marketing</span>
              <input
                type="checkbox"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                className="h-6 w-6 accent-[color:var(--color-accent)]"
              />
            </li>
          </ul>
        </div>
        <div className="flex min-h-12 flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg bg-[color:var(--color-accent)] px-4 font-semibold text-black"
            onClick={() => persist({ analytics: true, marketing: true })}
          >
            Accept All
          </button>
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg border border-white/20 px-4 font-medium text-white"
            onClick={() => persist({ analytics, marketing })}
          >
            Save Preferences
          </button>
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg border border-white/10 px-4 font-medium text-white/80"
            onClick={() => persist({ analytics: false, marketing: false })}
          >
            Reject All
          </button>
        </div>
      </div>
    </div>
  );
}
