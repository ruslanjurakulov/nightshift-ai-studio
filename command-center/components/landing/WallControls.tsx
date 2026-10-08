"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The capability wall's two small behaviours, both on the wall's own element so the wall itself stays a Server Component:
 *
 * - a phone shows the first four tiles and a "show all" button; the other four are in the page (so every tool's name is
 *   reachable) but hidden, and a hidden lazy picture is not fetched until the button shows it (from 640 px up all eight show
 *   and the button is hidden);
 * - the tile that shows most of itself drifts (a slow zoom of its photograph, CSS only, no extra file), unless motion is
 *   reduced or paused; hovering a tile does the same. Nothing is fetched for it.
 */
export function WallControls({ more, less }: { more: string; less: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    ref.current?.closest(".nx-wall")?.setAttribute("data-open", open ? "true" : "false");
  }, [open]);

  useEffect(() => {
    const wall = ref.current?.closest(".nx-wall");
    if (!wall || typeof IntersectionObserver === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tiles = Array.from(wall.querySelectorAll<HTMLElement>(".nx-wall-tile"));
    const ratios = new Map<Element, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
        let best: Element | null = null;
        let top = 0.6;
        for (const [el, r] of ratios) if (r > top) [best, top] = [el, r];
        for (const t of tiles) t.toggleAttribute("data-alive", t === best);
      },
      { threshold: [0, 0.3, 0.6, 0.8, 1] },
    );
    tiles.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  return (
    <button ref={ref} type="button" className="nx-wall-more" aria-expanded={open} aria-controls="tools-grid" onClick={() => setOpen((o) => !o)}>
      {open ? less : more}
    </button>
  );
}
