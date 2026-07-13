import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";

/**
 * Floating "Install app" pill, shown until the app runs standalone.
 *
 * - Chromium (Android/desktop): captures `beforeinstallprompt` and triggers
 *   the native install dialog on tap.
 * - iOS/iPadOS Safari: no install API exists, so the tap opens a short
 *   "Share -> Add to Home Screen" walkthrough instead.
 *
 * Dismissal is remembered in localStorage. Renders nothing during SSR and in
 * installed (standalone) mode.
 */

const DISMISS_KEY = "pp-install-dismissed";

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
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISS_KEY)) return;

    if (isIosSafari()) {
      setMode("ios");
      return;
    }

    function onPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("native");
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    // If the browser never fires the event (unsupported, or already
    // installed), the pill simply never appears.
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setMode("hidden");
    setShowIosSteps(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") {
      setMode("hidden");
    }
    setDeferred(null);
  }

  if (mode === "hidden") return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {showIosSteps && (
        <div className="w-72 rounded-xl border border-white/10 bg-[#141414] p-4 shadow-2xl">
          <p className="text-sm font-semibold text-white">
            Add to your home screen
          </p>
          <ol className="mt-2 space-y-2 text-sm text-white/70">
            <li className="flex items-center gap-2">
              <Share className="h-4 w-4 shrink-0 text-gold" />
              <span>
                Tap the <strong className="text-white">Share</strong> button in
                Safari
              </span>
            </li>
            <li className="flex items-center gap-2">
              <SquarePlus className="h-4 w-4 shrink-0 text-gold" />
              <span>
                Choose{" "}
                <strong className="text-white">Add to Home Screen</strong>
              </span>
            </li>
          </ol>
          <p className="mt-2 text-xs text-white/40">
            The app then opens full screen from its own icon.
          </p>
        </div>
      )}
      <div className="flex items-center gap-1 rounded-full border border-gold/30 bg-[#141414]/95 p-1 pl-1 shadow-2xl backdrop-blur">
        <button
          type="button"
          onClick={
            mode === "native" ? install : () => setShowIosSteps((v) => !v)
          }
          className="flex items-center gap-2 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-dark transition-colors hover:bg-gold/90"
        >
          <Download className="h-4 w-4" />
          Install app
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="rounded-full p-2 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
