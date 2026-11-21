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

/** contain = bars, cover = fill and crop, blur = the whole picture over a
 *  blurred, enlarged copy of itself (no bars). */
export type Fit = "contain" | "cover" | "blur";

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
  return clip.fit === "cover" || clip.fit === "blur" ? clip.fit : "contain";
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
      return fit === "contain" ? rest : { ...rest, fit };
    }),
  };
}

/** The CSS `object-fit` of the preview for the clip on screen. A video follows
 *  its `fit` (the blurred-background copy behind it is the stage's, ClipPicture). A still is always drawn filling the frame by the export (its slow
 *  zoom-and-pan starts from a cover-scaled picture, render_backend
 *  `ken_burns_filter`; the held-picture fallback crops to fill too,
 *  `_static_image_cmd(fill=True)`), so the preview fills too; its fit field has
 *  no effect. */
export function previewObjectFit(
  clip: Pick<VideoClip, "fit"> | null | undefined,
  still: boolean,
): "contain" | "cover" {
  if (still) return "cover";
  // A blurred-background fit draws the whole picture (as contain) over its blurred copy.
  return clip && fitOf(clip) === "cover" ? "cover" : "contain";
}

/** The CSS variable that holds the preview's height cap. The editor sets it
 *  per breakpoint (a class, so the box answers to the screen without a
 *  resize listener): `PREVIEW_CAP_PHONE` below `lg`, where the preview is
 *  pinned above the inspector, and the full `PREVIEW_CAP_DESKTOP` from `lg` on. */
export const PREVIEW_CAP_VAR = "--ns-preview-cap";
export const PREVIEW_CAP_DESKTOP = "60vh";
export const PREVIEW_CAP_PHONE = "30dvh";

/** The preview frame's box: the document's aspect ratio, kept inside the cap
 *  (60% of the viewport height on a desktop, as the editor always did; 30% of
 *  the dynamic viewport height on a phone or tablet so the picture can stay in
 *  view while the controls below it are used).
 *
 *  A max-height alone would break the ratio (the box would get narrower in
 *  height only), so the width is capped to the same height times the ratio:
 *  the box is `min(100%, cap * ratio)` wide and `width / ratio` high, never
 *  taller than the cap. */
export function previewFrameStyle(
  frame: Pick<EditorModel, "width" | "height">,
): CSSProperties {
  const cap = `var(${PREVIEW_CAP_VAR}, ${PREVIEW_CAP_DESKTOP})`;
  return {
    aspectRatio: `${frame.width} / ${frame.height}`,
    maxHeight: cap,
    maxWidth: `calc(${cap} * ${frame.width / frame.height})`,
    containerType: "inline-size",
  };
}
