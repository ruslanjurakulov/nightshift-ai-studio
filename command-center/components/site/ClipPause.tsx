"use client";

import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";

/**
 * The page's pause switch at each clip, for a keyboard. It is the same switch as the hero's (lib/site/motion.ts): pressing either
 * stops every clip, the drifting light and the rail, and the other shows it pressed. The owner wants no visible pause word or icon
 * on the public site (2026-11-13), so it is visually hidden until a keyboard focuses it (site-next.css), and then shows its words
 * on the picture; a pointer pauses by tapping the clip itself (components/site/LoopClip.tsx). Screen readers reach it as a toggle
 * button named "Pause motion", `aria-pressed` when paused (WCAG 2.2.2). The stylesheet hides it under reduced motion, where
 * nothing moves.
 */
export function ClipPause({ label }: { label: string }) {
  const paused = useMotionPaused();
  return (
    <button type="button" className="nx-clip-pause" aria-pressed={paused} onClick={() => setMotionPaused(!paused)}>
      {label}
    </button>
  );
}
