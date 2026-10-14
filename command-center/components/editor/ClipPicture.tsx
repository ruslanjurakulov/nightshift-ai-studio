"use client";

import type { CSSProperties, Ref } from "react";
import type { VideoClip } from "@/lib/editor";
import { previewObjectFit } from "@/lib/editorFrame";
import {
  LOOK_FILTER_ID,
  hasLook,
  lookSpec,
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

export function ClipPicture({
  clip,
  still,
  src,
  frame,
  source,
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
  videoRef: Ref<HTMLVideoElement>;
  onLoadedMetadata: () => void;
  onError: () => void;
}) {
  const staged = needsStage(clip) || (clip?.vignette ?? 0) > 0;
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
  return (
    <>
      <div style={st.fit} data-testid="clip-stage">
        <div style={{ ...st.crop, ...filter }}>
          <div style={st.turned}>{media(st.media)}</div>
        </div>
        {(clip?.vignette ?? 0) > 0 ? (
          <div
            aria-hidden
            data-testid="clip-vignette"
            className="pointer-events-none absolute inset-0"
            style={vignetteStyle(clip?.vignette ?? 0)}
          />
        ) : null}
      </div>
    </>
  );
}
