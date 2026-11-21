"use client";

import { setMotionPaused, useMotionPaused, useMotionTap } from "@/lib/site/motion";

/**
 * "Pause motion": the one control that stops everything on the page that moves by itself (WCAG 2.2.2). It reads and writes
 * lib/site/motion.ts. It is a toggle button: the name stays "Pause motion" and `aria-pressed` says whether motion is paused now.
 *
 * The owner wants neither the word nor an icon visible on the public site (2026-11-13). So it is visually hidden until a keyboard
 * focuses it (site-next.css, the skip-link pattern): keyboard and screen-reader visitors can still stop motion, and a pointer
 * stops it by tapping the moving picture (components/site/LoopClip.tsx). With reduced motion already asked for there is nothing
 * to pause, so the stylesheet hides it.
 */
export function MotionToggle({ pause }: { pause: string }) {
  const paused = useMotionPaused();
  useMotionTap();
  return (
    <div className="nx-motion">
      <button type="button" className="nx-motion-btn" aria-pressed={paused} onClick={() => setMotionPaused(!paused)}>
        {pause}
      </button>
    </div>
  );
}
