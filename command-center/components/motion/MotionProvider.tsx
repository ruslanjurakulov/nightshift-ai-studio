"use client";

import { LazyMotion, MotionConfig } from "motion/react";
import { DURATION, EASE } from "@/lib/motion/tokens";

// The animation engine is fetched after hydration, as its own chunk; until it
// lands, every `m.*` element is plain markup in its final (or SSR) state.
const loadFeatures = () => import("@/lib/motion/features").then((mod) => mod.default);

const DEFAULT_TRANSITION = { duration: DURATION.state, ease: EASE.standard };

/**
 * Mounted once, in the root layout. `strict` makes any use of the heavy
 * `motion.*` component throw in development, so the kit stays on the slim
 * `m.*` path. `reducedMotion="user"` is Motion's own guard (it drops
 * transform animations for a reduced-motion reader); the kit goes further and
 * hands out no animation at all in that case (lib/motion/presets.ts).
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user" transition={DEFAULT_TRANSITION}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
