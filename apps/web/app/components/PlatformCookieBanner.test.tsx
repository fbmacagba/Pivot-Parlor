/** PlatformCookieBanner: the platform's cookie notice, a floating card with
 *  two equal choices. Real route matching (createRoutesStub), so which pages
 *  count as a shop's is decided exactly as in the app. */
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

function choice(name: "Accept" | "Essential only"): HTMLButtonElement {
  const btn = Array.from(notice()?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === name);
  if (!btn) throw new Error(`no ${name} button`);
  return btn;
}

function stored(): { decided?: boolean; choice?: string } {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}");
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

  it("names itself with a heading, not only an accessible label", async () => {
    await mount("/");
    expect(notice()?.querySelector("h2")?.textContent?.trim()).toBe("Cookies");
  });

  it("offers Essential only and Accept as equals: same look, neither gold-filled", async () => {
    await mount("/");
    const essential = choice("Essential only");
    const accept = choice("Accept");
    // Declining is as easy and as prominent as accepting (ICO cookie guidance).
    expect(accept.className).toBe(essential.className);
    // The page's one gold fill stays the page's own action.
    expect(accept.className.split(/\s+/)).not.toContain("bg-gold");
  });

  it("links to the cookie policy as a control of its own, not a word in the sentence", async () => {
    await mount("/");
    const link = notice()?.querySelector('a[href="/cookies"]');
    expect(link?.textContent?.trim()).toBe("Cookie policy");
    expect(link?.closest("p")).toBeNull();
  });

  it.each([
    ["Accept", "accept"],
    ["Essential only", "essential"],
  ] as const)("%s records the choice, closes, and frees the space it held", async (name, recorded) => {
    await mount("/");
    act(() => choice(name).click());
    expect(notice()).toBeNull();
    // The shop notice and the E2E helper read `decided`.
    expect(stored()).toMatchObject({ decided: true, choice: recorded });
    expect(isCookieNoticeOpen()).toBe(false);
    expect(document.documentElement.style.getPropertyValue(COOKIE_NOTICE_HEIGHT_VAR)).toBe("");
  });

  it("publishes the space it takes from the bottom edge, margin included", async () => {
    // A floating card ends above the screen's bottom edge: what the floating
    // controls must clear is everything from its top down, not its height.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 12, y: 560, width: 366, height: 184, top: 560, right: 378, bottom: 744, left: 12, toJSON: () => ({}),
    } as DOMRect);
    await mount("/");
    expect(window.innerHeight - 560).toBe(208);
    expect(document.documentElement.style.getPropertyValue(COOKIE_NOTICE_HEIGHT_VAR)).toBe("208px");
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

  it("Escape closes it as Essential only when nothing else is open, never as Accept", async () => {
    await mount("/");
    pressEscape();
    expect(notice()).toBeNull();
    expect(stored()).toMatchObject({ decided: true, choice: "essential" });
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
});
