import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible } from "../types";

export type TitleVariant = "title" | "chapter";

type Props = {
  variant: TitleVariant;
  /** Main line: the title or chapter name. */
  heading: string;
  /** Small line above the heading (e.g. "Chapter 3"); optional. */
  kicker?: string | null;
  style: StyleBible;
};

/**
 * Title / chapter card (recipes `title_card`, `chapter_card`; `quote_card` has
 * its own QuoteCard). Fades and rises in over 0.6 s, fades out over the last 0.4 s.
 */
export const TitleCard: React.FC<Props> = ({ variant, heading, kicker, style }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const inEnd = Math.max(1, Math.round(0.6 * fps));
  const outLen = Math.min(Math.round(0.4 * fps), Math.floor(durationInFrames / 3));
  const opacityIn = interpolate(frame, [0, inEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacityOut =
    outLen > 0
      ? interpolate(frame, [durationInFrames - outLen, durationInFrames - 1], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const rise = interpolate(frame, [0, inEnd], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const { palette } = style;
  const size = variant === "chapter" ? width * 0.05 : width * 0.062;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.background,
        justifyContent: "center",
        alignItems: "center",
        padding: width * 0.08,
      }}
    >
      <div
        style={{
          opacity: Math.min(opacityIn, opacityOut),
          transform: `translateY(${rise}px)`,
          textAlign: "center",
          maxWidth: width * 0.8,
        }}
      >
        {kicker ? (
          <div
            style={{
              fontFamily: style.body_font,
              color: palette.accent,
              fontSize: width * 0.016,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              marginBottom: width * 0.012,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: style.heading_font,
            color: palette.primary,
            fontSize: size,
            lineHeight: 1.15,
          }}
        >
          {heading}
        </div>
        <div
          style={{
            margin: `${width * 0.016}px auto 0`,
            width: width * 0.06,
            height: Math.max(2, width * 0.002),
            backgroundColor: palette.accent,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
