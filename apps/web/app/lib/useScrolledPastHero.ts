import { useEffect, useRef, useState, type RefObject } from "react";

/** Attribute each hero variant puts on its root <section> so chrome can watch it. */
export const HERO_MARKER_ATTR = "data-pp-hero";

/**
 * True once the page's hero has scrolled out of view (and false again if the
 * visitor scrolls back up). Pages without a hero fall back to the sentinel
 * element this hook's ref is attached to, which the chrome sizes to one
 * viewport. Starts false on the server and on first paint, so the bottom bar
 * is never present in SSR markup; browsers without IntersectionObserver keep
 * the header CTA only.
 */
export function useScrolledPastHero(enabled: boolean): {
  sentinelRef: RefObject<HTMLDivElement>;
  pastHero: boolean;
} {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (typeof IntersectionObserver === "undefined") return;
    const target =
      document.querySelector<HTMLElement>(`[${HERO_MARKER_ATTR}]`) ?? sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) setPastHero(!latest.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);

  return { sentinelRef, pastHero: enabled && pastHero };
}
