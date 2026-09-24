import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Stat } from "../text";
import type { StyleBible } from "../types";

type Props = {
  stat: Stat;
  label?: string | null;
  style: StyleBible;
};

/** Number counter (recipe `stat_counter`): counts 0 → value over the first
 * 60% of the scene (max 2 s), then holds. */
export const StatCard: React.FC<Props> = ({ stat, label, style }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const countEnd = Math.max(1, Math.min(Math.round(2 * fps), Math.round(durationInFrames * 0.6)));
  const progress = interpolate(frame, [0, countEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const shown = (stat.value * progress).toLocaleString("en-US", {
    minimumFractionDigits: stat.decimals,
    maximumFractionDigits: stat.decimals,
  });
  const { palette } = style;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontFamily: style.heading_font,
            color: palette.accent,
            fontSize: width * 0.1,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {stat.prefix}
          {shown}
          {stat.suffix}
        </div>
        {label ? (
          <div
            style={{
              fontFamily: style.body_font,
              color: palette.primary,
              fontSize: width * 0.022,
              marginTop: width * 0.015,
              opacity: interpolate(frame, [countEnd * 0.5, countEnd], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            {label}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
