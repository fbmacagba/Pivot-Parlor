/** InstallAppPrompt: unprompted invitation (delayed, once per device) plus the
 *  on-demand iOS guide opened by the install surfaces. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { Download: Icon, Share: Icon, SquarePlus: Icon, X: Icon };
});
vi.mock("~/lib/shop-match", () => ({
  useShopMatch: () => ({ slug: "test-shop", name: "Test Shop" }),
}));

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

async function mount() {
  vi.resetModules();
  const store = await import("~/lib/installPrompt");
  const { InstallAppPrompt } = await import("./InstallAppPrompt");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<InstallAppPrompt />));
  return { store, root, container };
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!btn) throw new Error(`no button containing "${text}"`);
  return btn;
}

describe("InstallAppPrompt", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setUserAgent(CHROME_UA);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("renders nothing when the device cannot install", async () => {
    ({ root, container } = await mount());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container!.innerHTML).toBe("");
  });

  it("invites after the delay once a prompt is captured, and Not now is remembered", async () => {
    const m = await mount();
    ({ root, container } = m);
    act(() => {
      window.dispatchEvent(fakePromptEvent("accepted"));
    });
    expect(container!.innerHTML).toBe("");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(container!.textContent).toContain("Get the Test Shop app");
    expect(container!.textContent).toContain("Install app");
    click(buttonByText(container!, "Not now"));
    expect(container!.innerHTML).toBe("");
    expect(localStorage.getItem("pp-install-dismissed")).not.toBeNull();
  });

  it("does not invite again once dismissed, but the on-demand guide still opens", async () => {
    setUserAgent(IOS_UA);
    localStorage.setItem("pp-install-dismissed", "2026-09-01T00:00:00.000Z");
    const m = await mount();
    ({ root, container } = m);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container!.innerHTML).toBe("");
    act(() => {
      m.store.openInstallGuide();
    });
    expect(container!.textContent).toContain("Add to Home Screen");
    click(buttonByText(container!, "Got it"));
    expect(container!.innerHTML).toBe("");
    expect(m.store.isInstallGuideOpen()).toBe(false);
  });

  it("Install app runs the native prompt", async () => {
    const m = await mount();
    ({ root, container } = m);
    const ev = fakePromptEvent("accepted");
    act(() => {
      window.dispatchEvent(ev);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    click(buttonByText(container!, "Install app"));
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    // Flush the prompt's promise continuations inside act so React's
    // "update not wrapped in act" warning cannot fire after the test ends.
    await act(async () => {});
  });

  it("declining the native dialog counts as Not now", async () => {
    const m = await mount();
    ({ root, container } = m);
    const ev = fakePromptEvent("dismissed");
    act(() => {
      window.dispatchEvent(ev);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(container!.textContent).toContain("Install app");
    click(buttonByText(container!, "Install app"));
    await act(async () => {});
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("pp-install-dismissed")).not.toBeNull();
    expect(container!.innerHTML).toBe("");
  });
});
