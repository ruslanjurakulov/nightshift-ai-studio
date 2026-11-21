"use client";

import { useEffect } from "react";

/** How long to wait for the section to appear before giving up. */
const WAIT_MS = 6000;

/**
 * Scroll to the section the address names (`/credits#invite`) once it is on the page.
 *
 * A link from another page (Settings → Invite friends) reaches a page that streams in: the router looks for the id
 * before the section exists, finds nothing and stays at the top. This waits for the section to be drawn and then
 * scrolls to it once per address. In the signed-in app the sticky header is cleared by the shell's `scroll-padding-top` (globals.css, `--ns-shell-h`), so a section there needs no `scroll-mt-*` of its own (only a small one, for air): the two would add up. An address with no hash, or
 * one that names nothing here, does nothing; opening the page directly already scrolled and this lands on the same
 * spot. It stands down after a few seconds, or the moment the person scrolls, touches or presses a key, so it never fights them.
 */
export function ScrollToHash() {
  useEffect(() => {
    // No hash when the page mounts: nothing to wait for (the router writes a link's hash before it mounts the page).
    if (!window.location.hash) return;
    let frame = 0;
    let landed = "";
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(e, stop);
    };
    // The address is read each time the page changes, while waiting for the section.
    const land = () => {
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      const el = id ? document.getElementById(id) : null;
      if (!el || landed === id) return;
      landed = id;
      // After the frame, so the router's own scroll (to the top, when it found nothing) has already happened.
      frame = window.requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
      observer.disconnect();
    };
    const observer = new MutationObserver(land);
    const timer = window.setTimeout(stop, WAIT_MS);
    for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(e, stop, { passive: true, once: true });
    land();
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, []);
  return null;
}
