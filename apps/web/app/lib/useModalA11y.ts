// apps/web/app/lib/useModalA11y.ts
//
// Accessibility behaviour for hand-rolled modal dialogs that do not use the
// shared Radix Dialog: focus moves into the dialog on open, Tab/Shift-Tab is
// trapped inside it, Escape closes it, background scroll is locked, and focus
// returns to whatever was focused before it opened. Attach the returned ref to
// the dialog container element.
//
// Radix already provides all of this for components/ui/Dialog consumers; this
// hook is for the surfaces Radix's portal/overlay shape does not fit
// (ReviewModal, InstallAppPrompt, ExitIntentModal, the bookings drawer).

import { useEffect, useRef } from "react";
import { createFocusTrap, getFocusable } from "./focusTrap";

export function useModalA11y<T extends HTMLElement = HTMLDivElement>({
  active,
  onClose,
  lockScroll = true,
}: {
  /** Whether the dialog is currently open. */
  active: boolean;
  /** Called on Escape (and used as the close handler). */
  onClose?: () => void;
  /** Lock background scroll while open (default true). */
  lockScroll?: boolean;
}) {
  const ref = useRef<T>(null);
  // Keep the latest onClose without making it an effect dependency, so a
  // parent that passes an inline arrow function does not re-run the effect
  // (and re-steal focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus into the dialog: first focusable control, else the container
    // itself (ensure it is focusable so Escape/Tab handlers receive keydowns).
    const first = getFocusable(container)[0];
    if (first) {
      first.focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
      container.focus();
    }

    const releaseTrap = createFocusTrap(container, {
      onEscape: () => onCloseRef.current?.(),
    });

    let previousOverflow: string | null = null;
    if (lockScroll) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    return () => {
      releaseTrap();
      if (lockScroll) {
        document.body.style.overflow = previousOverflow ?? "";
      }
      // Restore focus to the trigger, if it is still in the document.
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [active, lockScroll]);

  return ref;
}
