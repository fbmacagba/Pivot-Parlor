import { Download } from "lucide-react";
import { requestInstall, useInstallMode } from "~/lib/installPrompt";

/**
 * Discoverable install entry for the shop's PWA. Two looks: a full-width
 * `row` for the shop mobile menu and an outlined `chip` for the booking
 * confirmation screen. Renders nothing on the server, on browsers that never
 * offered to install, and once installed, so no page changes shape unless
 * the device can actually act on it. Uses only --st-* tokens.
 */
export function InstallAppButton({
  shopName,
  look,
  onActivate,
  className = "",
}: {
  shopName: string;
  look: "row" | "chip";
  /** Runs before the install flow starts (the menu passes its close handler). */
  onActivate?: () => void;
  className?: string;
}) {
  const mode = useInstallMode();
  if (mode !== "native" && mode !== "ios") return null;

  const label = look === "row" ? "Install this shop's app" : `Add ${shopName} to your home screen`;
  const base =
    look === "row"
      ? "flex min-h-12 w-full items-center gap-3 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)] transition active:scale-[0.98]"
      : "inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--st-r-md)] border border-[color:var(--st-line-40)] px-5 text-sm font-semibold text-[color:var(--st-ink-90)] transition active:scale-[0.98]";

  return (
    <button
      type="button"
      className={className ? `${base} ${className}` : base}
      onClick={() => {
        onActivate?.();
        requestInstall();
      }}
    >
      <Download className="h-5 w-5 shrink-0 text-[color:var(--st-accent-text)]" aria-hidden />
      <span>{label}</span>
    </button>
  );
}
