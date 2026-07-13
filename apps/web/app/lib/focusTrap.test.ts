// apps/web/app/lib/focusTrap.test.ts
// Runtime verification of the focus-trap core in jsdom. tsc alone cannot prove
// a focus trap actually traps, so these assert the real DOM behaviour.

import { describe, it, expect, afterEach } from "vitest";
import { getFocusable, createFocusTrap } from "./focusTrap";

function mountModal(): HTMLElement {
  document.body.innerHTML = `
    <button id="outside">outside</button>
    <div id="modal" tabindex="-1">
      <button id="first">first</button>
      <input id="mid" />
      <button id="last">last</button>
    </div>`;
  return document.getElementById("modal") as HTMLElement;
}

function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("getFocusable", () => {
  it("returns focusable descendants in tab order", () => {
    const modal = mountModal();
    expect(getFocusable(modal).map((el) => el.id)).toEqual([
      "first",
      "mid",
      "last",
    ]);
  });

  it("excludes disabled controls", () => {
    document.body.innerHTML = `
      <div id="m">
        <button disabled>nope</button>
        <button id="ok">ok</button>
      </div>`;
    expect(
      getFocusable(document.getElementById("m") as HTMLElement).map((e) => e.id),
    ).toEqual(["ok"]);
  });
});

describe("createFocusTrap", () => {
  it("wraps Tab from the last element back to the first", () => {
    const modal = mountModal();
    const release = createFocusTrap(modal);
    (document.getElementById("last") as HTMLElement).focus();

    const e = tab(modal);

    expect(document.activeElement?.id).toBe("first");
    expect(e.defaultPrevented).toBe(true);
    release();
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    const modal = mountModal();
    const release = createFocusTrap(modal);
    (document.getElementById("first") as HTMLElement).focus();

    const e = tab(modal, true);

    expect(document.activeElement?.id).toBe("last");
    expect(e.defaultPrevented).toBe(true);
    release();
  });

  it("pulls focus back inside when it has escaped the container", () => {
    const modal = mountModal();
    const release = createFocusTrap(modal);
    (document.getElementById("outside") as HTMLElement).focus();

    tab(modal); // forward Tab with focus outside -> first

    expect(document.activeElement?.id).toBe("first");
    release();
  });

  it("invokes onEscape when Escape is pressed", () => {
    const modal = mountModal();
    let closed = 0;
    const release = createFocusTrap(modal, { onEscape: () => (closed += 1) });

    modal.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(closed).toBe(1);
    release();
  });

  it("stops trapping after release", () => {
    const modal = mountModal();
    const release = createFocusTrap(modal);
    release();

    (document.getElementById("last") as HTMLElement).focus();
    const e = tab(modal);

    // Listener gone: our handler did not preventDefault or move focus.
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe("last");
  });
});
