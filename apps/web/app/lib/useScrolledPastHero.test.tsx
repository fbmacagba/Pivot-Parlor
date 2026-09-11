/** useScrolledPastHero: observes the page hero (data-pp-hero) or, without one,
 *  the sentinel; reports true only once the target has left the viewport. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { HERO_MARKER_ATTR, useScrolledPastHero } from "./useScrolledPastHero";

type Entry = { isIntersecting: boolean; target: Element };
let ioCallback: ((entries: Entry[]) => void) | null = null;
const observed: Element[] = [];
let disconnected = 0;

class MockIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    ioCallback = cb;
  }
  observe(el: Element) {
    observed.push(el);
  }
  unobserve() {}
  disconnect() {
    disconnected += 1;
  }
}

function Harness({ enabled }: { enabled: boolean }) {
  const { sentinelRef, pastHero } = useScrolledPastHero(enabled);
  return (
    <div>
      <div ref={sentinelRef} id="sentinel" />
      <span id="state">{pastHero ? "past" : "top"}</span>
    </div>
  );
}

describe("useScrolledPastHero", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    ioCallback = null;
    observed.length = 0;
    disconnected = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    document.querySelectorAll(`[${HERO_MARKER_ATTR}]`).forEach((el) => el.remove());
    vi.unstubAllGlobals();
  });

  it("is false in SSR markup", () => {
    expect(renderToStaticMarkup(<Harness enabled />)).toContain(">top<");
  });

  it("observes the hero when one is on the page and flips when it leaves", () => {
    const hero = document.createElement("section");
    hero.setAttribute(HERO_MARKER_ATTR, "");
    document.body.appendChild(hero);
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(observed).toEqual([hero]);
    act(() => ioCallback!([{ isIntersecting: true, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("top");
    act(() => ioCallback!([{ isIntersecting: false, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("past");
    act(() => ioCallback!([{ isIntersecting: true, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("top");
  });

  it("falls back to the sentinel when the page has no hero", () => {
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(observed).toEqual([container.querySelector("#sentinel")]);
  });

  it("creates no observer when disabled and disconnects on unmount", () => {
    root = createRoot(container);
    act(() => root!.render(<Harness enabled={false} />));
    expect(observed).toEqual([]);
    act(() => root!.render(<Harness enabled />));
    expect(observed.length).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(disconnected).toBe(1);
  });

  it("stays false without IntersectionObserver support", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(container.querySelector("#state")!.textContent).toBe("top");
  });
});
