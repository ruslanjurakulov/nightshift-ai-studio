"use client";

import * as m from "motion/react-m";
import { useFreshMount, useReducedMotionSafe } from "./hooks";
import { pageEnterProps } from "@/lib/motion/presets";

/**
 * A screen's arrival, for a route `template.tsx` (which remounts on every
 * navigation). Enter only — the App Router unmounts the old screen before the
 * new one can play an exit, and faking one means freezing router internals.
 *
 * - The server-rendered first paint never animates: the content is visible in
 *   the HTML, so Largest Contentful Paint is not held back by JavaScript.
 * - A client navigation rises 8px and fades in on the enter duration. Opacity
 *   and transform only: the box is in its final place from the first frame,
 *   so nothing around it shifts (no CLS).
 * - Children stay Server Components and keep streaming: this is a client
 *   boundary that only wraps what it is handed.
 * - Reduced motion: no props at all; the screen is simply there.
 */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotionSafe();
  const fresh = useFreshMount();
  return (
    <m.div data-ns-motion="" className={className} {...pageEnterProps(reduced, fresh)}>
      {children}
    </m.div>
  );
}
