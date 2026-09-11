/** InstallAppButton: nothing on the server or on non-installable devices; a
 *  labelled button that triggers the shared install flow otherwise. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("lucide-react", () => ({ Download: () => null }));

const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function fakePromptEvent() {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome: "accepted" as const });
  return ev;
}

async function load() {
  vi.resetModules();
  const store = await import("~/lib/installPrompt");
  const { InstallAppButton } = await import("./InstallAppButton");
  return { store, InstallAppButton };
}

describe("InstallAppButton", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(window.navigator, "userAgent", { value: CHROME_UA, configurable: true });
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
  });

  it("renders nothing in SSR markup", async () => {
    const { InstallAppButton } = await load();
    expect(renderToStaticMarkup(<InstallAppButton shopName="Test Shop" look="row" />)).toBe("");
    expect(renderToStaticMarkup(<InstallAppButton shopName="Test Shop" look="chip" />)).toBe("");
  });

  it("renders nothing on a device that cannot install", async () => {
    const { InstallAppButton } = await load();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="row" />));
    expect(container.innerHTML).toBe("");
  });

  it("row: appears once a prompt is captured, calls onActivate then prompts", async () => {
    const { InstallAppButton } = await load();
    const ev = fakePromptEvent();
    const onActivate = vi.fn();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="row" onActivate={onActivate} />));
    act(() => {
      window.dispatchEvent(ev);
    });
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Install this shop's app");
    expect(btn.className).toContain("min-h-12");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("chip: names the shop and takes an extra class", async () => {
    const { InstallAppButton } = await load();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="chip" className="mt-6" />));
    act(() => {
      window.dispatchEvent(fakePromptEvent());
    });
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Add Test Shop to your home screen");
    expect(btn.className).toContain("mt-6");
    expect(btn.className).toContain("active:scale-[0.98]");
  });
});
