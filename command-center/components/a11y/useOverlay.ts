"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What every overlay owes a keyboard user, in one place: Escape closes it,
 * focus moves in when it opens, Tab stays inside while it is open, and focus
 * goes back to the control that opened it when it closes — otherwise it falls
 * to <body> and the next Tab starts from the top of the page.
 *
 * Escape is caught in the capture phase and marked handled, so a page-level
 * Escape handler (SectionShell's "close the panel") stands down instead of
 * also navigating away underneath the overlay.
 *
 * `opener` is the control to return to; without one, the element that had
 * focus when the overlay opened is used (a palette opened by Ctrl+K has none
 * worth returning to, and focus is then left alone).
 */
export function useOverlay(
  open: boolean,
  {
    onClose,
    container,
    opener,
    initialFocus,
    trap = true,
  }: {
    onClose: () => void;
    container: RefObject<HTMLElement | null>;
    opener?: RefObject<HTMLElement | null>;
    /** The control to focus on open; the container itself when omitted. */
    initialFocus?: RefObject<HTMLElement | null>;
    trap?: boolean;
  },
) {
  // The latest onClose, without re-running the effect when its identity changes.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const box = container.current;
    const remembered = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTo = opener?.current ?? remembered;
    (initialFocus?.current ?? box)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !trap || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!box.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Give focus back only if nothing else has claimed it: a click on another
      // control that closed the overlay has already moved focus there. Focus
      // still inside the overlay counts as lost: an overlay that animates out
      // (components/motion/Presence) is still in the document while it leaves.
      const active = document.activeElement;
      const lost =
        !active || active === document.body || !active.isConnected || (box !== null && box.contains(active));
      if (lost && returnTo && returnTo.isConnected && returnTo !== document.body) returnTo.focus();
    };
    // The refs are stable objects; only `open` starts and ends an overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trap]);
}
