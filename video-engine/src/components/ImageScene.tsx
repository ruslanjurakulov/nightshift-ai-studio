import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible } from "../types";

/** Motion recipes this component executes (modules/shot_recipes.py ids). */
export const IMAGE_RECIPES = [
  "slow_push",
  "slow_pull",
  "lateral_pan",
  "parallax",
  "archival_reveal",
  "map_zoom",
] as const;

type Props = {
  /** Resolved src (staticFile(...)) or null for a palette-only background. */
  src: string | null;
  recipe: string;
  style: StyleBible;
};

const ease = Easing.inOut(Easing.cubic);

/**
 * A still image animated by a Ken Burns-style recipe. Pure function of the
 * frame: progress p = frame / (duration - 1) drives scale/translate.
 */
export const ImageScene: React.FC<Props> = ({ src, recipe, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

  let scale = 1;
  let x = 0;
  switch (recipe) {
    case "slow_pull":
      scale = interpolate(p, [0, 1], [1.12, 1]);
      break;
    case "lateral_pan":
      scale = 1.15;
      x = interpolate(p, [0, 1], [-0.05, 0.05]) * width;
      break;
    case "map_zoom":
      scale = interpolate(p, [0, 1], [1, 1.6]);
      break;
    case "parallax":
      scale = 1.08;
      x = interpolate(p, [0, 1], [0.03, -0.03]) * width;
      break;
    default: // slow_push, archival_reveal and anything unknown
      scale = interpolate(p, [0, 1], [1, 1.12]);
  }

  const archival = recipe === "archival_reveal";
  const filter = archival ? "grayscale(1) sepia(0.35) contrast(1.1)" : undefined;
  const background = `linear-gradient(135deg, ${style.palette.background} 0%, ${style.palette.accent} 100%)`;

  const layer = (s: number, dx: number, blur?: number) =>
    src ? (
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `translateX(${dx}px) scale(${s})`,
          filter: [filter, blur ? `blur(${blur}px)` : ""].filter(Boolean).join(" ") || undefined,
        }}
      />
    ) : null;

  return (
    <AbsoluteFill style={{ background, overflow: "hidden" }}>
      {recipe === "parallax" && src ? (
        <>
          {/* Background layer drifts the opposite way, slower and blurred. */}
          <AbsoluteFill>{layer(scale * 1.1, -x * 0.5, 12)}</AbsoluteFill>
          <AbsoluteFill style={{ transform: "scale(0.82)", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }}>
            {layer(scale, x)}
          </AbsoluteFill>
        </>
      ) : (
        <AbsoluteFill>{layer(scale, x)}</AbsoluteFill>
      )}
      {archival ? (
        <AbsoluteFill
          style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.7) 100%)" }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
