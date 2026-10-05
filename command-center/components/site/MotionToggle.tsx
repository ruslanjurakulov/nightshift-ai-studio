"use client";

import { Pause, Play } from "lucide-react";
import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";

/**
 * "Pause motion": the one control that stops everything on the page that moves
 * by itself (WCAG 2.2.2). It reads and writes lib/site/motion.ts. It is a
 * toggle button: the name stays "Pause motion" and `aria-pressed` says whether
 * motion is paused now (the icon and the tint follow). With reduced motion
 * already asked for there is nothing to pause, so the stylesheet hides it.
 */
export function MotionToggle({ pause }: { pause: string }) {
  const paused = useMotionPaused();
  return (
    <div className="nx-motion">
      <button type="button" className="nx-motion-btn" aria-pressed={paused} onClick={() => setMotionPaused(!paused)}>
        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        {pause}
      </button>
    </div>
  );
}
