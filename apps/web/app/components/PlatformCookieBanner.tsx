// Platform-level cookie notice (PECR / UK GDPR).
//
// Pivot Parlor sets ONLY strictly-necessary cookies (login session + security
// checks). Under PECR no consent is required for those, so this is an
// INFORMATIONAL notice, not a consent choice: there are no optional /
// analytics / marketing cookies to toggle. It is shown once per browser and
// recorded in localStorage (pp_platform_consent, shape { decided: true }) so
// it is not shown again; ShopSiteCookieConsent and the E2E helper read the
// same record, the shop notice to avoid a double notice on shops served under
// pivotparlor.com/<slug>, except on a shop with a Google map, whose notice
// asks a question this one never did (lib/mapConsent.ts).
//
// SUPPRESSION: a shop's pages (the $shopSlug route tree, found by the same
// route match that swaps the PWA identity) render their own notice, so this
// one stays off them. Every other page shows it, with no list to keep current.
//
// MAKING ROOM: while it shows, it publishes its height (lib/cookieNoticeLayer)
// so the other fixed controls along the bottom (the floating sign-up button,
// Pip, the dashboards' tab bar) move up and are never hidden under it, and
// the install invitation waits until it is gone.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { publishCookieNotice } from "~/lib/cookieNoticeLayer";
import { useShopMatch } from "~/lib/shop-match";

const CONSENT_KEY = "pp_platform_consent";

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
  const onShopPage = useShopMatch() !== null;
  // Not yet acknowledged on this device. Read after hydration: the server
  // cannot see localStorage, so the notice never renders in server HTML.
  const [pending, setPending] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const visible = pending && !onShopPage;

  useEffect(() => {
    if (!alreadyAcknowledged()) setPending(true);
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        JSON.stringify({ decided: true, timestamp: new Date().toISOString() }),
      );
    } catch {
      /* private browsing: it simply shows again on the next visit */
    }
    setPending(false);
  }, []);

  // Hold space for the notice while it shows, including when it wraps or the
  // text is enlarged, and give it back when it goes.
  useEffect(() => {
    const notice = noticeRef.current;
    if (!visible || !notice) return;
    const measure = () => publishCookieNotice("platform", notice.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(notice);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      publishCookieNotice("platform", null);
    };
  }, [visible]);

  // Escape closes it like "Got it", unless a dialog (Pip, the install
  // invitation, a dashboard drawer) is open and owns the key, or something
  // else has already handled it. Whether a dialog was open is read at the
  // very start of the key press (window, capture): a dialog's own Escape
  // handler closes it, and React removes it before any later listener runs.
  useEffect(() => {
    if (!visible) return;
    const ownedByDialog = new WeakSet<Event>();
    const onKeyDownFirst = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) ownedByDialog.add(e);
    };
    const onKeyDownLast = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || ownedByDialog.has(e)) return;
      dismiss();
    };
    window.addEventListener("keydown", onKeyDownFirst, true);
    window.addEventListener("keydown", onKeyDownLast);
    return () => {
      window.removeEventListener("keydown", onKeyDownFirst, true);
      window.removeEventListener("keydown", onKeyDownLast);
    };
  }, [visible, dismiss]);

  if (!visible) return null;

  // Safe-area padding: fixed elements are outside the body's own inset
  // padding, so in the installed app the button would otherwise sit under
  // the home indicator. The button is the quiet secondary style: this notice
  // asks nothing, so it must not outshout the page's one gold action.
  return (
    <div
      ref={noticeRef}
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-dark/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-2xl backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
        {/* Capped so enlarged text cannot turn the notice into most of the
            screen: the words scroll, the button always stays in view. */}
        <p className="max-h-[25dvh] flex-1 overflow-y-auto text-sm leading-relaxed text-white/70">
          We use only strictly necessary cookies to keep Pivot Parlor working,
          such as your login session and security checks. We don&rsquo;t use
          analytics, advertising, or tracking cookies. See our{" "}
          <Link
            to="/cookies"
            className="rounded-sm text-gold underline decoration-gold/50 underline-offset-2 hover:decoration-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark"
          >
            Cookie Policy
          </Link>
          .
        </p>
        <Button type="button" variant="secondary" onClick={dismiss} className="shrink-0">
          Got it
        </Button>
      </div>
    </div>
  );
}
