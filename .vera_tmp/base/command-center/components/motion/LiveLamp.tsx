"use client";

import { useState } from "react";
import { span as MSpan } from "motion/react-m";
import { useStill } from "./hooks";
import { lampStrikeProps } from "@/lib/motion/presets";
import type { LampTone } from "@/components/ui/StatusLamp";

/**
 * <StatusLamp> for a state that changes while the person watches (a job going
 * from running to done). The markup and classes are StatusLamp's own, so it
 * looks identical at rest; when `tone` changes the lamp strikes once — a short
 * scale-and-light beat, transform and opacity only — and holds. A lamp that
 * was already lit when the screen loaded does not strike. Running keeps its
 * CSS breathing (globals.css), which reduced motion already stills.
 *
 * The word beside the lamp always says the state, so the strike is never the
 * only signal. Announcing the change is the caller's job (an aria-live region
 * around the row), as it is for StatusLamp.
 */
export function LiveLamp({
  tone,
  label,
  live = false,
  hideLabel = false,
  size = "sm",
  className,
}: {
  tone: LampTone;
  label: string;
  live?: boolean;
  hideLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const still = useStill();
  // Counting changes during render (React's "adjust state when a prop
  // changes" pattern) keys the lamp, so each change remounts it and plays the
  // strike from its start — even when a new change interrupts the last one.
  const [seen, setSeen] = useState(tone);
  const [strikes, setStrikes] = useState(0);
  if (tone !== seen) {
    setSeen(tone);
    setStrikes((n) => n + 1);
  }
  return (
    <span className={`ns-lamp-row${className ? ` ${className}` : ""}`} data-tone={tone}>
      <MSpan
        key={strikes}
        aria-hidden
        data-ns-motion=""
        className="ns-lamp"
        data-tone={tone}
        data-live={live ? "true" : undefined}
        data-size={size}
        {...lampStrikeProps(still, strikes > 0)}
      />
      <span className={hideLabel ? "sr-only" : "ns-lamp-label"}>{label}</span>
    </span>
  );
}
