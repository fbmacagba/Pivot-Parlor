import { useEffect, useRef } from "react";

/** Slow scroll drift for hero/signature imagery: at most +-`max` px, driven
 *  by one passive scroll listener + rAF per host. `baseTransform` preserves a
 *  class-based transform (e.g. "scale(1.05)") the inline style would clobber.
 *  No-ops when disabled and under prefers-reduced-motion. */
export function useParallax<T extends HTMLElement>(
  enabled: boolean,
  max = 14,
  baseTransform = "",
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const progress = Math.min(1, Math.max(-1, (rect.top + rect.height / 2 - vh / 2) / vh));
        el.style.transform = `${baseTransform} translateY(${(-progress * max).toFixed(1)}px)`.trim();
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = "";
    };
  }, [enabled, max, baseTransform]);
  return ref;
}
