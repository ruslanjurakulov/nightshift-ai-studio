"use client";

import { Pause } from "lucide-react";
import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";

/**
 * The page's pause switch, put on the picture of each clip (top right), so it is within reach wherever a clip is on the
 * screen, not only in the hero. It is the same switch as the hero's "Pause motion" (lib/site/motion.ts): pressing either
 * stops every clip, the drifting light and the rail, and the other shows it pressed. A toggle button named "Pause motion",
 * 44 px, `aria-pressed` when paused; the stylesheet hides it under reduced motion, where nothing moves.
 */
export function ClipPause({ label }: { label: string }) {
  const paused = useMotionPaused();
  return (
    <button type="button" className="nx-clip-pause" aria-pressed={paused} aria-label={label} title={label} onClick={() => setMotionPaused(!paused)}>
      <Pause aria-hidden />
    </button>
  );
}
