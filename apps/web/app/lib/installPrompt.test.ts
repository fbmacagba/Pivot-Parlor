/** installPrompt store: captures beforeinstallprompt at module load, reports
 *  the device's install mode, drives the native prompt and the iOS guide. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Store = typeof import("./installPrompt");

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

function fakePromptEvent(outcome: "accepted" | "dismissed") {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome });
  return ev;
}

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("./installPrompt");
}

describe("installPrompt store", () => {
  beforeEach(() => {
    setUserAgent(CHROME_UA);
  });
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("starts unavailable on a browser that has not offered to install", async () => {
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("unavailable");
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("captures beforeinstallprompt (preventing the default mini-infobar) and reports native", async () => {
    const store = await freshStore();
    const seen = vi.fn();
    store.subscribeInstall(seen);
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(store.getInstallMode()).toBe("native");
    expect(seen).toHaveBeenCalled();
  });

  it("promptInstall shows the native dialog once; accepting flips to installed", async () => {
    const store = await freshStore();
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    await expect(store.promptInstall()).resolves.toBe("accepted");
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(store.getInstallMode()).toBe("installed");
    await expect(store.promptInstall()).resolves.toBe("unavailable");
  });

  it("a dismissed native dialog consumes the event and returns to unavailable", async () => {
    const store = await freshStore();
    window.dispatchEvent(fakePromptEvent("dismissed"));
    await expect(store.promptInstall()).resolves.toBe("dismissed");
    expect(store.getInstallMode()).toBe("unavailable");
  });

  it("reports ios on iPhone Safari and requestInstall opens the guide there", async () => {
    setUserAgent(IOS_UA);
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("ios");
    store.requestInstall();
    expect(store.isInstallGuideOpen()).toBe(true);
    store.closeInstallGuide();
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("requestInstall prompts natively when a prompt was captured", async () => {
    const store = await freshStore();
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    store.requestInstall();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("reports installed when already running standalone", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true }),
      configurable: true,
      writable: true,
    });
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("installed");
  });

  it("appinstalled flips to installed", async () => {
    const store = await freshStore();
    window.dispatchEvent(fakePromptEvent("accepted"));
    window.dispatchEvent(new Event("appinstalled"));
    expect(store.getInstallMode()).toBe("installed");
  });
});
