// apps/web/app/lib/focusTrap.ts
//
// Framework-free focus-trap core, kept separate from the React hook so it can
// be unit-tested in jsdom without rendering a component. The hook
// (useModalA11y) is a thin wrapper around this.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focusable descendants of `container`, in DOM (tab) order. Disabled and
 * tabindex="-1" elements are excluded by the selector. Visibility is NOT
 * filtered here: an open modal's controls are visible, and layout-based
 * checks (offsetParent) are unreliable under jsdom, so filtering them would
 * make the trap untestable for no real-world gain.
 */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => !el.hasAttribute("hidden"));
}

/**
 * Trap Tab/Shift-Tab focus within `container` and route Escape to onEscape.
 * Returns a cleanup function that removes the listener. The caller is
 * responsible for moving focus into the container and restoring it on close
 * (the hook does both).
 */
export function createFocusTrap(
  container: HTMLElement,
  opts: { onEscape?: () => void } = {},
): () => void {
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      opts.onEscape?.();
      return;
    }
    if (e.key !== "Tab") return;

    const focusable = getFocusable(container);
    if (focusable.length === 0) {
      // Nothing to focus inside: keep focus on the container itself.
      e.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", onKeyDown);
  return () => container.removeEventListener("keydown", onKeyDown);
}
