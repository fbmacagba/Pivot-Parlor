import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";

/**
 * Centered "install the app" invitation, shown once per device until
 * dismissed or installed.
 *
 * - Chromium (Android/desktop): captures `beforeinstallprompt` and triggers
 *   the native install dialog from the Install button.
 * - iOS/iPadOS Safari: no install API exists, so the modal shows the
 *   two-step Share -> Add to Home Screen walkthrough instead.
 *
 * Dismissal ("Not now", backdrop tap or the close button) is remembered in
 * localStorage. Renders nothing during SSR and in installed (standalone)
 * mode. Appears after a short delay so it never competes with first paint.
 */

const DISMISS_KEY = "pp-install-dismissed";
const SHOW_DELAY_MS = 1500;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's pre-standard flag
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as macOS but is the only Mac with touch
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIos && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export function InstallAppPrompt() {
  const [mode, setMode] = useState<"hidden" | "native" | "ios">("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  );

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    if (isIosSafari()) {
      timer = setTimeout(() => setMode("ios"), SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }

    function onPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      timer = setTimeout(() => setMode("native"), SHOW_DELAY_MS);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    // If the browser never fires the event (unsupported, or already
    // installed), the invitation simply never appears.
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      if (timer) clearTimeout(timer);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setMode("hidden");
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    if (choice.outcome === "accepted") {
      setMode("hidden");
    } else {
      // Declining the native dialog counts as "not now".
      dismiss();
    }
  }

  if (mode === "hidden") return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={dismiss}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-install-title"
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
          Get the Pivot Parlor app
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Add it to your home screen for a faster, full-screen experience.
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
