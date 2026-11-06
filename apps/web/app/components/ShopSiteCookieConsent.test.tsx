/** ShopSiteCookieConsent: the dismiss button's label takes the theme's
 *  on-accent colour, so it stays readable on a dark accent (fixed black text
 *  measured 1.76:1 on a deep green salon accent). */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShopSiteCookieConsent } from "./ShopSiteCookieConsent";

describe("ShopSiteCookieConsent", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    localStorage.clear();
  });

  it("colours the dismiss label from --st-on-accent, not fixed black", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<ShopSiteCookieConsent forceOpen onClose={() => {}} />));

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Got it");
    expect(button).toBeDefined();
    const classes = button!.className.split(/\s+/);
    expect(classes).toContain("text-[color:var(--st-on-accent,#000)]");
    expect(classes).not.toContain("text-black");
    expect(classes).toContain("bg-[color:var(--color-accent)]");
  });
});
