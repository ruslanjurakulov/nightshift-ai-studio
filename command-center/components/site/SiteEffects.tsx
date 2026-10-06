"use client";

import { useEffect } from "react";
import { restoreMotion } from "@/lib/site/motion";

/**
 * The public pages' two quiet effects, run by one small script instead of
 * a component per card:
 *
 * 1. A soft light that follows the pointer across any `[data-spot]` card
 *    (a fine pointer only; touch never gets it). The script writes two CSS
 *    variables per frame and nothing re-renders; the light itself is a
 *    pseudo-element in site-next.css that only changes opacity.
 * 2. Sections below the fold ease in once as they are scrolled to. Only
 *    elements that start outside the viewport are ever hidden, and only after
 *    this script has run, so the first screen (and so LCP) is never touched,
 *    and without JavaScript, with reduced motion, or without
 *    IntersectionObserver everything is simply there.
 *
 * The idea of the pointer light is the usual "spotlight card" pattern (21st.dev
 * lists several); this is our own implementation, no code was copied.
 */

/** What eases in. Groups stagger by their index among siblings. */
const REVEAL = [
  ".nx-section .nx-wrap > *",
  ".nx-final",
  ".nx-show .nx-show-card",
  ".nx .st-section .st-wrap > *",
  ".nx .st-ways > *",
  ".nx .st-sol-list > li",
];

export function SiteEffects() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    // Lets the hero light start drifting once the page has loaded and settled (see site-next.css).
    let live = 0;
    const start = () => {
      // The remembered "paused" is on <html> before anything is allowed to move.
      restoreMotion();
      live = window.setTimeout(() => document.documentElement.setAttribute("data-fx", "on"), 200);
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    const cleanups: Array<() => void> = [
      () => {
        window.removeEventListener("load", start);
        window.clearTimeout(live);
      },
    ];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return () => cleanups.forEach((c) => c());

    // 1. Pointer light.
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      let frame = 0;
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        const card = (e.target as Element | null)?.closest?.<HTMLElement>("[data-spot]");
        if (!card) return;
        const { clientX, clientY } = e;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const r = card.getBoundingClientRect();
          card.style.setProperty("--mx", `${clientX - r.left}px`);
          card.style.setProperty("--my", `${clientY - r.top}px`);
        });
      };
      document.addEventListener("pointermove", onMove, { passive: true });
      cleanups.push(() => {
        document.removeEventListener("pointermove", onMove);
        cancelAnimationFrame(frame);
      });
    }

    // 2. Ease in, once.
    if (typeof IntersectionObserver !== "undefined") {
      const seen = new Set<Element>();
      const targets: HTMLElement[] = [];
      for (const sel of REVEAL) {
        document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          targets.push(el);
        });
      }
      const vh = window.innerHeight;
      const pending = new Set<HTMLElement>();
      const reveal = (el: HTMLElement) => {
        el.dataset.rv = "1";
        pending.delete(el);
        io.unobserve(el);
      };
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            // On screen, or already scrolled past (a jump to an anchor or the End key skips what is between).
            if (entry.isIntersecting || entry.boundingClientRect.top < 0) reveal(entry.target as HTMLElement);
          }
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
      );
      // A jump can skip elements without the observer ever reporting them, so a cheap check on scroll
      // (a few dozen rectangles per frame) catches whatever is now on screen or above it.
      let sweep = 0;
      const onScroll = () => {
        if (sweep) return;
        sweep = requestAnimationFrame(() => {
          sweep = 0;
          const limit = window.innerHeight * 0.94;
          for (const el of pending) if (el.getBoundingClientRect().top < limit) reveal(el);
        });
      };
      for (const el of targets) {
        // Already on screen (or above it): leave it exactly as rendered.
        if (el.getBoundingClientRect().top < vh) continue;
        const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
        el.style.setProperty("--rv-i", String(Math.min(Math.max(siblings.indexOf(el), 0), 4)));
        el.dataset.rv = "0";
        pending.add(el);
        io.observe(el);
      }
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => {
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(sweep);
      });
      cleanups.push(() => {
        io.disconnect();
        // Never leave something hidden behind: a route change or a hot reload shows it all.
        for (const el of targets) if (el.dataset.rv === "0") el.dataset.rv = "1";
      });
    }

    return () => cleanups.forEach((c) => c());
  }, []);

  return null;
}
