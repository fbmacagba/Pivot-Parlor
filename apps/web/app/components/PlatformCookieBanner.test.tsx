/** PlatformCookieBanner: the platform's informational cookie notice. Real
 *  route matching (createRoutesStub), so which pages count as a shop's is
 *  decided exactly as in the app. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub, useNavigate } from "react-router";
import { PlatformCookieBanner } from "./PlatformCookieBanner";
import { COOKIE_NOTICE_HEIGHT_VAR, isCookieNoticeOpen } from "~/lib/cookieNoticeLayer";

const KEY = "pp_platform_consent";

function Page() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" data-testid="to-shop" onClick={() => navigate("/test-shop")}>
        Visit a shop
      </button>
      <PlatformCookieBanner />
    </>
  );
}

const Stub = createRoutesStub([
  { path: "/", Component: Page },
  { path: "/dpa", Component: Page },
  { path: "/verify-email", Component: Page },
  { path: "/pay/done", Component: Page },
  { path: "/:shopSlug", Component: Page },
]);

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Stub initialEntries={[path]} />);
  });
  return container;
}

function notice(): HTMLElement | null {
  return document.querySelector('[aria-label="Cookie notice"]');
}

function gotIt(): HTMLButtonElement {
  const btn = Array.from(notice()?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === "Got it");
  if (!btn) throw new Error("no Got it button");
  return btn;
}

function pressEscape(target: EventTarget = document.body) {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(ev);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.querySelectorAll("[data-test-dialog]").forEach((n) => n.remove());
  localStorage.clear();
  document.documentElement.style.removeProperty(COOKIE_NOTICE_HEIGHT_VAR);
  delete document.documentElement.dataset.cookieNotice;
  vi.restoreAllMocks();
});

describe("PlatformCookieBanner", () => {
  it.each(["/", "/dpa", "/verify-email", "/pay/done"])("shows on the platform page %s", async (path) => {
    await mount(path);
    expect(notice()).not.toBeNull();
    expect(isCookieNoticeOpen()).toBe(true);
  });

  it("stays off a shop's pages, which carry their own notice", async () => {
    await mount("/test-shop");
    expect(notice()).toBeNull();
    expect(isCookieNoticeOpen()).toBe(false);
  });

  it("stays off once acknowledged", async () => {
    localStorage.setItem(KEY, JSON.stringify({ decided: true, timestamp: "2026-11-16T00:00:00.000Z" }));
    await mount("/");
    expect(notice()).toBeNull();
  });

  it("Got it records the acknowledgement, closes, and frees the space it held", async () => {
    await mount("/");
    act(() => gotIt().click());
    expect(notice()).toBeNull();
    // The shop notice and the E2E helper read this exact shape.
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").decided).toBe(true);
    expect(isCookieNoticeOpen()).toBe(false);
    expect(document.documentElement.style.getPropertyValue(COOKIE_NOTICE_HEIGHT_VAR)).toBe("");
  });

  it("publishes its rendered height so the floating controls can stand clear", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 660, width: 390, height: 184, top: 660, right: 390, bottom: 844, left: 0, toJSON: () => ({}),
    } as DOMRect);
    await mount("/");
    expect(document.documentElement.style.getPropertyValue(COOKIE_NOTICE_HEIGHT_VAR)).toBe("184px");
  });

  it("closes when the visitor moves on to a shop's page", async () => {
    await mount("/");
    expect(notice()).not.toBeNull();
    await act(async () => {
      (document.querySelector('[data-testid="to-shop"]') as HTMLButtonElement).click();
    });
    expect(notice()).toBeNull();
    expect(isCookieNoticeOpen()).toBe(false);
  });

  it("frees its space when it unmounts", async () => {
    await mount("/");
    expect(isCookieNoticeOpen()).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(isCookieNoticeOpen()).toBe(false);
  });

  it("Escape closes it like Got it when nothing else is open", async () => {
    await mount("/");
    pressEscape();
    expect(notice()).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").decided).toBe(true);
  });

  it("leaves Escape to an open dialog, such as Pip or the install invitation", async () => {
    await mount("/");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-dialog", "");
    document.body.appendChild(dialog);
    pressEscape(dialog);
    expect(notice()).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("leaves Escape to a dialog that closes itself on that same key press", async () => {
    // Pip's own Escape handler closes it, and React removes the panel before
    // a later listener in the same key press runs. The notice must still
    // know a dialog had the key.
    await mount("/");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-test-dialog", "");
    dialog.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") dialog.remove();
    });
    document.body.appendChild(dialog);
    pressEscape(dialog);
    expect(document.querySelector("[data-test-dialog]")).toBeNull();
    expect(notice()).not.toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("leaves an Escape that something else already handled", async () => {
    await mount("/");
    const field = document.createElement("input");
    field.setAttribute("data-test-dialog", "");
    field.addEventListener("keydown", (e) => e.preventDefault());
    document.body.appendChild(field);
    pressEscape(field);
    expect(notice()).not.toBeNull();
  });

  it("does not take the page's gold primary style", async () => {
    await mount("/");
    expect(gotIt().className).not.toMatch(/\bbg-gold\b/);
  });
});
