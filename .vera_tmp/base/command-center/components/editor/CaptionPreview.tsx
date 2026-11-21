"use client";

import { previewStyledCaption } from "@/lib/captionStylePreview";
import type { CaptionStyle, Cue } from "@/lib/captions";
import type { FONT_FAMILY } from "@/lib/editorTextLookPreview";

/**
 * A caption in one of the animated styles, drawn over the preview picture.
 * An approximation of the export (lib/captionStylePreview.ts): the panel and
 * the line under the picture say so. Renders nothing for a caption without a
 * style — the editor keeps its own plain caption for those.
 */
export function CaptionPreview({
  cue,
  style,
  playhead,
  frameWidth,
  perWord,
}: {
  cue: Cue;
  style: CaptionStyle;
  playhead: number;
  frameWidth: number;
  /** False when the export writes this caption without lit words. */
  perWord?: boolean;
}) {
  const p = previewStyledCaption({
    style: { ...style, font: style.font as keyof typeof FONT_FAMILY },
    text: cue.text,
    startS: cue.start_s,
    endS: cue.end_s,
    t: playhead,
    frameWidth,
    perWord,
  });
  if (!p) return null;
  return (
    <span className="pointer-events-none" style={p.box} data-testid="styled-caption">
      {p.lines.map((row, i) => (
        <span key={i} style={{ display: "block" }}>
          {row.map((seg, j) => (
            <span key={j} style={seg.style}>
              {seg.text}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
