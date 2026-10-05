"use client";

import { Pause, Play } from "lucide-react";
import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";

/**
 * "Pause motion": the one control that stops everything on the page that moves
 * by itself (WCAG 2.2.2). It reads and writes lib/site/motion.ts. With reduced
 * motion already asked for there is nothing to pause, so the stylesheet hides
 * it. The label says what pressing it does, so it needs no pressed state.
 */
export function MotionToggle({ pause, play }: { pause: string; play: string }) {
  const paused = useMotionPaused();
  return (
    <div className="nx-motion">
      <button type="button" className="nx-motion-btn" onClick={() => setMotionPaused(!paused)}>
        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
        {paused ? play : pause}
      </button>
    </div>
  );
}
