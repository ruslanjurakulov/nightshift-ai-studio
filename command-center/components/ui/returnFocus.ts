import { useRef } from "react";

type AutoFocusEvent = Event;

/**
 * Focus back to whatever had it when a dialog opened. Radix returns focus only to a Dialog.Trigger; most of our dialogs are
 * opened by app state (a tile, a menu item, a keyboard command) with no Trigger, and Radix then drops focus on <body>, so a
 * keyboard or screen-reader user is thrown to the top of the page. The element is read in onOpenAutoFocus, which Radix
 * fires before it moves focus inside.
 */
/**
 * Focus is "lost" when a dialog closes and nothing else took it: it sits on <body>, or on an element no longer on the page.
 * Only then is it given back (useOverlay's rule): when the person's choice moved focus somewhere on purpose (a panel the
 * dialog sent them to), taking it back to the opener would undo that, and scroll the page back with it.
 */
export function focusWasLost(): boolean {
  if (typeof document === "undefined") return false;
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
}

export function useReturnFocus(
  onOpen?: (e: AutoFocusEvent) => void,
  onClose?: (e: AutoFocusEvent) => void,
): { onOpenAutoFocus: (e: AutoFocusEvent) => void; onCloseAutoFocus: (e: AutoFocusEvent) => void } {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (e) => {
      const el = typeof document === "undefined" ? null : document.activeElement;
      opener.current = el instanceof HTMLElement && el !== document.body ? el : null;
      onOpen?.(e);
    },
    onCloseAutoFocus: (e) => {
      onClose?.(e);
      if (e.defaultPrevented) return;
      if (!focusWasLost()) {
        e.preventDefault();
        return;
      }
      const el = opener.current;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}
