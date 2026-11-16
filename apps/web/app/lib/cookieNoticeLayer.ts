// One page-wide record of the cookie notice on screen.
//
// A cookie notice is fixed along the bottom of the viewport, and other fixed
// layers live there too: the marketing pages' floating sign-up button and
// Pip, and the dashboards' phone tab bar. Left alone, the notice covers them,
// so a keyboard user can focus a control they cannot see (WCAG 2.2 SC
// 2.4.11). The notice publishes the space it takes up from the bottom edge
// (for a floating card, its margin included) as a CSS variable on <html>;
// those layers add it to their bottom offset (ABOVE_COOKIE_NOTICE) and so
// stand clear of it while it shows. The install invitation reads the same
// record and waits until no notice is open.
//
// Two notices exist: the platform's (root layout) and a shop's (shop chrome).
// Each publishes under its own name, so one unmounting during a client-side
// move between the two can never clear the other's entry.
//
// Written through the CSSOM (style.setProperty), which the page's CSP allows;
// never through a style attribute.

import { useSyncExternalStore } from "react";

export type CookieNoticeOwner = "platform" | "shop";

export const COOKIE_NOTICE_HEIGHT_VAR = "--pp-cookie-notice-h";

/** Fired on window when the first notice opens and when the last one closes. */
export const COOKIE_NOTICE_EVENT = "pp:cookie-notice";

/**
 * Bottom offsets that clear an open notice, and fall back to the plain offset
 * when none is open. Spelled out in full so Tailwind generates each class.
 */
export const ABOVE_COOKIE_NOTICE = {
  bottom0: "bottom-[var(--pp-cookie-notice-h,0px)]",
  bottom6: "bottom-[calc(1.5rem+var(--pp-cookie-notice-h,0px))]",
  bottom24: "bottom-[calc(6rem+var(--pp-cookie-notice-h,0px))]",
  smBottom24: "sm:bottom-[calc(6rem+var(--pp-cookie-notice-h,0px))]",
  /** A panel lifted by smBottom24 never grows past the top of the screen. */
  smFitAbove: "sm:max-h-[calc(100dvh-7rem-var(--pp-cookie-notice-h,0px))]",
} as const;

const heights = new Map<CookieNoticeOwner, number>();

/** Record `owner`'s notice as open at `height` CSS px, or closed with null. */
export function publishCookieNotice(owner: CookieNoticeOwner, height: number | null): void {
  if (typeof document === "undefined") return;
  const wasOpen = heights.size > 0;
  if (height === null) {
    heights.delete(owner);
  } else {
    heights.set(owner, Math.max(0, Math.ceil(height)));
  }

  const root = document.documentElement;
  const isOpen = heights.size > 0;
  if (isOpen) {
    root.style.setProperty(COOKIE_NOTICE_HEIGHT_VAR, `${Math.max(...heights.values())}px`);
    root.dataset.cookieNotice = "open";
  } else {
    root.style.removeProperty(COOKIE_NOTICE_HEIGHT_VAR);
    delete root.dataset.cookieNotice;
  }
  if (wasOpen !== isOpen) window.dispatchEvent(new Event(COOKIE_NOTICE_EVENT));
}

/** Whether any cookie notice is on screen. */
export function isCookieNoticeOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.cookieNotice === "open";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(COOKIE_NOTICE_EVENT, onChange);
  return () => window.removeEventListener(COOKIE_NOTICE_EVENT, onChange);
}

/** isCookieNoticeOpen as React state: false on the server and while hydrating. */
export function useCookieNoticeOpen(): boolean {
  return useSyncExternalStore(subscribe, isCookieNoticeOpen, () => false);
}
