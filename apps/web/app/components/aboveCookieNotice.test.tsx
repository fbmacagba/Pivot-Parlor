/** The fixed controls along the bottom of platform pages stand clear of an
 *  open cookie notice (WCAG 2.2 SC 2.4.11: a focused control is never hidden
 *  under it). jsdom does not lay out, so this pins the offsets each layer
 *  uses; the E2E spec cookie-bar.spec.ts proves the geometry in a browser. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { ABOVE_COOKIE_NOTICE } from "~/lib/cookieNoticeLayer";
import { FloatingCTA } from "./marketing/FloatingCTA";
import { MarketingChatbot } from "./marketing/MarketingChatbot";
import { MobileTabBar } from "./dashboards/MobileTabBar";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(Component: ComponentType, path = "/") {
  const Stub = createRoutesStub([{ path: "*", Component }]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Stub initialEntries={[path]} />);
  });
  return container;
}

function classesOf(el: Element | null | undefined): string[] {
  if (!el) throw new Error("element not rendered");
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  document.documentElement.style.removeProperty("--pp-cookie-notice-h");
  delete document.documentElement.dataset.cookieNotice;
});

describe("Pip's teaser is one interruption at a time", () => {
  it("waits while a cookie notice is open, and appears once it closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const layer = await import("~/lib/cookieNoticeLayer");
    act(() => layer.publishCookieNotice("platform", 176));
    const c = await mount(MarketingChatbot);

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    // Lifted above the notice it would cover the hero's sign-up button.
    expect(c.querySelector('button[aria-label="Dismiss"]')).toBeNull();

    act(() => layer.publishCookieNotice("platform", null));
    expect(c.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
  });

  it("still never appears once the chat has been opened", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const layer = await import("~/lib/cookieNoticeLayer");
    act(() => layer.publishCookieNotice("platform", 176));
    const c = await mount(MarketingChatbot);
    act(() => {
      (c.querySelector('button[aria-label="Chat with Pip"]') as HTMLButtonElement).click();
    });
    act(() => {
      (c.querySelector('button[aria-label="Close chat"]') as HTMLButtonElement).click();
    });
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    act(() => layer.publishCookieNotice("platform", null));
    expect(c.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  });
});

describe("fixed controls stand clear of the cookie notice", () => {
  it("the floating sign-up button", async () => {
    const c = await mount(FloatingCTA);
    const link = c.querySelector('a[aria-label="Get your shop on Pivot"]');
    expect(classesOf(link)).toContain(ABOVE_COOKIE_NOTICE.bottom6);
    expect(classesOf(link)).not.toContain("bottom-6");
  });

  it("Pip's launcher, teaser and chat window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = await mount(MarketingChatbot);

    const launcher = c.querySelector('button[aria-label="Chat with Pip"]')?.parentElement;
    expect(classesOf(launcher)).toContain(ABOVE_COOKIE_NOTICE.bottom6);
    expect(classesOf(launcher)).not.toContain("bottom-6");

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const dismissTeaser = c.querySelector('button[aria-label="Dismiss"]');
    const teaser = dismissTeaser?.parentElement?.parentElement;
    expect(classesOf(teaser)).toContain(ABOVE_COOKIE_NOTICE.bottom24);
    expect(classesOf(teaser)).not.toContain("bottom-24");

    act(() => {
      (c.querySelector('button[aria-label="Chat with Pip"]') as HTMLButtonElement).click();
    });
    const chat = c.querySelector("[data-pip-chat]");
    // Phone: a full-screen sheet whose bottom edge (the message field) sits
    // above the notice. Wider: the floating panel above the launcher.
    expect(classesOf(chat)).toContain(ABOVE_COOKIE_NOTICE.bottom0);
    expect(classesOf(chat)).toContain(ABOVE_COOKIE_NOTICE.smBottom24);
    expect(classesOf(chat)).not.toContain("sm:bottom-24");
  });

  it("the dashboards' phone tab bar", async () => {
    const Bar = () => <MobileTabBar role="admin" onMore={() => {}} />;
    const c = await mount(Bar, "/admin");
    const nav = c.querySelector('nav[aria-label="Primary"]');
    expect(classesOf(nav)).toContain(ABOVE_COOKIE_NOTICE.bottom0);
    expect(classesOf(nav)).not.toContain("bottom-0");
  });
});
