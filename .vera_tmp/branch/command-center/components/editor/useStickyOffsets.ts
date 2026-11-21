"use client";

import { useEffect, type RefObject } from "react";

/**
 * The two heights the phone layout's pinned preview needs, published as CSS
 * variables on <html> so a class can use them (`top-[var(--ns-header-h)]`):
 *
 *  - `--ns-header-h`: the real height of the app's sticky top bar. It is not
 *    fixed (on a phone the bar wraps to two rows, and a longer breadcrumb or a
 *    larger text size changes it), so it is measured, not guessed.
 *  - `--ns-sticky-h`: the height of the pinned preview, which the stylesheet adds
 *    to the header height as `scroll-padding-top`, so a control focused with the
 *    keyboard or scrolled into view is never left under the preview.
 *
 * Both are removed again when the editor unmounts. Where ResizeObserver does not
 * exist the CSS fallbacks stand in.
 */
export function useStickyOffsets(preview: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector<HTMLElement>("header.sticky");
    const set = (name: string, el: HTMLElement | null) => {
      if (el) root.style.setProperty(name, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    };
    const measure = () => {
      set("--ns-header-h", header);
      set("--ns-sticky-h", preview.current);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
        root.style.removeProperty("--ns-header-h");
        root.style.removeProperty("--ns-sticky-h");
      };
    }
    const ro = new ResizeObserver(measure);
    if (header) ro.observe(header);
    if (preview.current) ro.observe(preview.current);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--ns-header-h");
      root.style.removeProperty("--ns-sticky-h");
    };
  }, [preview]);
}
