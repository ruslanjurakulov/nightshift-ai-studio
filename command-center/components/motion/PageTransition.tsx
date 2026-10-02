"use client";

import { div as MDiv } from "motion/react-m";
import { useFreshMount, useStill } from "./hooks";
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
 * - Reduced motion, no engine (yet) or a failed one: no props at all; the
 *   screen is simply there.
 */
export function PageTransition({ children, className }: { children: React.ReactNode; className?: string }) {
  const still = useStill();
  const fresh = useFreshMount();
  return (
    <MDiv data-ns-motion="" className={className} {...pageEnterProps(still, fresh)}>
      {children}
    </MDiv>
  );
}
