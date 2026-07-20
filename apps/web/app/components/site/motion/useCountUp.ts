import { useEffect, useRef, useState } from "react";

/** Counts a stat up from zero the first time it scrolls into view. SSR and
 *  no-JS render the final value (state starts at `target`); the zeroing +
 *  animation happen only client-side, and only when `enabled` and motion is
 *  not reduced. */
export function useCountUp(target: number, enabled: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(target);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === "undefined") {
      setValue(target);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    setValue(0);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const started = performance.now();
        const dur = 900;
        const tick = (now: number) => {
          const t = Math.min(1, (now - started) / dur);
          setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [target, enabled]);
  return { ref, value };
}
