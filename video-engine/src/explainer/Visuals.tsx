import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { SANS, type Look } from "./looks";
import { statShown } from "./text";
import type { Mood, Tone, Visual } from "./types";

/** Every panel enters the same way: a short rise and fade, so scenes read as one system. */
const useEnter = (delayFrames = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = spring({ frame: frame - delayFrames, fps, config: { damping: 18, stiffness: 120 } });
  return { opacity: t, transform: `translateY(${(1 - t) * 40}px) scale(${0.96 + 0.04 * t})` };
};

const panelStyle = (look: Look, w: number): React.CSSProperties => ({
  width: w,
  background: look.panel,
  color: look.panelText,
  borderRadius: 28,
  padding: "44px 52px",
  boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
  fontFamily: SANS,
});

const toneColor = (look: Look, tone?: Tone) => (tone === "good" ? look.good : tone === "bad" ? look.bad : look.panelText);

/** A list card that fills row by row (an invoice, a price list, a plan). */
const Card: React.FC<{ v: Extract<Visual, { kind: "card" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = useEnter();
  // Rows arrive across the first 60% of the scene, so the last one lands while it is still being said.
  const step = Math.max(6, Math.floor((seconds * fps * 0.6) / Math.max(1, v.rows.length + (v.total ? 1 : 0))));
  return (
    <div style={{ ...panelStyle(look, width), ...enter }}>
      <div style={{ fontSize: 46, fontWeight: 700 }}>{v.title}</div>
      {v.subtitle ? <div style={{ fontSize: 30, color: look.panelMuted, marginTop: 6 }}>{v.subtitle}</div> : null}
      <div style={{ marginTop: 34 }}>
        {v.rows.map((r, i) => {
          const o = interpolate(frame, [i * step, i * step + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 36, padding: "12px 0", opacity: o }}>
              <span>{r.label}</span>
              <span style={{ fontWeight: 700, color: toneColor(look, r.tone) }}>{r.value}</span>
            </div>
          );
        })}
      </div>
      {v.total ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            borderTop: `2px solid ${look.panelMuted}55`,
            marginTop: 26,
            paddingTop: 24,
            opacity: interpolate(frame, [v.rows.length * step, v.rows.length * step + 10], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <span style={{ fontSize: 36 }}>{v.total.label}</span>
          <span style={{ fontSize: 64, fontWeight: 800, color: look.bad }}>{v.total.value}</span>
        </div>
      ) : null}
    </div>
  );
};

/** One big number that counts up when it can be parsed, else appears as written. */
const Stat: React.FC<{ v: Extract<Visual, { kind: "stat" }>; look: Look; width: number }> = ({ v, look, width }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = useEnter();
  // Only an unambiguous integer counts up; the last frame is always the value as said (statShown).
  const shown = statShown(v.value, interpolate(frame, [0, fps * 1.2], [0, 1], { extrapolateRight: "clamp" }));
  return (
    <div style={{ ...panelStyle(look, width), textAlign: "center", ...enter }}>
      <div style={{ fontSize: 150, fontWeight: 900, color: look.accent, lineHeight: 1 }}>{shown}</div>
      <div style={{ fontSize: 38, color: look.panelMuted, marginTop: 18 }}>{v.label}</div>
    </div>
  );
};

/** A render-style progress bar: label, a bar that creeps, a red note ("94 soat"). */
const Progress: React.FC<{ v: Extract<Visual, { kind: "progress" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = useEnter();
  const pct = Math.max(0, Math.min(100, v.percent));
  const shown = interpolate(frame, [0, seconds * fps * 0.8], [0, pct], { extrapolateRight: "clamp" });
  return (
    <div style={{ ...panelStyle(look, width), ...enter }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 30 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <div key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 34 }}>
        <span>{v.label}</span>
        <span style={{ fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', monospace" }}>{shown.toFixed(1)}%</span>
      </div>
      <div style={{ height: 14, background: `${look.panelMuted}44`, borderRadius: 7, marginTop: 18, overflow: "hidden" }}>
        <div style={{ width: `${shown}%`, height: "100%", background: look.bad }} />
      </div>
      {v.note ? <div style={{ fontSize: 30, color: look.bad, marginTop: 20, fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', monospace" }}>{v.note}</div> : null}
    </div>
  );
};

/** A round face: the one-line reaction shot. */
const Emoji: React.FC<{ mood: Mood; look: Look; size: number }> = ({ mood, look, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 9, stiffness: 140 } });
  const wobble = Math.sin(frame / 6) * (mood === "shocked" || mood === "angry" ? 4 : 1.5);
  const brow =
    mood === "worried" ? "M60 70 L85 62 M140 62 L115 70" : mood === "angry" ? "M60 62 L88 74 M140 62 L112 74" : mood === "thinking" ? "M60 66 L88 66 M115 58 L140 64" : "";
  const mouth =
    mood === "happy"
      ? "M70 125 Q100 155 130 125"
      : mood === "shocked"
        ? "M88 132 a12 14 0 1 0 24 0 a12 14 0 1 0 -24 0"
        : mood === "calm"
          ? "M78 130 Q100 140 122 130"
          : mood === "thinking"
            ? "M84 134 L116 128"
            : "M80 138 Q100 124 120 138";
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" style={{ transform: `scale(${s}) rotate(${wobble}deg)` }}>
      <circle cx="100" cy="100" r="92" fill="#1b1b1f" stroke={look.accent} strokeWidth="8" />
      <circle cx="75" cy="92" r="11" fill="#fff" />
      <circle cx="125" cy="92" r="11" fill="#fff" />
      {brow ? <path d={brow} stroke="#fff" strokeWidth="7" strokeLinecap="round" fill="none" /> : null}
      <path d={mouth} stroke="#fff" strokeWidth="7" strokeLinecap="round" fill={mood === "shocked" ? "#fff" : "none"} />
    </svg>
  );
};

/** Ticks that land one after another. */
const Checklist: React.FC<{ v: Extract<Visual, { kind: "checklist" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = Math.max(6, Math.floor((seconds * fps * 0.6) / Math.max(1, v.items.length)));
  return (
    <div style={{ width, display: "flex", flexDirection: "column", gap: 22, fontFamily: SANS }}>
      {v.items.map((it, i) => {
        const t = spring({ frame: frame - i * step, fps, config: { damping: 16 } });
        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: look.panel,
              color: look.panelText,
              borderRadius: 22,
              padding: "30px 36px",
              fontSize: 40,
              fontWeight: 700,
              opacity: t,
              transform: `translateX(${(1 - t) * -60}px)`,
              boxShadow: "0 18px 40px rgba(0,0,0,0.25)",
            }}
          >
            <span>{it}</span>
            <svg width="54" height="54" viewBox="0 0 54 54">
              <circle cx="27" cy="27" r="27" fill={look.good} />
              <path d="M15 28 L24 36 L40 19" stroke="#fff" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        );
      })}
    </div>
  );
};

/** A short message thread. */
const Chat: React.FC<{ v: Extract<Visual, { kind: "chat" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = Math.max(8, Math.floor((seconds * fps * 0.7) / Math.max(1, v.messages.length)));
  return (
    <div style={{ width, display: "flex", flexDirection: "column", gap: 20, fontFamily: SANS }}>
      {v.messages.map((m, i) => {
        const t = spring({ frame: frame - i * step, fps, config: { damping: 15 } });
        const right = m.side === "right";
        return (
          <div key={i} style={{ display: "flex", justifyContent: right ? "flex-end" : "flex-start", opacity: t, transform: `scale(${0.9 + 0.1 * t})` }}>
            <div
              style={{
                maxWidth: width * 0.78,
                background: right ? look.accent : look.panel,
                color: right ? "#08110b" : look.panelText,
                padding: "24px 32px",
                borderRadius: 30,
                fontSize: 38,
                lineHeight: 1.3,
              }}
            >
              {m.text}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const VisualPanel: React.FC<{ v: Visual; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  switch (v.kind) {
    case "card":
      return <Card v={v} look={look} width={width} seconds={seconds} />;
    case "stat":
      return <Stat v={v} look={look} width={width} />;
    case "progress":
      return <Progress v={v} look={look} width={width} seconds={seconds} />;
    case "emoji":
      return <Emoji mood={v.mood} look={look} size={Math.round(width * 0.55)} />;
    case "checklist":
      return <Checklist v={v} look={look} width={width} seconds={seconds} />;
    case "chat":
      return <Chat v={v} look={look} width={width} seconds={seconds} />;
    default:
      return null; // "none" and "characters" (drawn by Characters.tsx)
  }
};
