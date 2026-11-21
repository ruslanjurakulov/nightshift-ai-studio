import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible } from "../types";

type Props = {
  name: string;
  label?: string | null;
  style: StyleBible;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * A name/label strip over an image, video or map scene. It wipes in from the
 * left at 0.4 s and wipes out over the scene's last 0.5 s. It sits at the
 * bottom-left, above the caption band (captions are centred at the bottom).
 */
export const LowerThird: React.FC<Props> = ({ name, label, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d, fps, width, height } = useVideoConfig();
  const { palette } = style;
  const inStart = Math.min(Math.round(0.4 * fps), Math.floor(d / 4));
  const inLen = Math.max(1, Math.round(0.5 * fps));
  const outLen = Math.max(1, Math.min(Math.round(0.5 * fps), Math.floor(d / 4)));
  const wipe =
    interpolate(frame, [inStart, inStart + inLen], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) }) *
    interpolate(frame, [d - outLen, d - 1], [1, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
  const textIn = interpolate(frame, [inStart + inLen * 0.5, inStart + inLen * 1.3], [0, 1], clamp);
  const bar = Math.max(3, width * 0.004);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: width * 0.06,
          bottom: height * 0.2,
          display: "flex",
          alignItems: "stretch",
          clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)`,
        }}
      >
        <div style={{ width: bar, backgroundColor: palette.accent }} />
        <div
          style={{
            backgroundColor: palette.background,
            padding: `${width * 0.008}px ${width * 0.016}px`,
            boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              fontFamily: style.heading_font,
              color: palette.text,
              fontSize: width * 0.026,
              lineHeight: 1.15,
              whiteSpace: "nowrap",
              opacity: textIn,
            }}
          >
            {name}
          </div>
          {label ? (
            <div
              style={{
                fontFamily: style.body_font,
                color: palette.accent,
                fontSize: width * 0.013,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                marginTop: width * 0.003,
                whiteSpace: "nowrap",
                opacity: textIn,
              }}
            >
              {label}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
