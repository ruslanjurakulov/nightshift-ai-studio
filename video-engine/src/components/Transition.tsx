import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

type Props = {
  /** "crossfade" | "dip_to_black" | "hard_cut" (modules/shot_recipes ids). */
  kind?: string | null;
  /** Transition length in seconds. */
  seconds?: number;
  /** Colour a crossfade softens in from (the style palette background). */
  background?: string;
  children: React.ReactNode;
};

/**
 * The transition INTO a scene, applied to the scene's own frames. A scene is
 * rendered on its own, so the previous scene's pixels are not available here —
 * a true dissolve between two scene clips is the assembly step's job (ffmpeg
 * `xfade`). Within the scene: `crossfade` is a short soft-in from the style's
 * background colour, `dip_to_black` fades up from black, and `hard_cut` (or
 * anything unknown) leaves the frames untouched.
 */
export const Transition: React.FC<Props> = ({ kind, seconds = 0.5, background = "#000", children }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const len = Math.min(Math.max(1, Math.round(seconds * fps)), Math.max(1, Math.floor(durationInFrames / 2)));
  const t = interpolate(frame, [0, len], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  if (kind === "crossfade" || kind === "dip_to_black") {
    const from = kind === "crossfade" ? background : "#000";
    return (
      <AbsoluteFill>
        {children}
        <AbsoluteFill style={{ backgroundColor: from, opacity: 1 - t }} />
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill>{children}</AbsoluteFill>;
};
