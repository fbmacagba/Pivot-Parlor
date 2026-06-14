// Site-regeneration progress row for the developer "Shops" dashboard.
// Extracted from dev.shops.tsx (T7.7) — no behavior change.
import { Check, Circle, Loader2, XCircle } from "lucide-react";
import type { RegenStepUiState } from "./types";

export function RegenStepRow({
  label,
  state,
  index,
}: {
  label: string;
  state: RegenStepUiState;
  index: number;
}) {
  const icon =
    state === "done" ? (
      <Check className="h-4 w-4 shrink-0 text-emerald-400" strokeWidth={2.5} aria-hidden />
    ) : state === "active" ? (
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gold" aria-hidden />
    ) : state === "failed" ? (
      <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
    ) : (
      <Circle className="h-4 w-4 shrink-0 text-white/25" aria-hidden />
    );

  const labelClass =
    state === "pending"
      ? "text-white/45"
      : state === "active"
        ? "text-white"
        : state === "failed"
          ? "text-red-200"
          : "text-white/90";

  return (
    <li
      className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-[opacity,transform,border-color] duration-300 ease-out"
      style={{ transitionDelay: `${Math.min(index, 6) * 45}ms` }}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <span className={`text-sm leading-snug ${labelClass}`}>{label}</span>
    </li>
  );
}
