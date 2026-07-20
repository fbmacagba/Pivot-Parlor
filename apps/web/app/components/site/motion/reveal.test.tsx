/** Reveal wrapper: hidden state is JS-applied only (no-JS visitors always see
 *  content); disabled renders children with no wrapper at all. */
// React 18.3's `act` (imported from "react" below) only suppresses its
// DOM-update-tracking warnings when the environment opts in; without this,
// react-dom logs "not configured to support act(...)" on every act() call.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { Reveal } from "./Reveal";

type Entry = { isIntersecting: boolean; target: Element };
let ioCallback: ((entries: Entry[]) => void) | null = null;
const unobserved: Element[] = [];

class MockIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    ioCallback = cb;
  }
  observe() {}
  unobserve(el: Element) {
    unobserved.push(el);
  }
  disconnect() {}
}

describe("Reveal", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    ioCallback = null;
    unobserved.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders children with no wrapper when disabled", () => {
    const child = <section id="x">hi</section>;
    expect(
      renderToStaticMarkup(
        <Reveal enabled={false} style="fade-up" index={0} lively={false}>{child}</Reveal>,
      ),
    ).toBe(renderToStaticMarkup(child));
  });

  it("SSR markup never contains the hidden state", () => {
    const html = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={0} lively={false}><section /></Reveal>,
    );
    expect(html).toContain('class="st-reveal-wrap st-reveal--fade-up"');
  });

  it("hides via JS on mount, reveals on intersection", () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        <Reveal enabled style="scale" index={0} lively={false}><section /></Reveal>,
      );
    });
    const el = container.querySelector(".st-reveal-wrap")!;
    expect(el.classList.contains("st-reveal")).toBe(true);
    expect(el.classList.contains("is-revealed")).toBe(false);
    act(() => {
      ioCallback!([{ isIntersecting: true, target: el }]);
    });
    expect(el.classList.contains("is-revealed")).toBe(true);
    expect(unobserved).toContain(el);
  });

  it("staggers only when lively", () => {
    const lively = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={2} lively><section /></Reveal>,
    );
    const calm = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={2} lively={false}><section /></Reveal>,
    );
    expect(lively).toContain("--st-reveal-delay:180ms");
    expect(calm).toContain("--st-reveal-delay:0ms");
  });
});
