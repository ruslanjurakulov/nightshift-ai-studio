"use client";

import { Pause, Play } from "lucide-react";
import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";

/**
 * Pause by touching the clip. The owner's rule of 2026-11-13: no visible "Pause motion" button (word or icon) on the public
 * site. So this is one transparent button over the clip's whole box: a tap or click anywhere on the clip toggles the page's
 * pause switch (lib/site/motion.ts, the same one every clip obeys), and for a keyboard it is a real, named toggle that shows
 * its ring and icon only while it has keyboard focus (components/site/model-pages.css .ml-tap). Reduced motion needs none of
 * it: nothing plays there (LoopClip), and the stylesheet removes it.
 */
export function ClipTapPause({ label }: { label: string }) {
  const paused = useMotionPaused();
  return (
    <button type="button" className="ml-tap" aria-pressed={paused} aria-label={label} onClick={() => setMotionPaused(!paused)}>
      <span className="ml-tap-key" aria-hidden>
        {paused ? <Play /> : <Pause />}
      </span>
    </button>
  );
}
