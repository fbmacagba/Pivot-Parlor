import { useCallback, useEffect, useRef, useState } from "react";
import { MAP_CONSENT_EVENT, readMapConsent, recordShopConsent, SHOP_CONSENT_KEY, type MapConsent } from "~/lib/mapConsent";

// Shop-site cookie notice (PECR / UK GDPR).
//
// Shops set only strictly necessary cookies (session + security). The one
// optional item is the Google map on a shop with a real address: its iframe
// lets Google set cookies, so on those shops the notice is a choice ("Allow
// map" or "Essential only") and the map loads only after "Allow map" (see
// ConsentedMap). Elsewhere it stays an informational notice, and one already
// acknowledged on the main platform (pp_platform_consent) is not shown again,
// to avoid a double notice on shops served under pivotparlor.com/<slug>.
// The footer's "Manage cookie preferences" reopens it, so a choice can be
// changed or withdrawn.

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
    return !!localStorage.getItem(SHOP_CONSENT_KEY);
  } catch {
    return false;
  }
}

export function ShopSiteCookieConsent({
  forceOpen,
  asksAboutMap = false,
  onClose,
  onHeightChange,
  onOpenChange,
}: {
  forceOpen: boolean;
  /** This shop shows a Google map, so the notice asks whether to load it. */
  asksAboutMap?: boolean;
  onClose: () => void;
  onHeightChange?: (height: number) => void;
  /** Whether the notice is on screen: the phone booking bar yields to it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [visible, setVisible] = useState(false);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(visible);
  }, [visible, onOpenChange]);

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
    if (asksAboutMap) {
      // The platform notice never asked about the map: only a map choice
      // made on a shop closes this one.
      if (readMapConsent() === null) setVisible(true);
      return;
    }
    // Honour a decision already made on the main platform site.
    if (alreadyAcknowledgedOnPlatform()) return;
    if (!alreadyAcknowledgedOnShop()) setVisible(true);
  }, [forceOpen, asksAboutMap]);

  // A choice made elsewhere while the notice is up (a map's "Show map", or
  // another tab) answers it: close rather than keep asking.
  useEffect(() => {
    if (!visible) return;
    const answered = () => {
      setVisible(false);
      onClose();
    };
    window.addEventListener(MAP_CONSENT_EVENT, answered);
    return () => window.removeEventListener(MAP_CONSENT_EVENT, answered);
  }, [visible, onClose]);

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

  // Recording the choice fires MAP_CONSENT_EVENT, which closes the notice
  // through the listener above.
  const decide = useCallback((maps: MapConsent | null) => recordShopConsent(maps), []);

  if (!visible) return null;

  // The label takes the theme's on-accent colour: fixed black text was 1.76:1
  // on a dark accent (a deep green salon palette). Black stays the fallback
  // for a scope without the site-theme tokens.
  // The map choice's two buttons look the same: declining is as easy and as
  // prominent as allowing (ICO cookie guidance).
  const primary =
    "min-h-11 shrink-0 rounded-lg bg-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-on-accent,#000)] md:min-h-12 md:min-w-[10rem]";

  return (
    <div
      ref={noticeRef}
      className="pp-safe-bottom pp-safe-x fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 pt-3 [--pp-pad-bottom:0.75rem] [--pp-pad-x:1rem] shadow-2xl backdrop-blur-md md:pt-6 md:[--pp-pad-bottom:1.5rem] md:[--pp-pad-x:1.5rem]"
      role="region"
      aria-label="Cookie notice"
    >
      {asksAboutMap ? (
        <div className="mx-auto flex max-w-4xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 flex-1">
            <p className="pp-heading hidden text-lg text-white md:block">Cookies &amp; privacy</p>
            <p className="text-sm text-white/60 md:hidden">
              Essential cookies only, unless you allow the Google map, which sets Google&rsquo;s cookies.
            </p>
            <p className="mt-1 hidden max-w-2xl text-sm text-white/60 md:block">
              We use only strictly necessary cookies to run this site, such as
              your session and security checks. The map on this site comes
              from Google Maps, which sets its own cookies when it loads. See
              the Cookie Policy in the footer for details.
            </p>
          </div>
          <div className="flex gap-2">
            <button ref={dismissRef} type="button" className={`${primary} flex-1 md:flex-none`} onClick={() => decide("declined")}>
              Essential only
            </button>
            <button type="button" className={`${primary} flex-1 md:flex-none`} onClick={() => decide("granted")}>
              Allow map
            </button>
          </div>
        </div>
      ) : (
        // Phone: one compact row beside the button, so the notice does not
        // take the shop's first screen. Wider: heading and full sentence.
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
          <button ref={dismissRef} type="button" className={primary} onClick={() => decide(null)}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
