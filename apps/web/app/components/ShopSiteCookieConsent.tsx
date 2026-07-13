import { useCallback, useEffect, useState } from "react";

// Shop-site cookie notice (PECR / UK GDPR).
//
// Shops set ONLY strictly-necessary cookies (session + security), so under PECR
// no consent is required — this is an INFORMATIONAL notice, not a consent
// choice. If the visitor already acknowledged the notice on the main Pivot
// Parlor platform (pp_platform_consent), we skip showing it again here to avoid
// a double notice on shops served under pivotparlor.com/<slug>.

const SHOP_KEY = "pp_cookie_consent";
const PLATFORM_KEY = "pp_platform_consent";

function alreadyAcknowledgedOnPlatform(): boolean {
  try {
    const raw = localStorage.getItem(PLATFORM_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { decided?: boolean };
    return parsed?.decided === true;
  } catch {
    return false;
  }
}

function alreadyAcknowledgedOnShop(): boolean {
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

  useEffect(() => {
    if (forceOpen) {
      setVisible(true);
      return;
    }
    // Honour a decision already made on the main platform site.
    if (alreadyAcknowledgedOnPlatform()) return;
    if (!alreadyAcknowledgedOnShop()) setVisible(true);
  }, [forceOpen]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(
        SHOP_KEY,
        JSON.stringify({
          essential: true,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch {
      /* ignore */
    }
    setVisible(false);
    onClose();
  }, [onClose]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 p-4 shadow-2xl backdrop-blur-md md:p-6"
      role="region"
      aria-label="Cookie notice"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="pp-heading text-lg text-white">Cookies &amp; privacy</p>
          <p className="mt-1 max-w-2xl text-sm text-white/60">
            We use only strictly necessary cookies to run this site, such as
            your session and security checks. We don&rsquo;t use analytics or
            marketing cookies. See the Privacy Policy in the footer for details.
          </p>
        </div>
        <button
          type="button"
          className="min-h-12 min-w-[10rem] shrink-0 rounded-lg bg-[color:var(--color-accent)] px-4 font-semibold text-black"
          onClick={dismiss}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
