"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Counts up (or down) to `value` when it changes — a subtle, fast tween for the
 * dashboard's numeric stats. Renders the real value immediately for SSR and for
 * anyone with reduced motion; only the transition is animated, never the number
 * itself. Non-finite inputs render as-is.
 */
export function AnimatedNumber({
  value,
  duration = 600,
  format = (n: number) => Math.round(n).toLocaleString(),
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    if (reduce || from === value) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      // easeOutCubic — quick then settling, never bouncy.
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  return <span className="tabular-nums">{Number.isFinite(display) ? format(display) : String(value)}</span>;
}
