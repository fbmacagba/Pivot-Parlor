// Platform-level cookie notice (PECR / UK GDPR).
//
// Pivot Parlor sets ONLY strictly-necessary cookies (login session + security
// checks), which need no consent under PECR. The notice still offers the two
// answers visitors know from other sites, Accept and Essential only (owner's
// choice, 2026-11-16), and they look the same: declining is as easy and as
// prominent as accepting. Today both have the same effect, and the Cookie
// Policy says so. The answer is recorded in localStorage (pp_platform_consent,
// { decided: true, choice }) so the notice is not shown again;
// ShopSiteCookieConsent and the E2E helper read `decided`, the shop notice to
// avoid a double notice on shops served under pivotparlor.com/<slug>, except
// on a shop with a Google map, whose notice asks a question this one never
// did (lib/mapConsent.ts): neither answer here ever loads a map. "accept" is
// not consent to anything added later; optional cookies would mean asking
// again.
//
// SUPPRESSION: a shop's pages (the $shopSlug route tree, found by the same
// route match that swaps the PWA identity) render their own notice, so this
// one stays off them. Every other page shows it, with no list to keep current.
//
// MAKING ROOM: while it shows, it publishes the space it takes from the
// bottom edge (lib/cookieNoticeLayer) so the other fixed controls along the
// bottom (the floating sign-up button, Pip, the dashboards' tab bar) move up
// and are never hidden under it, and the install invitation waits until it
// is gone.

import { Cookie } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/Button";
import { publishCookieNotice } from "~/lib/cookieNoticeLayer";
import { useShopMatch } from "~/lib/shop-match";

const CONSENT_KEY = "pp_platform_consent";

type PlatformCookieChoice = "accept" | "essential";

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

// Answered in this page's life, for a browser that refuses localStorage.
let answeredThisPageLife = false;

/**
 * Whether this visitor has answered the notice, so it will not appear. The
 * floating sign-up button waits for this: the notice only appears after
 * hydration, and a button shown until then would vanish as it arrived.
 */
export function platformNoticeAnswered(): boolean {
  return answeredThisPageLife || alreadyAcknowledged();
}

// Both answers share one look. `!` because the Button base sets a fixed
// height and nowrap: at 200% text, or 320px wide, a label wraps rather than
// spilling out of its button.
const CHOICE =
  "!h-auto min-h-11 !whitespace-normal !px-3 py-2 text-center leading-tight focus-visible:ring-offset-2 focus-visible:ring-offset-dark-100 sm:min-h-10 sm:min-w-[8.5rem] sm:!px-5";

// The third, quieter control: white ink, not gold, so the two answers lead.
const POLICY_LINK =
  "rounded-sm text-sm text-white/70 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark-100";

export function PlatformCookieBanner() {
  const onShopPage = useShopMatch() !== null;
  // Not yet acknowledged on this device. Read after hydration: the server
  // cannot see localStorage, so the notice never renders in server HTML.
  const [pending, setPending] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const visible = pending && !onShopPage;

  useEffect(() => {
    if (!alreadyAcknowledged()) setPending(true);
  }, []);

  const decide = useCallback((choice: PlatformCookieChoice) => {
    try {
      localStorage.setItem(
        CONSENT_KEY,
        JSON.stringify({ decided: true, choice, timestamp: new Date().toISOString() }),
      );
    } catch {
      /* private browsing: it simply shows again on the next visit */
    }
    answeredThisPageLife = true;
    setPending(false);
  }, []);

  // Hold space for the notice while it shows, including when it wraps or the
  // text is enlarged, and give it back when it goes. Measured on the layer,
  // which is fixed to the bottom edge and never animated: the card inside it
  // floats above a margin, and rises into place when it first appears.
  useEffect(() => {
    const layer = layerRef.current;
    if (!visible || !layer) return;
    const measure = () => publishCookieNotice("platform", window.innerHeight - layer.getBoundingClientRect().top);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(layer);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      publishCookieNotice("platform", null);
    };
  }, [visible]);

  // Escape closes it as Essential only (never as Accept), unless a dialog
  // (Pip, the install invitation, a dashboard drawer) is open and owns the
  // key, or something else has already handled it. Whether a dialog was open
  // is read at the very start of the key press (window, capture): a dialog's
  // own Escape handler closes it, and React removes it before any later
  // listener runs.
  useEffect(() => {
    if (!visible) return;
    const ownedByDialog = new WeakSet<Event>();
    const onKeyDownFirst = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) ownedByDialog.add(e);
    };
    const onKeyDownLast = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || ownedByDialog.has(e)) return;
      decide("essential");
    };
    window.addEventListener("keydown", onKeyDownFirst, true);
    window.addEventListener("keydown", onKeyDownLast);
    return () => {
      window.removeEventListener("keydown", onKeyDownFirst, true);
      window.removeEventListener("keydown", onKeyDownLast);
    };
  }, [visible, decide]);

  if (!visible) return null;

  // A raised Charcoal card with a gold hairline, set off the page's edges, so
  // it reads as a notice and not as the page's last section. The layer lets
  // clicks through around the card. Safe-area padding: fixed elements are
  // outside the body's own inset padding, so in the installed app the card
  // would otherwise sit under the home indicator. The card is capped at half
  // the screen: with enlarged text the words scroll, and the heading and the
  // answers always stay in view.
  return (
    <div
      ref={layerRef}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center pb-[calc(0.75rem+env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
    >
      <div
        role="region"
        aria-label="Cookie notice"
        className="pp-notice-rise pointer-events-auto flex max-h-[calc(50dvh-1.5rem)] w-full max-w-xl flex-col rounded-2xl border border-gold/30 bg-dark-100 p-4 shadow-2xl sm:p-5"
      >
        <div className="flex shrink-0 items-center gap-3">
          {/* Sized in px: a decorative mark need not grow with enlarged text,
              and the room it would take goes to the words instead. */}
          <span
            aria-hidden="true"
            className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold"
          >
            <Cookie className="h-[20px] w-[20px]" strokeWidth={1.75} />
          </span>
          <h2 className="font-heading text-xl font-semibold leading-tight text-white">Cookies</h2>
        </div>
        {/* The words scroll when space runs out. On a phone the policy link
            scrolls with them, so enlarged text keeps room to be read; wider
            up it sits beside the answers. The slight inset keeps focus rings
            clear of the scroll edge. */}
        <div className="-mx-1 mt-3 min-h-0 overflow-y-auto px-1 pb-1">
          <p className="text-sm leading-relaxed text-white/70">
            We use only strictly necessary cookies: your sign-in and security
            checks. No analytics, advertising or tracking.
          </p>
          <Link to="/cookies" className={`${POLICY_LINK} mt-3 inline-block sm:hidden`}>
            Cookie policy
          </Link>
        </div>
        <div className="mt-4 flex shrink-0 items-center sm:justify-between">
          <Link to="/cookies" className={`${POLICY_LINK} hidden sm:inline`}>
            Cookie policy
          </Link>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button type="button" variant="outline" className={CHOICE} onClick={() => decide("essential")}>
              Essential only
            </Button>
            <Button type="button" variant="outline" className={CHOICE} onClick={() => decide("accept")}>
              Accept
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
