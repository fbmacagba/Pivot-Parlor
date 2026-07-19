import type { CSSProperties, ReactNode } from "react";
import type { RevealStyle } from "@repo/utils";
import { useReveal } from "./useReveal";

/** Scroll-reveal wrapper for v3 sections. `enabled` false renders children
 *  with no wrapper at all, keeping the motion-off path byte-identical to an
 *  unwrapped render. Stagger applies only on "lively" (capped at 6 steps). */
export function Reveal({
  enabled,
  style,
  index,
  lively,
  children,
}: {
  enabled: boolean;
  style: RevealStyle;
  index: number;
  lively: boolean;
  children: ReactNode;
}) {
  const ref = useReveal(enabled);
  if (!enabled) return <>{children}</>;
  const delay = lively ? `${Math.min(index, 6) * 90}ms` : "0ms";
  return (
    <div
      ref={ref}
      className={`st-reveal-wrap st-reveal--${style}`}
      style={{ "--st-reveal-delay": delay } as CSSProperties}
    >
      {children}
    </div>
  );
}
