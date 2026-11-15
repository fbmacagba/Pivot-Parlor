/** ShopSiteCookieConsent: the dismiss button's label takes the theme's
 *  on-accent colour, so it stays readable on a dark accent (fixed black text
 *  measured 1.76:1 on a deep green salon accent). */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShopSiteCookieConsent } from "./ShopSiteCookieConsent";
import { readMapConsent, recordShopConsent } from "~/lib/mapConsent";

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

  function mountNotice(props: { forceOpen?: boolean; asksAboutMap?: boolean }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(<ShopSiteCookieConsent forceOpen={props.forceOpen ?? false} asksAboutMap={props.asksAboutMap} onClose={() => {}} />),
    );
    return (label: string) => [...container!.querySelectorAll("button")].find((b) => b.textContent === label);
  }

  describe("on a shop with a Google map", () => {
    it("asks about the map even when the platform notice was acknowledged", () => {
      localStorage.setItem("pp_platform_consent", JSON.stringify({ decided: true }));
      const button = mountNotice({ asksAboutMap: true });
      expect(button("Allow map")).toBeDefined();
      expect(button("Essential only")).toBeDefined();
      expect(container!.textContent).toContain("Google");
    });

    it("asks again after the old notice, which never asked about the map", () => {
      localStorage.setItem("pp_cookie_consent", JSON.stringify({ essential: true }));
      const button = mountNotice({ asksAboutMap: true });
      expect(button("Allow map")).toBeDefined();
    });

    it("records Allow map and closes", () => {
      const button = mountNotice({ asksAboutMap: true });
      act(() => button("Allow map")!.click());
      expect(readMapConsent()).toBe("granted");
      expect(container!.querySelector('[aria-label="Cookie notice"]')).toBeNull();
    });

    it("records Essential only and closes", () => {
      const button = mountNotice({ asksAboutMap: true });
      act(() => button("Essential only")!.click());
      expect(readMapConsent()).toBe("declined");
      expect(container!.querySelector('[aria-label="Cookie notice"]')).toBeNull();
    });

    it("stays closed once the visitor chose", () => {
      recordShopConsent("declined");
      mountNotice({ asksAboutMap: true });
      expect(container!.querySelector('[aria-label="Cookie notice"]')).toBeNull();
    });

    it("reopens from the footer with the choice, so a visitor can withdraw", () => {
      recordShopConsent("granted");
      const button = mountNotice({ asksAboutMap: true, forceOpen: true });
      act(() => button("Essential only")!.click());
      expect(readMapConsent()).toBe("declined");
    });
  });

  describe("on a shop without a map", () => {
    it("keeps the plain notice, which the platform acknowledgement covers", () => {
      localStorage.setItem("pp_platform_consent", JSON.stringify({ decided: true }));
      mountNotice({ asksAboutMap: false });
      expect(container!.querySelector('[aria-label="Cookie notice"]')).toBeNull();
    });

    it("Got it keeps a map choice made on another shop", () => {
      recordShopConsent("granted");
      const button = mountNotice({ asksAboutMap: false, forceOpen: true });
      expect(button("Allow map")).toBeUndefined();
      act(() => button("Got it")!.click());
      expect(readMapConsent()).toBe("granted");
    });
  });
});
