"use client";

import { useEffect, useState } from "react";

/**
 * The five capability sections, side by side as a sideways snap rail on a phone
 * (the stylesheet turns the column into a rail below 860px; above it this is
 * just a wrapper). A scroller must be reachable without a pointer, so on a
 * phone the track is a named tab stop (arrow keys scroll it); on a wide screen
 * there is nothing to scroll and no tab stop. Nothing moves by itself.
 */
export function CapsRail({ label, className = "nx-caps", children }: { label: string; className?: string; children: React.ReactNode }) {
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 859px)");
    const sync = () => setScrolls(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return (
    <div className={className} role={scrolls ? "group" : undefined} aria-label={scrolls ? label : undefined} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </div>
  );
}
