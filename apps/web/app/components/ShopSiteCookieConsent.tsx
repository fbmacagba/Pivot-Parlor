import { useCallback, useEffect, useRef, useState } from "react";

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
  onHeightChange,
}: {
  forceOpen: boolean;
  onClose: () => void;
  onHeightChange?: (height: number) => void;
}) {
  const [visible, setVisible] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  // Include wrapping and safe-area padding in the lift for floating chat controls.
  useEffect(() => {
    const notice = noticeRef.current;
    if (!visible || !notice) { onHeightChange?.(0); return; }
    const measure = () => onHeightChange?.(Math.ceil(notice.getBoundingClientRect().height));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(notice);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); onHeightChange?.(0); };
  }, [visible, onHeightChange]);

  useEffect(() => {
    if (forceOpen) {
      setVisible(true);
      return;
    }
    // Honour a decision already made on the main platform site.
    if (alreadyAcknowledgedOnPlatform()) return;
    if (!alreadyAcknowledgedOnShop()) setVisible(true);
  }, [forceOpen]);

  // When reopened from the footer link, move focus to the notice so keyboard
  // and screen-reader users land on what just appeared; restore it on close.
  // Guarded on `visible` so the button exists before we focus it.
  useEffect(() => {
    if (!forceOpen || !visible) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dismissRef.current?.focus();
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [forceOpen, visible]);

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
      ref={noticeRef}
      className="pp-safe-bottom pp-safe-x fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 pt-3 [--pp-pad-bottom:0.75rem] [--pp-pad-x:1rem] shadow-2xl backdrop-blur-md md:pt-6 md:[--pp-pad-bottom:1.5rem] md:[--pp-pad-x:1.5rem]"
      role="region"
      aria-label="Cookie notice"
    >
      {/* Phone: one compact row beside the button, so the notice does not
          take the shop's first screen. Wider: heading and full sentence. */}
      <div className="mx-auto flex max-w-4xl items-center gap-3 md:justify-between">
        <div className="min-w-0 flex-1">
          <p className="pp-heading hidden text-lg text-white md:block">Cookies &amp; privacy</p>
          <p className="text-sm text-white/60 md:hidden">
            Only strictly necessary cookies, for your session and security. No analytics or marketing.
          </p>
          <p className="mt-1 hidden max-w-2xl text-sm text-white/60 md:block">
            We use only strictly necessary cookies to run this site, such as
            your session and security checks. We don&rsquo;t use analytics or
            marketing cookies. See the Privacy Policy in the footer for details.
          </p>
        </div>
        {/* The label takes the theme's on-accent colour: fixed black text was
            1.76:1 on a dark accent (a deep green salon palette). Black stays
            the fallback for a scope without the site-theme tokens. */}
        <button
          ref={dismissRef}
          type="button"
          className="min-h-11 shrink-0 rounded-lg bg-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-on-accent,#000)] md:min-h-12 md:min-w-[10rem]"
          onClick={dismiss}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
