/**
 * A toast or the "session ended" bar can appear while a modal dialog is open. They sit above it (--ds-z-toast) and stay in the
 * accessibility tree (Radix leaves aria-live regions alone), but to Radix a press on one is a press outside the dialog, which
 * would close it: dismissing a toast must not also throw away the sheet the person was working in.
 */
export const NOTICE_SELECTOR = ".toast-viewport, [data-notice-layer]";

export function keepOpenOnNotice<E extends { target: EventTarget | null; preventDefault(): void }>(
  next?: (e: E) => void,
): (e: E) => void {
  return (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest(NOTICE_SELECTOR)) e.preventDefault();
    next?.(e);
  };
}
