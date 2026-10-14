"use client";

import { useEffect, useRef, type CSSProperties, type Ref, type RefObject } from "react";
import type { VideoClip } from "@/lib/editor";
import { previewObjectFit } from "@/lib/editorFrame";
import {
  LOOK_FILTER_ID,
  hasLook,
  lookSpec,
  moveStyle,
  needsStage,
  previewFilterStyle,
  stageLayout,
  vignetteStyle,
} from "@/lib/editorFxPreview";

/**
 * The picture in the preview. A clip with none of the geometry fields (turn,
 * mirror, crop, free angle) and no vignette is drawn exactly as it always was:
 * one element that fills the box. Otherwise it is drawn in the nested stage of
 * lib/editorFxPreview.ts `stageLayout` (turn and mirror, crop, fit, free angle).
 * The look, blur and colour are CSS filters on the picture; the exported file
 * is the reference, and the note under the preview says so.
 */

/** The SVG filter the preview's picture points at for a named look
 *  (`filter: url(#ns-clip-look)`), drawn only while the clip on screen has one.
 *  Zero size and hidden from everyone: `display: none` would stop browsers from
 *  resolving the reference. */
export function LookFilterDefs({
  clip,
}: {
  clip: Pick<VideoClip, "filter" | "filter_strength"> | null | undefined;
}) {
  if (!clip || !clip.filter || !hasLook(clip)) return null;
  const spec = lookSpec(clip.filter, clip.filter_strength ?? 1);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      className="pointer-events-none absolute"
      data-testid="look-filter"
    >
      <filter
        id={LOOK_FILTER_ID}
        colorInterpolationFilters="sRGB"
        x="0"
        y="0"
        width="100%"
        height="100%"
      >
        {spec.kind === "saturate" ? (
          <feColorMatrix type="saturate" values={spec.value} />
        ) : spec.kind === "matrix" ? (
          <feColorMatrix type="matrix" values={spec.value} />
        ) : (
          <feComponentTransfer>
            <feFuncR type="table" tableValues={spec.r} />
            <feFuncG type="table" tableValues={spec.g} />
            <feFuncB type="table" tableValues={spec.b} />
          </feComponentTransfer>
        )}
      </filter>
    </svg>
  );
}

/** The blurred background of a `blur` fit: a muted second element on the same
 *  file that follows the main one (its time and whether it plays). It is only a
 *  backdrop, so it is allowed to lag a little. */
function BackdropVideo({
  src,
  main,
  style,
}: {
  src: string;
  main: RefObject<HTMLVideoElement | null>;
  style: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // Every render (the playhead moves them): keep time and play state in step.
  useEffect(() => {
    const v = ref.current;
    const m = main.current;
    if (!v || !m) return;
    v.muted = true;
    if (Math.abs((v.currentTime || 0) - (m.currentTime || 0)) > 0.25) {
      try {
        v.currentTime = m.currentTime || 0;
      } catch {
        /* not loaded yet */
      }
    }
    if (m.paused) v.pause?.();
    else if (v.paused) void v.play?.()?.catch?.(() => {});
  });
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      aria-hidden
      data-testid="blur-backdrop"
      className="block"
      style={style}
    />
  );
}

export function ClipPicture({
  clip,
  still,
  src,
  frame,
  source,
  progress = 0,
  videoRef,
  onLoadedMetadata,
  onError,
}: {
  clip: VideoClip | null | undefined;
  /** A picture is drawn, not played, and always fills the frame. */
  still: boolean;
  src: string;
  frame: { width: number; height: number };
  /** The file's own pixel size (null = not known). */
  source: { width: number | null; height: number | null } | null;
  /** How far through the clip the playhead is (0 to 1): where a move is. */
  progress?: number;
  videoRef: Ref<HTMLVideoElement> & RefObject<HTMLVideoElement | null>;
  onLoadedMetadata: () => void;
  onError: () => void;
}) {
  const staged = needsStage(clip, still) || (clip?.vignette ?? 0) > 0;
  const filter = previewFilterStyle(clip, frame.width);
  const media = (style: CSSProperties, className?: string) =>
    still ? (
      // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
      <img src={src} alt="" className={className} style={style} onError={onError} />
    ) : (
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="auto"
        className={className}
        style={style}
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
      />
    );
  if (!staged)
    return media({ objectFit: previewObjectFit(clip, still), ...filter }, "size-full");
  const st = stageLayout(clip ?? {}, frame, source, still);
  const vignette =
    (clip?.vignette ?? 0) > 0 ? (
      <div
        aria-hidden
        data-testid="clip-vignette"
        className="pointer-events-none absolute inset-0"
        style={vignetteStyle(clip?.vignette ?? 0)}
      />
    ) : null;
  // The export runs the effects after the move: with one, the look, blur and
  // vignette sit on the frame outside the zoomed picture; without, on the picture.
  const moved = Boolean(clip?.move);
  const composed = (
    <div
      className="absolute inset-0"
      style={moved ? undefined : filter}
      data-testid="clip-composed"
    >
      {st.backdrop ? (
        <div style={{ ...st.backdrop.crop, ...st.backdrop.blur }}>
          <div style={st.backdrop.turned}>
            <BackdropVideo src={src} main={videoRef} style={st.backdrop.media} />
          </div>
        </div>
      ) : null}
      <div style={st.crop}>
        <div style={st.turned}>{media(st.media)}</div>
      </div>
    </div>
  );
  const picture = (
    <div
      className="absolute inset-0"
      style={moveStyle(clip?.move, progress)}
      data-testid="clip-move"
    >
      <div style={st.fit} data-testid="clip-stage">
        {composed}
        {moved ? null : vignette}
      </div>
    </div>
  );
  return moved ? (
    <div className="absolute inset-0" style={filter}>
      {picture}
      {vignette}
    </div>
  ) : (
    picture
  );
}
