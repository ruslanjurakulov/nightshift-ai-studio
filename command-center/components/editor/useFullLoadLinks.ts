"use client";

import { useEffect } from "react";
import { fullLoadTarget, loadDocument } from "@/lib/editor-nav";

/**
 * While the editor's project page is open, every in-app link click (the editor's own, the app's navigation, a
 * breadcrumb) leaves by a full document load, so the next page gets its own Permissions-Policy and never inherits the
 * editor's `microphone=(self)` (lib/editor-nav.ts). Listened for on `document` in the capture phase, ahead of
 * React's handlers on the root, and ONLY `preventDefault()`: the link's own `onClick` still runs (a notification is
 * still marked read), and a Next `<Link>` then sees `defaultPrevented` and starts no client-side transition (Next
 * runs the onClick prop first, then returns on defaultPrevented). Never stopPropagation: that would swallow the
 * link's own handler. New-tab clicks, downloads, other origins and same-page anchors are left to the browser.
 */
export function useFullLoadLinks(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(el instanceof HTMLAnchorElement)) return;
      const href = fullLoadTarget(e, { href: el.href, target: el.target, download: el.hasAttribute("download") }, new URL(window.location.href));
      if (!href) return;
      e.preventDefault();
      loadDocument(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
