"use client";

import { useEffect } from "react";

/** How long to wait for the section to appear before giving up. */
const WAIT_MS = 6000;

/**
 * Scroll to the section the address names (`/credits#invite`) once it is on the page.
 *
 * A link from another page (Settings → Invite friends) reaches a page that streams in: the router looks for the id
 * before the section exists, finds nothing and stays at the top. This waits for the section to be drawn and then
 * scrolls to it once per address. The section's own `scroll-mt-*` keeps it clear of the sticky header. An address with no hash, or
 * one that names nothing here, does nothing; opening the page directly already scrolled and this lands on the same
 * spot. It stands down after a few seconds, or the moment the person scrolls, touches or presses a key, so it never fights them.
 */
export function ScrollToHash() {
  useEffect(() => {
    let frame = 0;
    let landed = "";
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(e, stop);
    };
    // The address is read each time, not once: the router writes a client-side link's hash into it around the time
    // this page mounts, not always before.
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
