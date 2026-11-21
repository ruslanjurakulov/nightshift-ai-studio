"use client";

import { div as MDiv } from "motion/react-m";
import { useStill } from "@/components/motion/hooks";
import { DURATION, EASE } from "@/lib/motion/tokens";

/**
 * The timeline's playhead. It rests at `at` (a percentage of the timeline)
 * and, on the server-rendered first paint, travels in from the start once:
 * a transform on a wrapper as wide as the distance it covers, so nothing
 * lays out. Reduced motion, no engine, a failed engine: it is simply at `at`
 * (the kit's rule, components/motion/hooks.ts useStill).
 */
export function Playhead({ at, children }: { at: number; children: React.ReactNode }) {
  const still = useStill();
  return (
    <MDiv
      data-ns-motion=""
      data-ns-reveal=""
      className="ac-c-playhead-run"
      style={{ width: `${at}%` }}
      {...(still
        ? {}
        : {
            initial: { x: "-100%", opacity: 0 },
            animate: { x: "0%", opacity: 1 },
            transition: { duration: DURATION.scene * 1.6, ease: EASE.standard, delay: 0.2 },
          })}
    >
      {children}
    </MDiv>
  );
}
