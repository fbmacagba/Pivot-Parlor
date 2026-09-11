import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { useShopMatch } from "~/lib/shop-match";
import { useModalA11y } from "~/lib/useModalA11y";
import {
  closeInstallGuide,
  promptInstall,
  useInstallGuideOpen,
  useInstallMode,
} from "~/lib/installPrompt";

/**
 * Centered "install the app" dialog with two ways in:
 *
 * 1. The unprompted invitation: shown once per device (until dismissed or
 *    installed), after a short delay so it never competes with first paint.
 *    Chromium shows an Install button (native prompt); iOS/iPadOS Safari has
 *    no install API, so it shows the Share -> Add to Home Screen walkthrough.
 * 2. On demand: the shop menu's "Install this shop's app" row and the
 *    booking-confirmation chip call requestInstall(); on iOS that opens this
 *    dialog in walkthrough form immediately, ignoring any earlier "Not now".
 *
 * Install capability itself (event capture, mode detection, the prompt) lives
 * in lib/installPrompt so every surface shares one captured event. Renders
 * nothing during SSR and in installed (standalone) mode.
 */

const DISMISS_KEY = "pp-install-dismissed";
const SHOW_DELAY_MS = 1500;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) !== null;
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
  } catch {
    /* storage blocked: the invitation simply shows again next visit */
  }
}

export function InstallAppPrompt() {
  // On a shop site the install captures the SHOP's app (per-shop manifest),
  // so the invitation carries the shop's name, not the platform's.
  const shop = useShopMatch();
  const mode = useInstallMode();
  const guideOpen = useInstallGuideOpen();
  const [invite, setInvite] = useState(false);

  const installable = mode === "native" || mode === "ios";

  useEffect(() => {
    if (!installable || readDismissed()) return;
    const timer = setTimeout(() => setInvite(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [installable]);

  const open = guideOpen || (invite && installable);

  function rememberNotNow() {
    writeDismissed();
    setInvite(false);
  }

  function dismiss() {
    // Only the unprompted invitation is remembered; closing the on-demand
    // guide must not silence a future explicit tap.
    if (invite) rememberNotNow();
    if (guideOpen) closeInstallGuide();
  }

  async function install() {
    const outcome = await promptInstall();
    // Declining the native dialog counts as "not now".
    if (outcome === "dismissed") rememberNotNow();
    if (guideOpen) closeInstallGuide();
  }

  // Focus trap, focus-in, Escape-to-close, scroll-lock and focus-restore.
  const dialogRef = useModalA11y<HTMLDivElement>({
    active: open,
    onClose: dismiss,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={dismiss}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-install-title"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#141414] p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install invitation"
          className="float-right -mr-2 -mt-2 rounded-full p-2 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        <img
          src="/icons/icon-192.png"
          alt=""
          className="mx-auto h-20 w-20 rounded-2xl border border-white/10"
        />
        <h2
          id="pp-install-title"
          className="mt-4 font-heading text-xl font-bold text-white"
        >
          Get the {shop?.name ?? "Pivot Parlor"} app
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          {shop
            ? `Add ${shop.name} to your home screen and book in one tap.`
            : "Add it to your home screen for a faster, full-screen experience."}
        </p>

        {mode === "native" ? (
          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={install}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gold px-4 py-3 text-sm font-semibold text-dark transition-colors hover:bg-gold/90"
            >
              <Download className="h-4 w-4" />
              Install app
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="w-full rounded-xl px-4 py-3 text-sm font-medium text-white/50 transition-colors hover:bg-white/5 hover:text-white"
            >
              Not now
            </button>
          </div>
        ) : (
          <div className="mt-5 text-left">
            <ol className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
              <li className="flex items-center gap-3">
                <Share className="h-4 w-4 shrink-0 text-gold" />
                <span>
                  Tap the <strong className="text-white">Share</strong> button
                  in Safari
                </span>
              </li>
              <li className="flex items-center gap-3">
                <SquarePlus className="h-4 w-4 shrink-0 text-gold" />
                <span>
                  Choose{" "}
                  <strong className="text-white">Add to Home Screen</strong>
                </span>
              </li>
            </ol>
            <button
              type="button"
              onClick={dismiss}
              className="mt-3 w-full rounded-xl bg-gold px-4 py-3 text-sm font-semibold text-dark transition-colors hover:bg-gold/90"
            >
              Got it
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
