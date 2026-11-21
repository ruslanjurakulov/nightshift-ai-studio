"use client";

import { LazyMotion, MotionConfig } from "motion/react";
import { DURATION, EASE } from "@/lib/motion/tokens";
import { MotionEngineContext, loadMotionFeatures } from "./engine";

// The animation engine is fetched after hydration, as its own chunk; until it
// lands, every `m.*` element is plain markup in its final (or SSR) state. If it
// cannot be fetched (one retry, then a timeout) the kit falls back to no
// motion at all — see ./engine.ts.
const loadFeatures = () => loadMotionFeatures(() => import("@/lib/motion/features").then((mod) => mod.default));

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
    <MotionEngineContext.Provider value={true}>
      <LazyMotion features={loadFeatures} strict>
        <MotionConfig reducedMotion="user" transition={DEFAULT_TRANSITION}>
          {children}
        </MotionConfig>
      </LazyMotion>
    </MotionEngineContext.Provider>
  );
}
