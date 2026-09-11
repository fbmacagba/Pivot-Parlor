import { useSyncExternalStore } from "react";

/**
 * Install capability for the per-shop PWA, shared by every install surface
 * (root InstallAppPrompt invitation, the shop mobile-menu row, the booking
 * confirmation chip). Chromium fires `beforeinstallprompt` ONCE, early; the
 * listener below registers when this module first evaluates in the browser,
 * which is earlier than any component effect, so the event is captured even
 * if it fires before hydration finishes. iOS Safari has no install API, so
 * "ios" means "show the Share -> Add to Home Screen walkthrough".
 *
 * Standing decisions honoured here: no service worker; no platform-mimicking
 * UI; the per-shop manifest already makes the shop the installed app.
 */

export type InstallMode = "unavailable" | "native" | "ios" | "installed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let guideOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const query =
    typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)") : null;
  return (
    query?.matches === true ||
    // iOS Safari's pre-standard flag
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as macOS but is the only Mac with touch
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIos && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** Current install mode, computed from the environment on every call (cheap,
 *  and the string result is stable by value for useSyncExternalStore). */
export function getInstallMode(): InstallMode {
  if (typeof window === "undefined") return "unavailable";
  if (installed || isStandalone()) return "installed";
  if (deferred) return "native";
  if (isIosSafari()) return "ios";
  return "unavailable";
}

export function isInstallGuideOpen(): boolean {
  return guideOpen;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openInstallGuide(): void {
  guideOpen = true;
  emit();
}

export function closeInstallGuide(): void {
  guideOpen = false;
  emit();
}

/** Show the browser's native install dialog. Chromium allows one prompt() per
 *  captured event, so the event is consumed up front whatever the outcome. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") installed = true;
  emit();
  return outcome;
}

/** The one call install surfaces make: native prompt where captured, the iOS
 *  walkthrough otherwise, nothing when the device cannot install. */
export function requestInstall(): void {
  const mode = getInstallMode();
  if (mode === "native") void promptInstall();
  else if (mode === "ios") openInstallGuide();
}

const serverMode = (): InstallMode => "unavailable";
const serverGuide = (): boolean => false;

export function useInstallMode(): InstallMode {
  return useSyncExternalStore(subscribeInstall, getInstallMode, serverMode);
}

export function useInstallGuideOpen(): boolean {
  return useSyncExternalStore(subscribeInstall, isInstallGuideOpen, serverGuide);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}
