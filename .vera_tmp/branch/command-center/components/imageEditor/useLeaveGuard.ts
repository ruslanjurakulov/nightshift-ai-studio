"use client";

import { useEffect } from "react";
import { afterConfirm, leavesThePage } from "@/lib/imageEditor/leave";

/**
 * While `dirty`: the browser's own prompt on a tab close or reload, and `message` as a confirm before an in-app link is
 * followed. The click listener is on the document in the CAPTURE phase so it runs before Next's Link handler; cancelling it
 * there stops the navigation.
 */
export function useLeaveGuard(dirty: boolean, message: string): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
    };
    let guard = { instant: 0 };
    const click = (ev: MouseEvent) => {
      const a = (ev.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      if (!leavesThePage({ href: a.getAttribute("href") ?? "", target: a.target, download: a.hasAttribute("download") }, ev, window.location.href)) return;
      const t0 = performance.now();
      const yes = window.confirm(message);
      const verdict = afterConfirm(guard, yes, performance.now() - t0);
      guard = verdict.guard;
      if (verdict.stay) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, message]);
}
