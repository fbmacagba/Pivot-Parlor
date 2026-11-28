(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { ConsentedMap } from "./ConsentedMap";
import { readMapConsent, recordShopConsent } from "~/lib/mapConsent";

const SRC = "https://www.google.com/maps?q=1%20High%20St&output=embed";

describe("ConsentedMap", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(node));
  }

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    localStorage.clear();
  });

  it("never sends Google's map in the server HTML", () => {
    const html = renderToStaticMarkup(<ConsentedMap title="Map" src={SRC} />);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("google.com/maps");
    expect(html).toContain("Show map");
    expect(html).toContain("Google");
  });

  it("stays a placeholder while the visitor has not chosen, or chose essential only", () => {
    mount(<ConsentedMap title="Map" src={SRC} />);
    expect(container!.querySelector("iframe")).toBeNull();
    act(() => recordShopConsent("declined"));
    expect(container!.querySelector("iframe")).toBeNull();
  });

  it("loads the map when the visitor allowed it earlier", () => {
    recordShopConsent("granted");
    mount(<ConsentedMap title="Map showing Example Cuts" src={SRC} />);
    const frame = container!.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(SRC);
    expect(frame?.getAttribute("title")).toBe("Map showing Example Cuts");
    // Only the site's address reaches Google, not the page (a booking
    // confirmation's address names the booking).
    expect(frame?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("Show map records the choice and loads every map on the page", () => {
    mount(
      <>
        <ConsentedMap title="First" src={SRC} />
        <ConsentedMap title="Second" src={SRC} />
      </>,
    );
    const button = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Show map");
    act(() => button!.click());
    expect(readMapConsent()).toBe("granted");
    expect(container!.querySelectorAll("iframe")).toHaveLength(2);
  });

  it("unloads the map when the visitor withdraws", () => {
    recordShopConsent("granted");
    mount(<ConsentedMap title="Map" src={SRC} />);
    expect(container!.querySelector("iframe")).not.toBeNull();
    act(() => recordShopConsent("declined"));
    expect(container!.querySelector("iframe")).toBeNull();
  });
});
