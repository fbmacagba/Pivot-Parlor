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

import { CommercialShopChrome } from "./CommercialShopChrome";

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
