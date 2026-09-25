import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { MapFocus, StyleBible } from "../types";

type Props = {
  /** Resolved src of a static map image (a local asset — no tiles, no API). */
  src: string;
  /** Where to zoom, as a fraction of the opening frame; null = centre, no pin. */
  focus: MapFocus | null;
  /** Place name shown next to the pin (or as a tag when there is no focus). */
  label: string | null;
  style: StyleBible;
};

const MAX_SCALE = 2.0;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampRange = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * `map_zoom`: a slow zoom from the wide map toward the focus point. The focus
 * travels toward the frame centre as the scale grows, but the translation is
 * clamped so the image always covers the frame (no empty edge at a corner
 * focus). The pin is drawn outside the zoomed layer at the focus' screen
 * position, so it stays a constant size while the map grows under it.
 */
export const MapScene: React.FC<Props> = ({ src, focus, label, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d, fps, width, height } = useVideoConfig();
  const last = Math.max(1, d - 1);
  const p = interpolate(frame, [0, last], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const f = focus ? { x: clamp01(focus.x), y: clamp01(focus.y) } : { x: 0.5, y: 0.5 };
  const scale = interpolate(p, [0, 1], [1, MAX_SCALE]);
  const fx = f.x * width;
  const fy = f.y * height;
  // Screen position the focus should reach at this progress, then the
  // translation that puts it there — clamped so the map still fills the frame.
  const tx = clampRange(fx + (width / 2 - fx) * p - scale * fx, width - scale * width, 0);
  const ty = clampRange(fy + (height / 2 - fy) * p - scale * fy, height - scale * height, 0);
  const sx = tx + scale * fx;
  const sy = ty + scale * fy;

  const { palette } = style;
  const pinIn = interpolate(frame, [last * 0.3, last * 0.3 + 0.35 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.6)),
  });
  const labelIn = interpolate(frame, [last * 0.3 + 0.3 * fps, last * 0.3 + 0.8 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // A ring that pulses out from the pin once per second: frame-derived only.
  const period = Math.max(1, Math.round(fps));
  const pulse = (frame % period) / period;
  const pin = width * 0.022;
  const onRight = sx < width * 0.68;
  const labelText = (label ?? "").trim();

  const tag = (
    <div
      style={{
        fontFamily: style.body_font,
        fontSize: width * 0.019,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: palette.text,
        backgroundColor: palette.background,
        borderLeft: `${Math.max(3, width * 0.003)}px solid ${palette.accent}`,
        padding: `${width * 0.006}px ${width * 0.012}px`,
        whiteSpace: "nowrap",
        boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
      }}
    >
      {labelText}
    </div>
  );

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height,
          transformOrigin: "0 0",
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        }}
      >
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,0.55) 100%)" }}
      />
      {focus ? (
        <>
          <div
            style={{
              position: "absolute",
              left: sx - pin * 1.5,
              top: sy - pin * 1.5,
              width: pin * 3,
              height: pin * 3,
              borderRadius: "50%",
              border: `${Math.max(2, width * 0.002)}px solid ${palette.accent}`,
              transform: `scale(${0.4 + pulse * 1.1})`,
              opacity: pinIn * (1 - pulse),
            }}
          />
          <svg
            width={pin * 1.4}
            height={pin * 2}
            viewBox="0 0 14 20"
            style={{
              position: "absolute",
              left: sx - pin * 0.7,
              top: sy - pin * 2,
              transformOrigin: "50% 100%",
              transform: `scale(${pinIn})`,
              filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.6))",
            }}
          >
            <path d="M7 0C3.1 0 0 3.1 0 7c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z" fill={palette.accent} />
            <circle cx="7" cy="7" r="2.6" fill={palette.background} />
          </svg>
          {labelText ? (
            <div
              style={{
                position: "absolute",
                top: sy - pin * 1.6,
                ...(onRight ? { left: sx + pin * 1.2 } : { right: width - sx + pin * 1.2 }),
                opacity: labelIn,
                transform: `translateX(${(1 - labelIn) * (onRight ? -16 : 16)}px)`,
              }}
            >
              {tag}
            </div>
          ) : null}
        </>
      ) : labelText ? (
        // No focus point: name the place, but do not point at a guessed spot.
        <div style={{ position: "absolute", left: width * 0.06, top: height * 0.08, opacity: labelIn }}>{tag}</div>
      ) : null}
    </AbsoluteFill>
  );
};
