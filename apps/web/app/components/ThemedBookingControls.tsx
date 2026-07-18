// apps/web/app/components/ThemedBookingControls.tsx
// Palette-var-driven controls for the public booking journey (/book, /confirm,
// /waitlist). The shared ui/Button and ui/Input hardcode the PLATFORM brand
// (gold/dark + [color-scheme:dark]) and are used by every dashboard, so the
// shop-themed journey gets its own local equivalents instead: colors come from
// the --st-* tokens resolveSiteTheme() produces (via CommercialShopChrome for
// live-site shops, or the platform fallback below for shops with no site).
import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";
import * as React from "react";
import { resolveSiteTheme } from "@repo/utils";

/**
 * Tokens reproducing today's platform-branded wizard exactly for shops with
 * no generated site: the legacy theme path with the platform's own colors,
 * plus two pixel-exactness overrides (the legacy tokens derive --st-card as
 * rgba(white,.04) and --st-field as rgba(black,.25), where the wizard has
 * always used #1a1a1a cards and white/5 fields).
 */
export const platformFallbackVars: React.CSSProperties = {
  ...resolveSiteTheme({ color_primary: "#0D0D0D", color_accent: "#C9A84C" }).vars,
  "--st-card": "#1a1a1a",
  "--st-field": "rgba(255, 255, 255, 0.05)",
  // The fallback is always the dark platform look; native control chrome
  // (date pickers) must follow it now that ThemedInput carries no hardcoded
  // [color-scheme:dark].
  colorScheme: "dark",
} as React.CSSProperties;

/**
 * Scheme-aware color for semantic status text (warnings, errors) that sits on
 * the shop's themed background. Uses CSS light-dark(), which follows the
 * wrapper's color-scheme (the shop's resolved scheme under the chrome, dark in
 * the platform fallback). Pair with a Tailwind class carrying the dark-scheme
 * color: browsers without light-dark() drop the inline declaration and fall
 * back to the class, i.e. exactly today's dark-theme rendering.
 */
export function lightDark(light: string, dark: string): React.CSSProperties {
  return { color: `light-dark(${light}, ${dark})` };
}

// ─── Button ───────────────────────────────────────────────────────────────────

export interface ThemedButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
  size?: "default" | "lg";
  asChild?: boolean;
}

const ThemedButton = React.forwardRef<HTMLButtonElement, ThemedButtonProps>(
  ({ className, variant = "primary", size = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={clsx(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:pointer-events-none disabled:opacity-50",
          // Hover lightens and active darkens the BACKGROUND only (matching
          // ui/Button's gold-light/gold-dark behavior) relative to whatever
          // the shop's accent is; unsupported browsers drop the color-mix
          // declarations and simply lose hover feedback.
          variant === "primary" &&
            "bg-[color:var(--color-accent)] font-semibold text-[color:var(--st-on-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_75%,white)] active:bg-[color:color-mix(in_srgb,var(--color-accent)_85%,black)]",
          variant === "ghost" &&
            "text-[color:var(--st-ink)] hover:bg-[color:var(--st-chip)]",
          size === "default" && "h-10 px-5 py-2",
          size === "lg" && "h-12 px-8 text-base",
          className
        )}
        {...props}
      />
    );
  }
);
ThemedButton.displayName = "ThemedButton";

// ─── Input ────────────────────────────────────────────────────────────────────

export interface ThemedInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

const themedFieldClasses =
  "flex w-full rounded-lg border border-[color:var(--st-line-40)] bg-[color:var(--st-field)] px-3 py-2 text-sm text-[color:var(--st-ink)] placeholder:text-[color:var(--st-ink-60)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:border-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50";

const ThemedInput = React.forwardRef<HTMLInputElement, ThemedInputProps>(
  ({ className, type, label, id, ...props }, ref) => {
    // Same id-from-label derivation as ui/Input — the e2e suite's getByLabel
    // selectors depend on this exact htmlFor/id association.
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-[color:var(--st-ink-80)]">
            {label}
          </label>
        )}
        <input
          id={inputId}
          type={type}
          ref={ref}
          // No [color-scheme:dark]: the wrapper's colorScheme (from the shop's
          // resolved palette, or dark in the platform fallback) must drive
          // native date-picker chrome so light-palette shops render light.
          className={clsx("h-10", themedFieldClasses, className)}
          {...props}
        />
      </div>
    );
  }
);
ThemedInput.displayName = "ThemedInput";

// ─── Textarea ─────────────────────────────────────────────────────────────────

export interface ThemedTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

const ThemedTextarea = React.forwardRef<HTMLTextAreaElement, ThemedTextareaProps>(
  ({ className, label, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-[color:var(--st-ink-80)]">
            {label}
          </label>
        )}
        <textarea
          id={inputId}
          ref={ref}
          className={clsx(themedFieldClasses, "resize-none", className)}
          {...props}
        />
      </div>
    );
  }
);
ThemedTextarea.displayName = "ThemedTextarea";

export { ThemedButton, ThemedInput, ThemedTextarea };
