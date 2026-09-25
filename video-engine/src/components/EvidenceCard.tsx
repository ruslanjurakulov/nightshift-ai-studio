import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible } from "../types";

/** One row: a claim and the advisory fact-checker's status (raw string or null). */
export type EvidenceItem = { text: string; status: string | null };

type Icon = "check" | "cross" | "question" | "dash";
type StatusLook = { label: string; color: string; icon: Icon; verdict: boolean };

// The fact-checker's vocabulary (modules/fact_checker.VALID_VERDICTS plus
// claim_scenes.STATUS_NOT_CHECKED). Semantic colours, not palette colours:
// "inaccurate" must not turn gold because a channel's accent is gold.
const STATUS = new Map<string, StatusLook>([
  ["likely_accurate", { label: "Likely accurate", color: "#4caf7a", icon: "check", verdict: true }],
  ["likely_inaccurate", { label: "Likely inaccurate", color: "#e0574f", icon: "cross", verdict: true }],
  ["unverifiable", { label: "Unverifiable", color: "#d9a441", icon: "question", verdict: true }],
  ["not_checked", { label: "Not checked", color: "#8b9098", icon: "dash", verdict: false }],
]);
// No status, or one the engine does not know: shown as unknown, never as a
// verdict and never as "not checked" (we do not know that either).
const UNKNOWN: StatusLook = { label: "Status unknown", color: "#8b9098", icon: "dash", verdict: false };

export const statusLook = (status: string | null | undefined): StatusLook =>
  STATUS.get(String(status ?? "").trim().toLowerCase()) ?? UNKNOWN;

const ICON_PATH: Record<Icon, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M7 7l10 10M17 7L7 17",
  question: "M9 9.2a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.9V15M12 18.2v.3",
  dash: "M7 12h10",
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * `evidence_card`: up to three claims, each followed by the fact-check status
 * stamped in after it. With no claims in the props the card is neutral: the
 * narration's first sentence with "Status unknown" — never a guessed verdict.
 */
export const EvidenceCard: React.FC<{ items: EvidenceItem[]; style: StyleBible }> = ({ items, style }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: d, fps, width, height } = useVideoConfig();
  const { palette } = style;
  const rows = items.slice(0, 3);
  const single = rows.length === 1;
  const outLen = Math.min(Math.round(0.4 * fps), Math.floor(d / 4));
  const fadeOut = outLen > 0 ? interpolate(frame, [d - outLen, d - 1], [1, 0], clamp) : 1;
  const anyVerdict = rows.some((r) => statusLook(r.status).verdict || r.status === "not_checked");
  // Stagger rows over at most half the scene.
  const gap = Math.min(0.6 * fps, (d * 0.5) / Math.max(1, rows.length));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.background,
        justifyContent: "center",
        alignItems: "center",
        paddingBottom: height * 0.06,
        opacity: fadeOut,
      }}
    >
      <div style={{ width: width * 0.72 }}>
        <div
          style={{
            fontFamily: style.body_font,
            color: palette.accent,
            fontSize: width * 0.015,
            letterSpacing: "0.3em",
            textTransform: "uppercase",
            marginBottom: width * 0.018,
            opacity: interpolate(frame, [0, 0.3 * fps], [0, 1], clamp),
          }}
        >
          {single ? "The claim" : "The claims"}
        </div>
        {rows.map((r, i) => {
          const look = statusLook(r.status);
          const at = 0.25 * fps + i * gap;
          const rowIn = interpolate(frame, [at, at + 0.4 * fps], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          const stamp = interpolate(frame, [at + 0.5 * fps, at + 0.75 * fps], [0, 1], {
            ...clamp,
            easing: Easing.out(Easing.back(2.2)),
          });
          const icon = width * (single ? 0.022 : 0.017);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                gap: width * 0.016,
                marginBottom: width * 0.018,
                opacity: rowIn,
                transform: `translateY(${(1 - rowIn) * 18}px)`,
              }}
            >
              <div style={{ width: Math.max(3, width * 0.004), backgroundColor: look.color, flexShrink: 0 }} />
              <div>
                <div
                  style={{
                    fontFamily: style.heading_font,
                    color: palette.primary,
                    fontSize: width * (single ? 0.032 : 0.022),
                    lineHeight: 1.25,
                  }}
                >
                  {r.text}
                </div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: width * 0.006,
                    marginTop: width * 0.008,
                    padding: `${width * 0.003}px ${width * 0.009}px ${width * 0.003}px ${width * 0.005}px`,
                    border: `${Math.max(2, width * 0.0015)}px solid ${look.color}`,
                    borderRadius: width * 0.004,
                    color: look.color,
                    fontFamily: style.body_font,
                    fontWeight: 700,
                    fontSize: width * (single ? 0.016 : 0.013),
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    opacity: stamp > 0 ? 1 : 0,
                    transform: `scale(${0.6 + 0.4 * stamp})`,
                    transformOrigin: "0 50%",
                  }}
                >
                  <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none">
                    <path d={ICON_PATH[look.icon]} stroke={look.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {look.label}
                </div>
              </div>
            </div>
          );
        })}
        {anyVerdict ? (
          <div
            style={{
              fontFamily: style.body_font,
              color: palette.primary,
              opacity: 0.55 * interpolate(frame, [0.25 * fps + rows.length * gap, 0.25 * fps + rows.length * gap + 0.4 * fps], [0, 1], clamp),
              fontSize: width * 0.011,
              letterSpacing: "0.08em",
              marginTop: width * 0.004,
            }}
          >
            Automated fact-check · advisory
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
