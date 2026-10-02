"use client";

import * as m from "motion/react-m";
import { useFreshMount, useReducedMotionSafe } from "./hooks";
import { loadingGraceProps } from "@/lib/motion/presets";

/**
 * Holds a loading placeholder back for a moment (LOADING_GRACE) and then lets
 * it in, so a route that answers quickly swaps straight to its content
 * instead of flashing grey blocks for a frame. The placeholder still occupies
 * its space from the first frame (opacity only), so nothing shifts when it
 * shows or when the content replaces it.
 *
 * Only after a click: on the server-rendered first paint the placeholder is
 * visible at once (there is nothing on screen yet to keep). Reduced motion:
 * no delay, no fade.
 */
export function LoadingGrace({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotionSafe();
  const fresh = useFreshMount();
  return (
    <m.div data-ns-motion="" className={className} {...(fresh ? loadingGraceProps(reduced) : {})}>
      {children}
    </m.div>
  );
}
