import { useEffect, useRef } from "react";

let sharedObserver: IntersectionObserver | null = null;
const onReveal = new WeakMap<Element, () => void>();

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          onReveal.get(entry.target)?.();
          onReveal.delete(entry.target);
          sharedObserver?.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
  }
  return sharedObserver;
}

/** One shared IntersectionObserver for every reveal on the page. The hidden
 *  state (.st-reveal) is added only from this effect — never in SSR markup —
 *  so no-JS visitors always see content. Revealed once, then unobserved. */
export function useReveal(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const observer = getObserver();
    if (!observer) {
      el.classList.add("is-revealed");
      return;
    }
    el.classList.add("st-reveal");
    onReveal.set(el, () => el.classList.add("is-revealed"));
    observer.observe(el);
    return () => {
      onReveal.delete(el);
      observer.unobserve(el);
    };
  }, [enabled]);
  return ref;
}
