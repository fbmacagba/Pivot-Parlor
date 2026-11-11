(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TURNSTILE_SCRIPT_SRC, TurnstileWidget } from "./TurnstileWidget";

// Turnstile's IMPLICIT render (a .cf-turnstile div plus a plain api.js
// script) rewrote the contact form's markup before React hydrated it: on
// 2026-11-10 production /contact logged React #418 x35 and #423, re-rendered
// on the client and orphaned the widget, so no token was ever issued.
// Blocking challenges.cloudflare.com alone took the errors to 0.

type FakeTurnstile = {
  render: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
const win = window as unknown as { turnstile?: FakeTurnstile };

function fakeTurnstile(): FakeTurnstile {
  return { render: vi.fn(() => "widget-1"), remove: vi.fn(), reset: vi.fn() };
}

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  delete win.turnstile;
  document.querySelectorAll("script").forEach((s) => s.remove());
});

describe("TurnstileWidget", () => {
  it("server-renders an empty container that implicit render cannot find", () => {
    const html = renderToStaticMarkup(<TurnstileWidget siteKey="site-key" />);
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain("data-sitekey");
    expect(html).not.toContain("<script");
  });

  it("loads the explicit-render script once, then renders into its own container", () => {
    expect(TURNSTILE_SCRIPT_SRC).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    const a = mount(<TurnstileWidget siteKey="site-key" theme="dark" />);
    const b = mount(<TurnstileWidget siteKey="site-key" theme="dark" />);
    const scripts = document.querySelectorAll(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    expect(scripts).toHaveLength(1);

    const ts = fakeTurnstile();
    win.turnstile = ts;
    act(() => {
      scripts[0].dispatchEvent(new Event("load"));
    });
    expect(ts.render).toHaveBeenCalledTimes(2);
    const [el, opts] = ts.render.mock.calls[0];
    expect(a.container.contains(el as Node)).toBe(true);
    expect(opts).toMatchObject({ sitekey: "site-key", theme: "dark" });
    a.unmount();
    b.unmount();
  });

  it("renders at once when Turnstile is already loaded, and removes the widget on unmount", () => {
    const ts = fakeTurnstile();
    win.turnstile = ts;
    const ui = mount(<TurnstileWidget siteKey="site-key" />);
    expect(ts.render).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    ui.unmount();
    expect(ts.remove).toHaveBeenCalledWith("widget-1");
  });

  it("issues a fresh token after each submission (tokens are single-use)", () => {
    const ts = fakeTurnstile();
    win.turnstile = ts;
    const first = { success: false };
    const ui = mount(<TurnstileWidget siteKey="site-key" resetSignal={undefined} />);
    ui.rerender(<TurnstileWidget siteKey="site-key" resetSignal={first} />);
    expect(ts.reset).toHaveBeenCalledWith("widget-1");
    ui.rerender(<TurnstileWidget siteKey="site-key" resetSignal={first} />);
    expect(ts.reset).toHaveBeenCalledTimes(1);
    ui.rerender(<TurnstileWidget siteKey="site-key" resetSignal={{ success: false }} />);
    expect(ts.reset).toHaveBeenCalledTimes(2);
    expect(ts.render).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it("does not render after unmounting before the script loaded", () => {
    const ui = mount(<TurnstileWidget siteKey="site-key" />);
    const script = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`)!;
    ui.unmount();
    const ts = fakeTurnstile();
    win.turnstile = ts;
    script.dispatchEvent(new Event("load"));
    expect(ts.render).not.toHaveBeenCalled();
  });
});
