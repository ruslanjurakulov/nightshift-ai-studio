"use client";

import { useEffect } from "react";
import { attachCountUp, attachHeader, attachMagnetic, attachNavBusy, attachParallax, attachSpotlight } from "@/components/site/motion/attach";

/**
 * The public pages' motion and interaction layer, mounted once by PublicShell and AuthShell beside SiteEffects (which keeps the
 * reveal and the card light). It renders nothing; each effect is a delegated listener (components/site/motion/attach.ts) and
 * everything visible is in components/site/site-motion.css. With JavaScript off the page is the server's HTML, whole and still.
 *
 * Each public page renders its own shell, so a navigation to another page mounts this anew: the count-up finds that page's
 * numbers, and the cleanup of the page left behind clears any key that said "loading" (attachNavBusy).
 */
export function SiteMotion() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const stops = [attachHeader(), attachNavBusy(), attachMagnetic(), attachParallax(), attachSpotlight(), attachCountUp()];
    return () => stops.forEach((s) => s());
  }, []);

  return null;
}
