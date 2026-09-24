import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleBible, Word } from "../types";

type Props = {
  words: Word[];
  /** Project-clock second at which this scene's frame 0 plays. */
  sceneStart: number;
  style: StyleBible;
  /** Max words per caption line. */
  chunkSize?: number;
};

/** Split words into fixed-size lines, in order. */
const chunk = (words: Word[], size: number): Word[][] => {
  const out: Word[][] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size));
  return out;
};

/**
 * Word-level captions. `word_highlight` colours the word being spoken with the
 * palette accent; `sentence` shows the line without highlight; `none` renders
 * nothing. Only the line containing the current time is shown.
 */
export const Captions: React.FC<Props> = ({ words, sceneStart, style, chunkSize = 7 }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  if (style.caption_style === "none" || words.length === 0) return null;

  const t = sceneStart + frame / fps;
  const lines = chunk(
    words.filter((w) => Number.isFinite(w.start_s) && Number.isFinite(w.end_s)),
    Math.max(1, chunkSize),
  );
  const line = lines.find((l) => t >= l[0].start_s && t < l[l.length - 1].end_s);
  if (!line) return null;
  const highlight = style.caption_style === "word_highlight";

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: height * 0.08 }}>
      <div
        style={{
          fontFamily: style.body_font,
          fontSize: width * 0.03,
          fontWeight: 700,
          color: style.palette.text,
          textAlign: "center",
          maxWidth: width * 0.8,
          textShadow: "0 2px 8px rgba(0,0,0,0.85)",
          lineHeight: 1.3,
        }}
      >
        {line.map((w, i) => {
          const active = highlight && t >= w.start_s && t < w.end_s;
          return (
            <span key={`${w.start_s}-${i}`} style={{ color: active ? style.palette.accent : undefined }}>
              {w.text}
              {i < line.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
