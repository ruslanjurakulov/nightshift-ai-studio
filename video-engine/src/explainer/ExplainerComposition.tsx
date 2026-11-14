import React from "react";
import { AbsoluteFill, Audio, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CharacterScene } from "./Characters";
import { SANS, SERIF, lookFor, type Look } from "./looks";
import { headlineParts, sceneFrames, sceneWords, wordsForLine } from "./text";
import type { ExplainerProps, ExplainerScene, Word } from "./types";
import { VisualPanel } from "./Visuals";

/** The big line: upper case, *marked* words in the accent colour, sized to fit one or two lines. */
const Headline: React.FC<{ text: string; look: Look; width: number }> = ({ text, look, width }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 160 } });
  const parts = headlineParts(text);
  const chars = parts.reduce((n, p) => n + p.text.length, 0);
  // About 0.62 em a glyph in a heavy sans; never wider than the frame, never taller than two lines.
  const size = Math.max(64, Math.min(150, Math.floor((width * 1.7) / Math.max(6, chars) / 0.62 / 2)));
  return (
    <div style={{ fontFamily: SANS, fontWeight: 900, fontSize: size, lineHeight: 1.02, letterSpacing: -2, textAlign: "center", color: look.text, transform: `scale(${0.9 + 0.1 * pop})`, opacity: pop }}>
      {parts.map((p, i) => (
        <span key={i} style={{ color: p.accent ? look.accent : look.text }}>
          {p.text.toUpperCase()}
        </span>
      ))}
    </div>
  );
};

/** The bottom line: the words of the line being spoken; said words bright, the current one in the accent. */
const CaptionLine: React.FC<{ words: Word[]; look: Look; sceneStart: number }> = ({ words, look, sceneStart }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = sceneStart + frame / fps;
  const line = wordsForLine(words, t, 5);
  if (!line.length) return null;
  return (
    <div style={{ fontFamily: SANS, fontSize: 46, fontWeight: 700, textAlign: "center", lineHeight: 1.25 }}>
      {line.map((w, i) => {
        const said = t >= w.start_s;
        const now = t >= w.start_s && t < w.end_s;
        return (
          <span key={i} style={{ color: now ? look.accent : said ? look.text : look.muted, opacity: said ? 1 : 0.55 }}>
            {i ? " " : ""}
            {w.text}
          </span>
        );
      })}
    </div>
  );
};

const SceneView: React.FC<{ scene: ExplainerScene; look: Look; words: Word[]; captions: boolean }> = ({ scene, look, words, captions }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const seconds = Math.max(0.5, scene.end_s - scene.start_s);
  const panelW = Math.round(width * 0.82);
  const accentIn = spring({ frame: frame - Math.round(fps * 0.6), fps, config: { damping: 16 } });
  const v = scene.visual;
  return (
    <AbsoluteFill style={{ alignItems: "center", padding: `${Math.round(height * 0.06)}px ${Math.round(width * 0.06)}px` }}>
      <div style={{ fontFamily: SANS, fontSize: 40, color: look.muted, marginTop: height * 0.03, textAlign: "center" }}>{scene.kicker}</div>
      <div style={{ marginTop: 10, width: "100%" }}>
        <Headline text={scene.headline} look={look} width={width * 0.88} />
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
        {v.kind === "characters" ? (
          <CharacterScene setting={v.setting} cast={v.cast} prop={v.prop} look={look} width={panelW} />
        ) : (
          <VisualPanel v={v} look={look} width={panelW} seconds={seconds} />
        )}
      </div>
      {scene.accent ? (
        <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 72, color: look.text, textAlign: "center", opacity: accentIn, transform: `translateY(${(1 - accentIn) * 20}px)`, marginBottom: height * 0.04 }}>
          {scene.accent}
        </div>
      ) : null}
      <div style={{ minHeight: height * 0.09, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {/* Only this scene's words: a caption line never runs across the cut into the next sentence. */}
        {captions ? <CaptionLine words={sceneWords(words, scene)} look={look} sceneStart={scene.start_s} /> : null}
      </div>
    </AbsoluteFill>
  );
};

export const ExplainerComposition: React.FC<ExplainerProps> = (props) => {
  const { fps } = useVideoConfig();
  const look = lookFor(props.look);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${look.background} 0%, ${look.background2} 100%)` }}>
      {props.narration ? <Audio src={staticFile(props.narration)} /> : null}
      {props.music ? <Audio src={staticFile(props.music)} volume={props.music_volume} loop /> : null}
      {props.sfx.map((c, i) => (
        <Sequence key={`sfx-${i}`} from={Math.max(0, Math.round(c.at_s * fps))} layout="none">
          <Audio src={staticFile(c.src)} volume={c.volume} />
        </Sequence>
      ))}
      {props.scenes.map((s) => {
        const { from, duration } = sceneFrames(s, fps);
        return (
          <Sequence key={s.id} from={from} durationInFrames={duration}>
            <SceneView scene={s} look={look} words={props.words} captions={props.captions} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
