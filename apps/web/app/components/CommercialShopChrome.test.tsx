(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** CommercialShopChrome SSR contract for the native-feel surfaces. Rendering
 *  with renderToStaticMarkup runs no effects, which is exactly the no-JS /
 *  pre-hydration markup real visitors get first. */
import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { MessageCircle: Icon, X: Icon, Download: Icon };
});

import { CHAT_TOKEN_WAIT_MS, CommercialShopChrome } from "./CommercialShopChrome";
import { TURNSTILE_SITE_KEY } from "./TurnstileWidget";

const site = { shop_id: "shop-1", shop_name: "Test Shop", tagline: "", design_version: 3 };

function render(props: Partial<ComponentProps<typeof CommercialShopChrome>> = {}) {
  return renderToStaticMarkup(
    <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop" {...props}>
      <main>content</main>
    </CommercialShopChrome>,
  );
}

/** The bar's own markup: from its root div through the end of its link. */
function barChunk(html: string): string {
  const start = html.indexOf('class="pp-bottom-bar md:hidden"');
  if (start < 0) return "";
  return html.slice(start, html.indexOf("</a>", start));
}

describe("CommercialShopChrome: mobile booking bar", () => {
  it("renders the bar hidden by default, plus the first-viewport sentinel", () => {
    const html = render();
    const bar = barChunk(html);
    expect(bar).not.toBe("");
    expect(bar).toContain('data-visible="false"');
    expect(bar).toContain('href="/test-shop/book"');
    expect(bar).toContain("Book now");
    expect(html).toContain("pp-bar-sentinel");
    expect(html).not.toContain("pp-bar-shown");
  });

  it("omits the bar entirely when bookingBar is false", () => {
    const html = render({ bookingBar: false });
    expect(html).not.toContain("pp-bottom-bar");
    expect(html).not.toContain("pp-bar-sentinel");
  });

  it("points the bar at services when booking is disabled", () => {
    const bar = barChunk(render({ settings: { booking_enabled: false } }));
    expect(bar).not.toBe("");
    expect(bar).toContain('href="/test-shop#services"');
    expect(bar).toContain("View services");
    expect(bar).not.toContain("/test-shop/book");
  });
});

describe("CommercialShopChrome: install row in the mobile menu", () => {
  it("shows the row only once the device can install, and closes the menu on tap", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
      configurable: true,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop">
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    const openMenu = container.querySelector('button[aria-label="Open menu"]')!;
    act(() => {
      openMenu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Install this shop's app");

    const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
    };
    ev.prompt = vi.fn(async () => {});
    ev.userChoice = Promise.resolve({ outcome: "accepted" as const });
    act(() => {
      window.dispatchEvent(ev);
    });
    const row = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Install this shop's app"),
    )!;
    expect(row).toBeTruthy();
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"][aria-label="Menu"]')).toBeNull();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await act(async () => {});

    act(() => root.unmount());
    container.remove();
  });
});

describe("CommercialShopChrome: safe areas", () => {
  it("pads the sticky header and positions the chat launcher through the shared classes", () => {
    const html = render();
    const headerTag = html.slice(html.indexOf("<header"), html.indexOf(">", html.indexOf("<header")));
    expect(headerTag).toContain("pp-safe-top");
    expect(headerTag).toContain("pp-safe-x");
    // The launcher's opening tag: class comes before aria-label in the JSX,
    // so take the whole <button ...> chunk that carries the label.
    const fabChunk = html.split("<button ").find((chunk) => chunk.includes('aria-label="Open chat"'))!;
    const fabTag = fabChunk.slice(0, fabChunk.indexOf(">"));
    expect(fabTag).toContain("pp-chat-fab");
    expect(fabTag).not.toContain("bottom-6");
    expect(fabTag).not.toContain("right-6");
  });

  it("opens the chat panel on the shared positioning class", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop">
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    act(() => {
      container.querySelector('button[aria-label="Open chat"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const panel = container.querySelector(".pp-chat-panel");
    expect(panel).toBeTruthy();
    expect(panel!.querySelector('button[aria-label="Close chat"]')).toBeTruthy();
    await act(async () => {});
    act(() => root.unmount());
    container.remove();
  });
});

describe("CommercialShopChrome: press feedback", () => {
  it("every accent-filled booking CTA in the server markup carries the press state", () => {
    const html = render();
    // Server markup holds four /book anchors: the desktop nav text link
    // "Book", the desktop "Book Now →" button, the mobile header "Book"
    // button, and the bottom bar. Only the accent-filled buttons are
    // primary CTAs; the nav text link is not one and needs no press state.
    const anchors = html.split("<a ").filter((chunk) => chunk.includes('href="/test-shop/book"'));
    expect(anchors.length).toBe(4);
    const tags = anchors.map((chunk) => chunk.slice(0, chunk.indexOf(">")));
    const primaries = tags.filter((tag) => tag.includes("bg-[color:var(--color-accent)]"));
    expect(primaries.length).toBe(3);
    for (const tag of primaries) expect(tag).toContain("active:scale-[0.98]");
  });
});

describe("CommercialShopChrome: booking bar and the mobile menu", () => {
  it("hides the bar and drops the launcher lift while the menu is open, and restores both on close", async () => {
    let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class MockIO {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    // A returning visitor: the cookie notice is already acknowledged (the bar
    // also yields to the notice; that case has its own test below).
    localStorage.setItem("pp_cookie_consent", "{}");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop">
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    const bar = () => container.querySelector(".pp-bottom-bar")!;
    const chromeRoot = () => container.querySelector(".pp-commercial")!;
    expect(bar().getAttribute("data-visible")).toBe("false");

    act(() => {
      ioCallback!([{ isIntersecting: false }]);
    });
    expect(bar().getAttribute("data-visible")).toBe("true");
    expect(chromeRoot().classList.contains("pp-bar-shown")).toBe(true);

    act(() => {
      container.querySelector('button[aria-label="Open menu"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const menu = container.querySelector('[role="dialog"][aria-label="Menu"]')!;
    expect(menu).toBeTruthy();
    expect(bar().getAttribute("data-visible")).toBe("false");
    expect(chromeRoot().classList.contains("pp-bar-shown")).toBe(false);
    // The menu container's native-feel classes (previously untested).
    for (const cls of ["pp-safe-top", "pp-safe-bottom", "pp-safe-x", "overscroll-contain"]) {
      expect(menu.classList.contains(cls)).toBe(true);
    }

    act(() => {
      container.querySelector('button[aria-label="Close menu"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(bar().getAttribute("data-visible")).toBe("true");
    expect(chromeRoot().classList.contains("pp-bar-shown")).toBe(true);

    await act(async () => {});
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
});

// Found on prod 2026-11-10 (v3 phone checklist): the chrome root makes no
// stacking context, so fixed layers overlap by z-index and tree order.
describe("CommercialShopChrome: overlapping phone layers", () => {
  function mount() {
    let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    class MockIO {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        ioCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop">
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    const click = (el: Element | null) =>
      act(() => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    return {
      container,
      click,
      scrollPastHero: () => act(() => ioCallback!([{ isIntersecting: false }])),
      bar: () => container.querySelector(".pp-bottom-bar")!,
      launcher: () => container.querySelector(".pp-chat-fab")!,
      async done() {
        await act(async () => {});
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        localStorage.clear();
      },
    };
  }

  it("keeps the bar hidden under a first visit's cookie notice, and shows it once the notice is dismissed", async () => {
    // The notice (z 60) covered the shown bar (z 50) completely, and the
    // bar's link stayed focusable underneath it.
    localStorage.clear();
    const ui = mount();
    ui.scrollPastHero();
    const notice = ui.container.querySelector('[aria-label="Cookie notice"]');
    expect(notice).toBeTruthy();
    expect(ui.bar().getAttribute("data-visible")).toBe("false");
    expect(ui.bar().querySelector("a")!.tabIndex).toBe(-1);

    ui.click([...notice!.querySelectorAll("button")].find((b) => b.textContent === "Got it")!);
    expect(ui.container.querySelector('[aria-label="Cookie notice"]')).toBeNull();
    expect(ui.bar().getAttribute("data-visible")).toBe("true");
    await ui.done();
  });

  it("hides the chat launcher and an open chat panel while the menu is open", async () => {
    // The launcher (z 60) floated over the full-screen menu (z 50): tappable,
    // but outside the menu's modal, so keyboard and screen readers missed it.
    localStorage.setItem("pp_cookie_consent", "{}");
    const ui = mount();
    expect(ui.launcher().classList.contains("invisible")).toBe(false);
    ui.click(ui.container.querySelector('button[aria-label="Open chat"]'));
    expect(ui.container.querySelector(".pp-chat-panel")).toBeTruthy();

    ui.click(ui.container.querySelector('button[aria-label="Open menu"]'));
    expect(ui.launcher().classList.contains("invisible")).toBe(true);
    expect(ui.container.querySelector(".pp-chat-panel")!.classList.contains("invisible")).toBe(true);

    ui.click(ui.container.querySelector('button[aria-label="Close menu"]'));
    expect(ui.launcher().classList.contains("invisible")).toBe(false);
    expect(ui.container.querySelector(".pp-chat-panel")!.classList.contains("invisible")).toBe(false);
    await ui.done();
  });
});

// Found 2026-11-11: the chatbot worker enforces Turnstile (its secret is set
// on production), but the chat loaded api.js and never rendered a widget, so
// no message ever carried a token. Every message on a real shop got 400
// "Security check required" and the visitor saw only the fallback reply.
describe("CommercialShopChrome: shop chat bot check", () => {
  type Fn = ReturnType<typeof vi.fn>;
  const services = [{ name: "Cut", price_gbp: 20, duration_minutes: 30, category: "Hair" }];
  const FALLBACK = "I'm having a quick moment. Please try again, or book directly at the link above.";
  const reply = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

  function mountChat(shopSlug = "test-shop") {
    document.querySelectorAll("script").forEach((s) => s.remove());
    localStorage.setItem("pp_cookie_consent", "{}");
    const ts: { render: Fn; remove: Fn; reset: Fn } = { render: vi.fn(() => "w-1"), remove: vi.fn(), reset: vi.fn() };
    (window as unknown as { turnstile?: unknown }).turnstile = ts;
    const fetchMock: Fn = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug={shopSlug} services={services}>
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    const click = (el: Element | null | undefined) =>
      act(() => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    click(container.querySelector('button[aria-label="Open chat"]'));
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Message"]')!;
    return {
      ts,
      fetchMock,
      container,
      input,
      opts: () => ts.render.mock.calls[0][1] as Record<string, (arg?: string) => unknown>,
      token: (t: string) =>
        act(() => {
          (ts.render.mock.calls[0][1] as Record<string, (arg?: string) => unknown>).callback(t);
        }),
      chip: () => click([...container.querySelectorAll(".pp-chat-panel button")].find((b) => b.textContent?.includes("Cut"))),
      type: (text: string) =>
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
          input().dispatchEvent(new Event("input", { bubbles: true }));
        }),
      send: () => click([...container.querySelectorAll(".pp-chat-panel button")].find((b) => b.textContent === "Send")),
      flush: async () => {
        for (let i = 0; i < 5; i++) await act(async () => {});
      },
      bodies: () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body)),
      log: () => container.querySelector('[role="log"]')!.textContent ?? "",
      async done() {
        await act(async () => {});
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        localStorage.clear();
        delete (window as unknown as { turnstile?: unknown }).turnstile;
      },
    };
  }

  it("mounts no bot check for a portfolio demo, whose replies are scripted", async () => {
    const ui = mountChat("linden-and-lark-demo");
    expect(ui.container.querySelector(".pp-chat-panel")).toBeTruthy();
    expect(ui.ts.render).not.toHaveBeenCalled();
    expect(document.querySelectorAll('script[src*="challenges.cloudflare.com"]')).toHaveLength(0);
    await ui.done();
  });

  it("renders the bot check before the message box and sends its token with the message", async () => {
    const ui = mountChat();
    expect(ui.ts.render).toHaveBeenCalledTimes(1);
    const [el, opts] = ui.ts.render.mock.calls[0];
    expect(opts).toMatchObject({ sitekey: TURNSTILE_SITE_KEY, appearance: "interaction-only" });
    expect(ui.container.querySelector(".pp-chat-panel")!.contains(el as Node)).toBe(true);
    expect((el as Node).compareDocumentPosition(ui.input()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    ui.token("tok-1");
    ui.fetchMock.mockResolvedValueOnce(reply(200, { reply: "A cut is 20 pounds." }));
    ui.chip();
    await ui.flush();
    expect(ui.bodies()).toHaveLength(1);
    expect(ui.bodies()[0]).toMatchObject({ shopId: "shop-1", message: "Tell me about Cut", turnstileToken: "tok-1" });
    expect(ui.log()).toContain("A cut is 20 pounds.");
    // Tokens are single-use: the widget is asked for a fresh one.
    expect(ui.ts.reset).toHaveBeenCalledWith("w-1");

    // The next message waits for that fresh token instead of reusing tok-1.
    ui.fetchMock.mockResolvedValueOnce(reply(200, { reply: "Yes, beard trims too." }));
    ui.type("And beards?");
    ui.send();
    await ui.flush();
    expect(ui.bodies()).toHaveLength(1);
    ui.token("tok-2");
    await ui.flush();
    expect(ui.bodies()).toHaveLength(2);
    expect(ui.bodies()[1]).toMatchObject({ message: "And beards?", turnstileToken: "tok-2" });
    await ui.done();
  });

  it.each([
    [400, "Security check required"],
    [403, "Security check failed"],
  ])("when the worker refuses the check (%i %s), asks for it again and keeps the message", async (status, error) => {
    const ui = mountChat();
    ui.token("tok-1");
    ui.fetchMock.mockResolvedValueOnce(reply(status, { reply: FALLBACK, error }));
    ui.type("Hello there");
    ui.send();
    await ui.flush();
    expect(ui.log()).not.toContain("quick moment");
    expect(ui.log()).toMatch(/complete the security check/i);
    expect(ui.log()).not.toContain("Hello there");
    expect(ui.input().value).toBe("Hello there");
    expect(ui.ts.reset).toHaveBeenCalledWith("w-1");

    // The note is local: it never goes to the assistant as history.
    ui.token("tok-2");
    ui.fetchMock.mockResolvedValueOnce(reply(200, { reply: "Hi!" }));
    ui.send();
    await ui.flush();
    expect(ui.bodies()[1]).toMatchObject({ message: "Hello there", turnstileToken: "tok-2", history: [] });
    await ui.done();
  });

  it("sends without a token after a short wait, so the worker decides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ui = mountChat();
      ui.fetchMock.mockResolvedValueOnce(reply(200, { reply: "Hello!" }));
      ui.chip();
      await ui.flush();
      expect(ui.fetchMock).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_TOKEN_WAIT_MS);
      });
      await ui.flush();
      expect(ui.bodies()).toHaveLength(1);
      expect(ui.bodies()[0]).not.toHaveProperty("turnstileToken");
      expect(ui.log()).toContain("Hello!");
      await ui.done();
    } finally {
      vi.useRealTimers();
    }
  });
});
