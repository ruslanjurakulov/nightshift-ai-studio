import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible } from "../types";

type Props = {
  /** The quotation, without its quote marks. */
  text: string;
  /** Who said it, only when the narration names them; else null. */
  attribution: string | null;
  style: StyleBible;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * `quote_card`: a large accent quote mark, the quotation revealed word by word
 * in the heading font (italic), then a rule and the attribution. Type size
 * steps down with length so a long quotation still fits the frame.
 */
export const QuoteCard: React.FC<Props> = ({ text, attribution, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d, fps, width, height } = useVideoConfig();
  const { palette } = style;
  const words = text.split(/\s+/).filter(Boolean);
  const size = width * (words.length <= 12 ? 0.046 : words.length <= 25 ? 0.036 : 0.028);
  // Reveal over at most 45% of the scene (and at most 2.5 s).
  const start = Math.round(0.3 * fps);
  const revealLen = Math.max(1, Math.min(Math.round(2.5 * fps), Math.round(d * 0.45)));
  const step = revealLen / Math.max(1, words.length);
  const done = start + revealLen;
  const markIn = interpolate(frame, [0, start + 4], [0, 1], clamp);
  const attrIn = interpolate(frame, [done, done + 0.4 * fps], [0, 1], clamp);
  const outLen = Math.min(Math.round(0.4 * fps), Math.floor(d / 4));
  const fadeOut = outLen > 0 ? interpolate(frame, [d - outLen, d - 1], [1, 0], clamp) : 1;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 18% 22%, ${palette.accent} 0%, rgba(0,0,0,0) 55%)`,
          opacity: 0.12,
        }}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          paddingBottom: height * 0.08, // leave the caption band clear
          opacity: fadeOut,
        }}
      >
        <div style={{ position: "relative", maxWidth: width * 0.74 }}>
          <div
            style={{
              position: "absolute",
              left: -width * 0.07,
              top: -size * 1.1,
              fontFamily: style.heading_font,
              fontSize: width * 0.14,
              lineHeight: 1,
              color: palette.accent,
              opacity: 0.85 * markIn,
              transform: `translateY(${(1 - markIn) * 20}px)`,
            }}
          >
            “
          </div>
          <div
            style={{
              fontFamily: style.heading_font,
              fontStyle: "italic",
              color: palette.primary,
              fontSize: size,
              lineHeight: 1.25,
            }}
          >
            {words.map((w, i) => {
              const at = start + i * step;
              const o = interpolate(frame, [at, at + Math.max(2, 0.25 * fps)], [0, 1], clamp);
              return (
                <span key={i} style={{ opacity: o }}>
                  {w}
                  {i < words.length - 1 ? " " : "”"}
                </span>
              );
            })}
          </div>
          {attribution ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: width * 0.012,
                marginTop: size * 0.7,
                opacity: attrIn,
                transform: `translateX(${(1 - attrIn) * -14}px)`,
              }}
            >
              <div style={{ width: width * 0.04, height: Math.max(2, width * 0.002), backgroundColor: palette.accent }} />
              <div
                style={{
                  fontFamily: style.body_font,
                  color: palette.accent,
                  fontSize: width * 0.017,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                }}
              >
                {attribution}
              </div>
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
