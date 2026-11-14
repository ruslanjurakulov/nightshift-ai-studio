import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { SANS, alpha, mix, type Look } from "./looks";
import { clamp01, easeInOutCubic, easeOutBack, eyeOpenness, mouthOpenness, ramp, seedOf } from "./motion";
import { statShown } from "./text";
import type { Mood, Tone, Visual, Word } from "./types";

/**
 * The non-character visuals. The panel as a whole blurs in with the scene (ExplainerComposition); inside it, parts
 * arrive one after another on eased curves, so a list builds while it is being said instead of appearing at once.
 */

const MONO = "'JetBrains Mono', 'DejaVu Sans Mono', monospace";

const shadow = (look: Look) => `0 34px 80px ${alpha("#000000", look.glow >= 0.9 ? 0.45 : 0.18)}, 0 6px 18px ${alpha("#000000", 0.18)}`;

const panelStyle = (look: Look, w: number): React.CSSProperties => ({
  width: w,
  background: look.panel,
  color: look.panelText,
  borderRadius: 30,
  padding: "48px 56px",
  boxShadow: `${shadow(look)}, inset 0 0 0 1px ${alpha(look.panelText, 0.06)}`,
  fontFamily: SANS,
});

const toneColor = (look: Look, tone?: Tone) => (tone === "good" ? look.good : tone === "bad" ? look.bad : look.panelText);

/** Arrival steps that finish by 60% of the scene, so the last item lands while it is still being said. */
const stepFrames = (seconds: number, fps: number, count: number, min = 6) => Math.max(min, Math.floor((seconds * fps * 0.6) / Math.max(1, count)));

/** A list card that fills row by row (an invoice, a price list, a plan). */
const Card: React.FC<{ v: Extract<Visual, { kind: "card" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = stepFrames(seconds, fps, v.rows.length + (v.total ? 1 : 0));
  const first = 10;
  const totalAt = first + v.rows.length * step;
  const total = ramp(frame, totalAt, 14, easeOutBack);
  const rule = ramp(frame, totalAt - 4, 12);
  return (
    <div style={panelStyle(look, width)}>
      <div style={{ fontSize: 48, fontWeight: 800 }}>{v.title}</div>
      {v.subtitle ? <div style={{ fontSize: 31, color: look.panelMuted, marginTop: 6 }}>{v.subtitle}</div> : null}
      <div style={{ marginTop: 34 }}>
        {v.rows.map((r, i) => {
          const o = ramp(frame, first + i * step, 12);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 38,
                padding: "13px 0",
                opacity: o,
                transform: `translateX(${((1 - o) * -28).toFixed(1)}px)`,
              }}
            >
              <span>{r.label}</span>
              <span style={{ fontWeight: 800, color: toneColor(look, r.tone) }}>{r.value}</span>
            </div>
          );
        })}
      </div>
      {v.total ? (
        <div style={{ marginTop: 26 }}>
          <div style={{ height: 2, background: alpha(look.panelMuted, 0.4), transformOrigin: "0 50%", transform: `scaleX(${rule.toFixed(3)})` }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 24, opacity: clamp01(total) }}>
            <span style={{ fontSize: 38 }}>{v.total.label}</span>
            <span style={{ fontSize: 68, fontWeight: 900, color: look.bad, display: "inline-block", transformOrigin: "100% 70%", transform: `scale(${(0.7 + 0.3 * total).toFixed(3)})` }}>{v.total.value}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** One big number that counts up when it can be parsed, else appears as written. */
const Stat: React.FC<{ v: Extract<Visual, { kind: "stat" }>; look: Look; width: number }> = ({ v, look, width }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Only an unambiguous integer counts up; the last frame is always the value as said (statShown).
  const shown = statShown(v.value, interpolate(frame, [6, 6 + fps * 1.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const pop = ramp(frame, 6, 16, easeOutBack);
  const ring = ramp(frame, 10, 30);
  const label = ramp(frame, 16, 14);
  return (
    <div style={{ ...panelStyle(look, width), textAlign: "center", position: "relative", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "42%",
          width: 520,
          height: 520,
          marginLeft: -260,
          marginTop: -260,
          borderRadius: 260,
          background: `radial-gradient(circle, ${alpha(look.accent, 0.22 * ring)} 0%, transparent 65%)`,
        }}
      />
      <div style={{ position: "relative", fontSize: 160, fontWeight: 900, color: look.accent, lineHeight: 1, display: "inline-block", transform: `scale(${(0.6 + 0.4 * pop).toFixed(3)})` }}>{shown}</div>
      <div style={{ position: "relative", fontSize: 40, color: look.panelMuted, marginTop: 20, opacity: label, transform: `translateY(${((1 - label) * 12).toFixed(1)}px)` }}>{v.label}</div>
    </div>
  );
};

/** A render-style progress bar: label, a bar that creeps with a moving sheen, a red note ("94 soat"). */
const Progress: React.FC<{ v: Extract<Visual, { kind: "progress" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pct = Math.max(0, Math.min(100, v.percent));
  const shown = pct * easeInOutCubic((frame - 8) / Math.max(1, seconds * fps * 0.8));
  const sheen = ((frame / fps) * 0.7) % 1;
  const note = ramp(frame, 18, 14);
  return (
    <div style={panelStyle(look, width)}>
      <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <div key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 36 }}>
        <span>{v.label}</span>
        <span style={{ fontFamily: MONO }}>{shown.toFixed(1)}%</span>
      </div>
      <div style={{ position: "relative", height: 16, background: alpha(look.panelMuted, 0.25), borderRadius: 8, marginTop: 20, overflow: "hidden" }}>
        <div style={{ position: "relative", width: `${shown}%`, minWidth: shown > 0 ? 16 : 0, height: "100%", background: look.bad, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, bottom: 0, width: 120, left: `${(sheen * 140 - 20).toFixed(1)}%`, background: `linear-gradient(90deg, transparent, ${alpha("#ffffff", 0.45)}, transparent)` }} />
        </div>
      </div>
      {v.note ? <div style={{ fontSize: 32, color: look.bad, marginTop: 22, fontFamily: MONO, opacity: note }}>{v.note}</div> : null}
    </div>
  );
};

/** A round face: the one-line reaction shot. It blinks, and its mouth moves while the narration speaks. */
const Emoji: React.FC<{ mood: Mood; look: Look; size: number; words: Word[]; sceneStart: number; seed: number }> = ({ mood, look, size, words, sceneStart, seed }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const s = ramp(frame, 4, 18, easeOutBack);
  const wobble = Math.sin(t * 5) * (mood === "shocked" || mood === "angry" ? 4 : 1.5);
  const open = eyeOpenness(seed, t);
  const talk = mood === "shocked" ? 0 : mouthOpenness(words, sceneStart + t);
  const brow =
    mood === "worried" ? "M60 70 L85 62 M140 62 L115 70" : mood === "angry" ? "M60 62 L88 74 M140 62 L112 74" : mood === "thinking" ? "M60 66 L88 66 M115 58 L140 64" : "";
  const mouth =
    mood === "happy"
      ? "M70 125 Q100 155 130 125"
      : mood === "calm"
        ? "M78 130 Q100 140 122 130"
        : mood === "thinking"
          ? "M84 134 L116 128"
          : "M80 138 Q100 124 120 138";
  const ring = mix(look.accent, "#ffffff", 0.1);
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <div style={{ position: "absolute", inset: -size * 0.15, borderRadius: "50%", background: `radial-gradient(circle, ${alpha(look.accent, 0.25 * s)} 0%, transparent 65%)` }} />
      <svg width={size} height={size} viewBox="0 0 200 200" style={{ position: "relative", transform: `scale(${s.toFixed(3)}) rotate(${wobble.toFixed(2)}deg)` }}>
        <ellipse cx="100" cy="196" rx="60" ry="6" fill="#000" opacity={0.25} />
        <circle cx="100" cy="100" r="92" fill="#1b1b1f" stroke={ring} strokeWidth="8" />
        <circle cx="100" cy="100" r="80" fill="none" stroke="#ffffff" strokeOpacity="0.05" strokeWidth="12" />
        {[75, 125].map((cx) => (
          <g key={cx}>
            <ellipse cx={cx} cy="92" rx="11" ry={Math.max(1, 12 * open)} fill="#fff" />
            {open > 0.3 ? <circle cx={cx + (mood === "thinking" ? 3 : 0)} cy={mood === "thinking" ? 88 : 93} r="5" fill="#1b1b1f" /> : null}
          </g>
        ))}
        {brow ? <path d={brow} stroke="#fff" strokeWidth="7" strokeLinecap="round" fill="none" /> : null}
        {mood === "shocked" ? (
          <ellipse cx="100" cy="136" rx="13" ry={15 + Math.sin(t * 3) * 1.5} fill="#fff" />
        ) : talk > 0.02 ? (
          <ellipse cx="100" cy="132" rx="16" ry={3 + talk * 13} fill="#5a1520" stroke="#fff" strokeWidth="6" />
        ) : (
          <path d={mouth} stroke="#fff" strokeWidth="7" strokeLinecap="round" fill="none" />
        )}
      </svg>
    </div>
  );
};

/** Items that slide in one after another; each tick's circle pops and the tick draws itself. */
const Checklist: React.FC<{ v: Extract<Visual, { kind: "checklist" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = stepFrames(seconds, fps, v.items.length);
  return (
    <div style={{ width, display: "flex", flexDirection: "column", gap: 24, fontFamily: SANS }}>
      {v.items.map((it, i) => {
        const at = 8 + i * step;
        const t = ramp(frame, at, 14);
        const circle = ramp(frame, at + 8, 12, easeOutBack);
        const tick = ramp(frame, at + 14, 10);
        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: look.panel,
              color: look.panelText,
              borderRadius: 26,
              padding: "32px 38px",
              fontSize: 42,
              fontWeight: 800,
              opacity: t,
              transform: `translateX(${((1 - t) * -50).toFixed(1)}px)`,
              boxShadow: `${shadow(look)}, inset 0 0 0 1px ${alpha(look.panelText, 0.06)}`,
            }}
          >
            <span>{it}</span>
            <svg width="60" height="60" viewBox="0 0 54 54">
              <circle cx="27" cy="27" r={27 * Math.max(0, circle)} fill={look.good} />
              <path d="M15 28 L24 36 L40 19" stroke="#fff" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="40" strokeDashoffset={(40 * (1 - tick)).toFixed(2)} />
            </svg>
          </div>
        );
      })}
    </div>
  );
};

/** A short thread: the other side "types" (three dots) before each of its messages lands. */
const Chat: React.FC<{ v: Extract<Visual, { kind: "chat" }>; look: Look; width: number; seconds: number }> = ({ v, look, width, seconds }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const step = stepFrames(seconds, fps, v.messages.length, 10);
  const typing = Math.round(fps * 0.5);
  return (
    <div style={{ width, display: "flex", flexDirection: "column", gap: 22, fontFamily: SANS }}>
      {v.messages.map((m, i) => {
        const right = m.side === "right";
        const at = 8 + i * step + (right || i === 0 ? 0 : typing);
        const t = ramp(frame, at, 14, easeOutBack);
        const dotsOn = !right && i > 0 && frame >= at - typing && frame < at;
        const bubble = {
          maxWidth: width * 0.8,
          background: right ? look.accent : look.panel,
          color: right ? mix(look.accent, "#000000", 0.85) : look.panelText,
          padding: "26px 34px",
          borderRadius: 32,
          borderBottomRightRadius: right ? 10 : 32,
          borderBottomLeftRadius: right ? 32 : 10,
          fontSize: 40,
          lineHeight: 1.3,
          boxShadow: shadow(look),
        } as React.CSSProperties;
        return (
          <div key={i} style={{ display: "flex", justifyContent: right ? "flex-end" : "flex-start" }}>
            {dotsOn ? (
              <div style={{ ...bubble, display: "flex", gap: 10, padding: "30px 34px" }}>
                {[0, 1, 2].map((d) => (
                  <div key={d} style={{ width: 14, height: 14, borderRadius: 7, background: look.panelMuted, transform: `translateY(${(-6 * Math.abs(Math.sin((frame / fps) * 6 - d * 0.6))).toFixed(1)}px)` }} />
                ))}
              </div>
            ) : (
              <div style={{ ...bubble, opacity: clamp01(t * 1.5), transformOrigin: right ? "100% 100%" : "0 100%", transform: `scale(${(0.85 + 0.15 * t).toFixed(3)})` }}>{m.text}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const VisualPanel: React.FC<{ v: Visual; look: Look; width: number; seconds: number; words: Word[]; sceneStart: number; sceneId: string }> = ({
  v,
  look,
  width,
  seconds,
  words,
  sceneStart,
  sceneId,
}) => {
  switch (v.kind) {
    case "card":
      return <Card v={v} look={look} width={width} seconds={seconds} />;
    case "stat":
      return <Stat v={v} look={look} width={width} />;
    case "progress":
      return <Progress v={v} look={look} width={width} seconds={seconds} />;
    case "emoji":
      return <Emoji mood={v.mood} look={look} size={Math.round(width * 0.6)} words={words} sceneStart={sceneStart} seed={seedOf(sceneId)} />;
    case "checklist":
      return <Checklist v={v} look={look} width={width} seconds={seconds} />;
    case "chat":
      return <Chat v={v} look={look} width={width} seconds={seconds} />;
    default:
      return null; // "none" and "characters" (drawn by Characters.tsx)
  }
};
