"use client";

import { useEffect } from "react";
import { FRAME_SYNC, leavesFrame, type FrameSync } from "@/lib/view-mode";
import { assignTop } from "./frame-nav";

/** True only inside a frame of our own origin (the Mobile view's phone frame). A cross-origin parent throws on read. */
function inOwnFrame(): boolean {
  try {
    return window.parent !== window && window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Mounted by app/layout.tsx in a document the browser loaded as a frame. It
 * does two jobs for the Mobile view's phone frame (ViewFrame):
 *
 *  1. Tells the parent where this page is, on load, on every client-side
 *     navigation (history.pushState/replaceState, back/forward, hash) and when
 *     the title changes, so the parent's address bar and tab title are true.
 *  2. Lets links that cannot live in a frame leave it. Another site's pages
 *     (a payment portal, a provider's consent screen) refuse to be framed, and
 *     so do our own sign-in steps, so a click on such a link opens it in the
 *     whole window instead of a blank frame. New-tab links, downloads and
 *     modified clicks keep their normal behaviour.
 *
 * Renders nothing.
 */
export function EmbedBridge() {
  useEffect(() => {
    if (!inOwnFrame()) return;

    let last = "";
    const post = () => {
      const msg: FrameSync = {
        type: FRAME_SYNC,
        href: window.location.pathname + window.location.search + window.location.hash,
        title: document.title,
      };
      // The head changes for many reasons (styles, preloads); the parent hears only about a new address or title.
      const key = `${msg.href}\n${msg.title}`;
      if (key === last) return;
      last = key;
      window.parent.postMessage(msg, window.location.origin);
    };

    const { pushState, replaceState } = window.history;
    window.history.pushState = function (...args: Parameters<History["pushState"]>) {
      pushState.apply(this, args);
      post();
    };
    window.history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      replaceState.apply(this, args);
      post();
    };
    window.addEventListener("popstate", post);
    window.addEventListener("hashchange", post);
    const observer = new MutationObserver(post);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      if (!leavesFrame(a.href, window.location.origin)) return;
      e.preventDefault();
      assignTop(a.href);
    }
    document.addEventListener("click", onClick, true);

    post();
    return () => {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      window.removeEventListener("popstate", post);
      window.removeEventListener("hashchange", post);
      observer.disconnect();
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  return null;
}
