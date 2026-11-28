import { useRef } from "react";

type AutoFocusEvent = Event;

/**
 * Focus back to whatever had it when a dialog opened. Radix returns focus only to a Dialog.Trigger; most of our dialogs are
 * opened by app state (a tile, a menu item, a keyboard command) with no Trigger, and Radix then drops focus on <body>, so a
 * keyboard or screen-reader user is thrown to the top of the page. The element is read in onOpenAutoFocus, which Radix
 * fires before it moves focus inside.
 */
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
      const el = opener.current;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}
