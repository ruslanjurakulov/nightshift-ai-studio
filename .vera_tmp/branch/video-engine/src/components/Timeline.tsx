import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { TimelineEvent } from "../text";
import type { StyleBible } from "../types";

type Props = {
  /** Sorted by date (text.extractTimeline); at least one. */
  events: TimelineEvent[];
  /** Small line above the axis (the scene name); optional. */
  heading?: string | null;
  style: StyleBible;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * `timeline`: a horizontal axis draws in left to right; each dated event pops
 * in as the line reaches it, date above, words below. Markers are evenly
 * spaced (the order is real; the spacing is not to scale), so five close dates
 * never pile on top of each other.
 */
export const Timeline: React.FC<Props> = ({ events, heading, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d, fps, width, height } = useVideoConfig();
  const { palette } = style;
  const n = Math.max(1, events.length);
  const x0 = width * 0.08;
  const x1 = width * 0.92;
  const axisY = height * 0.52;
  const drawStart = Math.round(0.2 * fps);
  const drawLen = Math.max(1, Math.min(Math.round(1.4 * fps), Math.round(d * 0.4)));
  const drawn = interpolate(frame, [drawStart, drawStart + drawLen], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });
  const outLen = Math.min(Math.round(0.4 * fps), Math.floor(d / 4));
  const fadeOut = outLen > 0 ? interpolate(frame, [d - outLen, d - 1], [1, 0], clamp) : 1;
  const slot = (x1 - x0) / n;
  const stroke = Math.max(2, width * 0.0022);

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, opacity: fadeOut }}>
      {heading ? (
        <div
          style={{
            position: "absolute",
            top: height * 0.26,
            width: "100%",
            textAlign: "center",
            fontFamily: style.body_font,
            color: palette.accent,
            fontSize: width * 0.016,
            letterSpacing: "0.3em",
            textTransform: "uppercase",
            opacity: interpolate(frame, [0, drawStart + 6], [0, 1], clamp),
          }}
        >
          {heading}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: x0,
          top: axisY - stroke / 2,
          width: (x1 - x0) * drawn,
          height: stroke,
          backgroundColor: palette.primary,
          opacity: 0.7,
        }}
      />
      {events.map((e, i) => {
        const cx = x0 + slot * (i + 0.5);
        // The marker appears when the drawing line reaches it.
        const at = drawStart + drawLen * ((cx - x0) / (x1 - x0));
        const pop = interpolate(frame, [at, at + 0.25 * fps], [0, 1], {
          ...clamp,
          easing: Easing.out(Easing.back(2)),
        });
        const text = interpolate(frame, [at + 0.1 * fps, at + 0.5 * fps], [0, 1], clamp);
        const dot = width * 0.012;
        return (
          <React.Fragment key={`${e.date}-${i}`}>
            <div
              style={{
                position: "absolute",
                left: cx - dot / 2,
                top: axisY - dot / 2,
                width: dot,
                height: dot,
                borderRadius: "50%",
                backgroundColor: palette.accent,
                boxShadow: `0 0 0 ${stroke * 2}px ${palette.background}`,
                transform: `scale(${pop})`,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: cx - slot / 2,
                width: slot,
                bottom: height - axisY + dot * 1.4,
                textAlign: "center",
                fontFamily: style.heading_font,
                color: palette.accent,
                fontSize: width * (n > 3 ? 0.03 : 0.038),
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
                opacity: text,
                transform: `translateY(${(1 - text) * 12}px)`,
              }}
            >
              {e.date}
            </div>
            {e.label ? (
              <div
                style={{
                  position: "absolute",
                  left: cx - slot * 0.45,
                  width: slot * 0.9,
                  top: axisY + dot * 1.6,
                  textAlign: "center",
                  fontFamily: style.body_font,
                  color: palette.primary,
                  fontSize: width * (n > 3 ? 0.015 : 0.018),
                  lineHeight: 1.3,
                  opacity: text,
                  transform: `translateY(${(1 - text) * -12}px)`,
                }}
              >
                {e.label}
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
