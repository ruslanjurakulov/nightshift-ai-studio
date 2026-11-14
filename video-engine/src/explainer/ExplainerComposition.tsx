import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CharacterScene } from "./Characters";
import { Backdrop } from "./Film";
import { SANS, SERIF, alpha, lookFor, mix, type Look } from "./looks";
import { accentLineAt, accentSpokenAt, clamp01, easeOutBack, exitProgress, mouthOpenness, ramp } from "./motion";
import { headlineParts, sceneFrames, sceneWords, wordsForLine } from "./text";
import type { ExplainerProps, ExplainerScene, Word } from "./types";
import { VisualPanel } from "./Visuals";

/** A blur that is `none` once settled: a zero-radius filter still costs a compositing pass on every frame. */
const blur = (px: number) => (px > 0.05 ? `blur(${px.toFixed(2)}px)` : undefined);

/** The headline split into words, each knowing whether it is the starred one. */
const headlineWords = (text: string) =>
  headlineParts(text).flatMap((p) =>
    p.text
      .split(/(\s+)/)
      .filter((w) => w.length > 0)
      .map((w) => ({ text: w, accent: p.accent, space: /^\s+$/.test(w) })),
  );

/**
 * The big line, word by word: each word rises out of a blur a few frames after the one before. The starred word pops
 * when the narration says it (its spoken time in this scene's words), or on its entrance when the narration never
 * says it (a "$" or a paraphrase): the emphasis lands on the voice, not on an arbitrary beat.
 */
const Headline: React.FC<{ text: string; look: Look; width: number; words: Word[]; sceneStart: number }> = ({ text, look, width, words, sceneStart }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const parts = headlineWords(text);
  const chars = parts.reduce((n, p) => n + p.text.length, 0);
  // About 0.62 em a glyph in a heavy sans; never wider than the frame, never taller than two lines.
  const size = Math.max(64, Math.min(150, Math.floor((width * 1.7) / Math.max(6, chars) / 0.62 / 2)));
  const accentText = headlineParts(text).find((p) => p.accent)?.text ?? "";
  const spoken = accentText ? accentSpokenAt(accentText, words) : null;
  let wi = 0;
  return (
    <div style={{ fontFamily: SANS, fontWeight: 900, fontSize: size, lineHeight: 1.02, letterSpacing: -2, textAlign: "center", color: look.text }}>
      {parts.map((p, i) => {
        // Words are spaced by margins, not space characters: the starred word's pop must not swallow the gap
        // ("MANASHUNDAY" on the contact sheet).
        if (p.space) return null;
        const k = wi++;
        const start = 1 + k * 4;
        const e = ramp(frame, start, 12);
        let pop = 0;
        if (p.accent) {
          const at = spoken !== null ? Math.round((spoken - sceneStart) * fps) : start + 8;
          const q = (frame - at) / (fps * 0.4);
          pop = q > 0 && q < 1 ? Math.sin(Math.PI * q) * (1 - q * 0.3) : 0;
        }
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              margin: "0 0.14em",
              color: p.accent ? look.accent : look.text,
              opacity: e,
              transform: `translateY(${((1 - e) * 42).toFixed(1)}px) scale(${(1 + 0.08 * pop).toFixed(3)})`,
              filter: blur((1 - e) * 10),
              textShadow: p.accent && pop > 0 ? `0 0 ${Math.round(40 * pop)}px ${alpha(look.accent, 0.6 * pop)}` : undefined,
            }}
          >
            {p.text.toUpperCase()}
          </span>
        );
      })}
    </div>
  );
};

/** The bottom line: the words of the line being spoken; said words bright, the current one in the accent and lifted. */
const CaptionLine: React.FC<{ words: Word[]; look: Look; sceneStart: number }> = ({ words, look, sceneStart }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = sceneStart + frame / fps;
  // Four words: five wrapped to a second line at this size in Uzbek, and one line is what the eye can follow.
  const line = wordsForLine(words, t, 4);
  if (!line.length) return null;
  return (
    <div style={{ fontFamily: SANS, fontSize: 48, fontWeight: 800, textAlign: "center", lineHeight: 1.25 }}>
      {line.map((w, i) => {
        const said = t >= w.start_s;
        const now = t >= w.start_s && t < w.end_s;
        const q = clamp01((t - w.start_s) / 0.22);
        const pop = said && q < 1 ? Math.sin(Math.PI * q) : 0;
        return (
          // Words are spaced by margins, not space characters: a word lifted by its pop must not swallow the gap.
          <span
            key={i}
            style={{
              display: "inline-block",
              margin: "0 0.14em",
              color: now ? look.accent : said ? look.text : look.muted,
              opacity: said ? 1 : 0.5,
              transform: `translateY(${(-6 * pop).toFixed(1)}px) scale(${(1 + 0.05 * pop).toFixed(3)})`,
            }}
          >
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

/**
 * The thin line under the card's title. It grows with the scene, and it is a trace of the voice: high where the
 * narration was speaking, flat in its pauses (the word timings, not an invented waveform).
 */
const SpeechLine: React.FC<{ words: Word[]; sceneStart: number; seconds: number; progress: number; width: number; look: Look }> = ({ words, sceneStart, seconds, progress, width, look }) => {
  const step = 6;
  const shown = Math.max(0, Math.min(width, width * progress));
  let d = "M0 14";
  for (let x = step; x <= shown; x += step) {
    const at = sceneStart + (x / width) * seconds;
    // Smoothed over a short window, so a word reads as a swell rather than a jitter.
    const amp = (mouthOpenness(words, at) + mouthOpenness(words, at - 0.06) + mouthOpenness(words, at + 0.06)) / 3;
    d += ` L${x} ${(14 + Math.sin(x / 7) * (1.5 + 9 * amp)).toFixed(1)}`;
  }
  return (
    <svg width={width} height={28} style={{ display: "block" }}>
      <path d={`M0 14 H${width}`} stroke={alpha(look.panelMuted, 0.25)} strokeWidth={3} strokeLinecap="round" />
      <path d={d} stroke={look.accent} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" fill="none" />
    </svg>
  );
};

/** A character scene framed as a video card: the scene, then a title row and the line that grows through the scene. */
const MediaCard: React.FC<{ scene: ExplainerScene; look: Look; width: number; words: Word[]; durationFrames: number; children: React.ReactNode }> = ({ scene, look, width, words, durationFrames, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const title = (scene.kicker || scene.headline).replace(/\*/g, "");
  const v = scene.visual;
  const dot = v.kind === "characters" && v.cast.length ? look.cast[Math.abs(v.cast[0].color) % look.cast.length] : look.accent;
  const info = ramp(frame, 10, 14);
  return (
    <div
      style={{
        width,
        borderRadius: 34,
        overflow: "hidden",
        background: mix(look.panel, "#000000", look.glow >= 0.9 ? 0.15 : 0),
        boxShadow: `0 40px 90px ${alpha("#000000", 0.45)}, 0 8px 24px ${alpha("#000000", 0.3)}, inset 0 0 0 1px ${alpha("#ffffff", 0.06)}`,
      }}
    >
      {children}
      <div style={{ padding: "26px 34px 22px", display: "flex", alignItems: "center", gap: 24, opacity: info, transform: `translateY(${((1 - info) * 14).toFixed(1)}px)` }}>
        <div style={{ width: 66, height: 66, borderRadius: 33, flex: "none", background: `linear-gradient(135deg, ${mix(dot, "#ffd27a", 0.45)}, ${dot})` }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: SANS, fontSize: 36, fontWeight: 800, color: look.panelText, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          <div style={{ marginTop: 10 }}>
            <SpeechLine words={words} sceneStart={scene.start_s} seconds={durationFrames / fps} progress={frame / Math.max(1, durationFrames - 1)} width={width - 34 * 2 - 66 - 24} look={look} />
          </div>
        </div>
      </div>
    </div>
  );
};

const SceneView: React.FC<{ scene: ExplainerScene; look: Look; words: Word[]; captions: boolean; mediaCard: boolean; isLast: boolean }> = ({ scene, look, words, captions, mediaCard, isLast }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { duration } = sceneFrames(scene, fps);
  const seconds = duration / fps;
  const panelW = Math.round(width * 0.9);
  const own = sceneWords(words, scene);
  const v = scene.visual;

  // Leaving: the last few frames of this scene's own window, never beyond it.
  const out = exitProgress(frame, duration, fps, isLast);
  const kicker = ramp(frame, 0, 12);
  const panel = ramp(frame, 2, 16);
  const accentAt = Math.round(accentLineAt(scene.accent, own, scene.start_s, seconds) * fps);
  const accentIn = ramp(frame, accentAt, 14);

  const art =
    v.kind === "characters" ? (
      <CharacterScene sceneId={scene.id} setting={v.setting} cast={v.cast} prop={v.prop} look={look} width={panelW} words={own} sceneStart={scene.start_s} durationFrames={duration} />
    ) : null;

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        padding: `${Math.round(height * 0.065)}px ${Math.round(width * 0.05)}px ${Math.round(height * 0.045)}px`,
        opacity: 1 - out,
        filter: blur(out * 12),
        transform: out > 0 ? `translateY(${(-18 * out).toFixed(1)}px) scale(${(1 - 0.03 * out).toFixed(4)})` : undefined,
      }}
    >
      <div
        style={{
          fontFamily: SANS,
          fontSize: 42,
          fontWeight: 500,
          color: look.muted,
          marginTop: height * 0.025,
          textAlign: "center",
          opacity: kicker,
          transform: `translateY(${((1 - kicker) * -16).toFixed(1)}px)`,
          letterSpacing: `${(0.06 * (1 - kicker)).toFixed(3)}em`,
        }}
      >
        {scene.kicker}
      </div>
      <div style={{ marginTop: 8, width: "100%" }}>
        <Headline text={scene.headline} look={look} width={width * 0.9} words={own} sceneStart={scene.start_s} />
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
        <div
          style={{
            opacity: panel,
            filter: blur((1 - panel) * 16),
            transform: `translateY(${((1 - panel) * 36).toFixed(1)}px) scale(${(0.95 + 0.05 * panel).toFixed(4)})`,
          }}
        >
          {art ? (
            mediaCard ? (
              <MediaCard scene={scene} look={look} width={panelW} words={own} durationFrames={duration}>
                {art}
              </MediaCard>
            ) : (
              <div style={{ borderRadius: 34, overflow: "hidden", boxShadow: `0 40px 90px ${alpha("#000000", 0.45)}` }}>{art}</div>
            )
          ) : (
            <VisualPanel v={v} look={look} width={panelW} seconds={seconds} words={own} sceneStart={scene.start_s} sceneId={scene.id} />
          )}
        </div>
      </div>
      {scene.accent ? (
        <div
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 74,
            color: look.text,
            textAlign: "center",
            opacity: accentIn,
            filter: blur((1 - accentIn) * 12),
            transform: `translateY(${((1 - accentIn) * 10).toFixed(1)}px) scale(${(0.98 + 0.02 * easeOutBack(accentIn)).toFixed(4)})`,
            marginTop: 24,
            marginBottom: height * 0.025,
          }}
        >
          {scene.accent}
        </div>
      ) : null}
      <div style={{ minHeight: height * 0.085, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {/* Only this scene's words: a caption line never runs across the cut into the next sentence. */}
        {captions ? <CaptionLine words={own} look={look} sceneStart={scene.start_s} /> : null}
      </div>
    </AbsoluteFill>
  );
};

/** The sound: narration, the music bed and the effects. Shared by the full render and the sound-only pass. */
const Sound: React.FC<{ props: ExplainerProps; fps: number }> = ({ props, fps }) => (
  <>
    {props.narration ? <Audio src={staticFile(props.narration)} /> : null}
    {props.music ? <Audio src={staticFile(props.music)} volume={props.music_volume} loop /> : null}
    {props.sfx.map((c, i) => (
      <Sequence key={`sfx-${i}`} from={Math.max(0, Math.round(c.at_s * fps))} layout="none">
        <Audio src={staticFile(c.src)} volume={c.volume} />
      </Sequence>
    ))}
  </>
);

export const ExplainerComposition: React.FC<ExplainerProps> = (props) => {
  const { fps } = useVideoConfig();
  const look = lookFor(props.look);
  if (props.sound_only) return <Sound props={props} fps={fps} />;
  return (
    <AbsoluteFill>
      <Backdrop look={look} />
      <Sound props={props} fps={fps} />
      {props.scenes.map((s, i) => {
        const { from, duration } = sceneFrames(s, fps);
        return (
          <Sequence key={s.id} from={from} durationInFrames={duration}>
            <SceneView scene={s} look={look} words={props.words} captions={props.captions} mediaCard={props.media_card} isLast={i === props.scenes.length - 1} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
