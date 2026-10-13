/**
 * The editor's frame (aspect) and per-clip fit, and the ONE place the preview
 * takes its look from the document.
 *
 * The document already holds everything: `width`/`height` (the frame) and a
 * clip's `fit` ("contain" = scale to fit with bars, "cover" = scale to fill and
 * crop the middle; modules/timeline.py FITS, default contain). The export draws
 * them in ffmpeg (modules/render_backend.py `_scale_pad` / `_scale_crop`); the
 * preview draws them in CSS from the functions below, so both read the same
 * two fields and a test pins the pairing (tests/editor-frame.test.ts and
 * tests/test_editor_frame_parity.py).
 *
 * Nothing here adds a field to the document or a new resolution: the three
 * presets are modules/timeline.py PRESETS (a Python test compares them).
 */
import type { CSSProperties } from "react";
import type { EditorModel, VideoClip } from "@/lib/editor";

export const FRAME_PRESETS = [
  { id: "9:16", width: 1080, height: 1920 },
  { id: "16:9", width: 1920, height: 1080 },
  { id: "1:1", width: 1080, height: 1080 },
] as const;

export type FramePresetId = (typeof FRAME_PRESETS)[number]["id"];

export type Fit = "contain" | "cover";

/** The preset a frame is exactly, or null for any other size (a document from
 *  another tool may hold one; the picker then shows none selected). */
export function framePresetOf(
  frame: Pick<EditorModel, "width" | "height">,
): FramePresetId | null {
  return (
    FRAME_PRESETS.find(
      (p) => p.width === frame.width && p.height === frame.height,
    )?.id ?? null
  );
}

/** The model with the frame of a preset. The same model back when it already
 *  is that frame, so choosing it again is not an undo step. Clips, texts and
 *  sounds are untouched (text positions are fractions of the frame). */
export function setFrame(model: EditorModel, id: FramePresetId): EditorModel {
  const p = FRAME_PRESETS.find((x) => x.id === id);
  if (!p || (model.width === p.width && model.height === p.height))
    return model;
  return { ...model, width: p.width, height: p.height };
}

/** A clip's fit; no `fit` field means contain, as in the document. */
export function fitOf(clip: Pick<VideoClip, "fit">): Fit {
  return clip.fit === "cover" ? "cover" : "contain";
}

/** The model with one clip's fit changed. Contain REMOVES the field (it is the
 *  default), so a project that never used the control keeps exactly the
 *  document it had, and cover -> contain returns to it byte for byte. */
export function setClipFit(
  model: EditorModel,
  id: string,
  fit: Fit,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at || fitOf(at) === fit) return model;
  return {
    ...model,
    clips: model.clips.map((c) => {
      if (c.id !== id) return c;
      const { fit: _old, ...rest } = c;
      void _old;
      return fit === "cover" ? { ...rest, fit } : rest;
    }),
  };
}

/** The CSS `object-fit` of the preview for the clip on screen. A video follows
 *  its `fit`. A still is always drawn filling the frame by the export (its slow
 *  zoom-and-pan starts from a cover-scaled picture, render_backend
 *  `ken_burns_filter`; the held-picture fallback crops to fill too,
 *  `_static_image_cmd(fill=True)`), so the preview fills too; its fit field has
 *  no effect. */
export function previewObjectFit(
  clip: Pick<VideoClip, "fit"> | null | undefined,
  still: boolean,
): Fit {
  if (still) return "cover";
  return clip ? fitOf(clip) : "contain";
}

/** The preview frame's box: the document's aspect ratio, kept inside 60% of the
 *  viewport height (as the editor always did). */
export function previewFrameStyle(
  frame: Pick<EditorModel, "width" | "height">,
): CSSProperties {
  return {
    aspectRatio: `${frame.width} / ${frame.height}`,
    maxHeight: "60vh",
    maxWidth: `calc(60vh * ${frame.width / frame.height})`,
    containerType: "inline-size",
  };
}
