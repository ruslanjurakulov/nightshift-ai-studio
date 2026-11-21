"use client";

import { useEffect } from "react";

/**
 * Publishes the real height of the app's sticky top bar as `--ns-shell-h` on
 * <html>, so the shell-wide `scroll-padding-top` (globals.css) keeps a control
 * focused by keyboard out from under the bar. The bar is not a fixed height (it
 * wraps on a phone, and a larger text size changes it), so it is measured. The
 * editor publishes its own `--ns-header-h` (useStickyOffsets); this one is the
 * shell's and is never removed by it.
 */
export function ShellOffsets() {
  useEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector<HTMLElement>("header.sticky");
    if (!header) return;
    const measure = () => root.style.setProperty("--ns-shell-h", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        window.removeEventListener("resize", measure);
        root.style.removeProperty("--ns-shell-h");
      };
    }
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--ns-shell-h");
    };
  }, []);
  return null;
}
