/**
 * Export presets: a CLOSED list of frame shapes the editor offers for an export
 * (YouTube wide, vertical for Shorts / Reels / TikTok, square, a 4:5 feed shape).
 *
 * A preset is parameters and nothing else: a frame size, a frame rate and a
 * recommended length. Choosing one writes `width`, `height` and `fps` into the
 * document, exactly the fields the frame picker already writes (lib/editorFrame.ts
 * `setFrame`), and the document then goes through the ordinary validator
 * (`validateTimeline`), save, and export request. It adds no field to the document, no
 * route, no price and no render path; the export is the same ffmpeg run under the
 * same limits (modules/ffmpeg_limits.py, modules/editor_export.py).
 *
 * This is the twin of modules/export_presets.py, which loads the same list from
 * schemas/export_presets.json and refuses any entry outside the limits below. A test
 * (tests/editor-export-presets.test.ts) compares this list to that file value for value,
 * so the two cannot drift.
 *
 * The recommended length is advice: a project longer than it can still be exported (a
 * vertical project that was 4 minutes long exported before presets existed). The numbers
 * are this project's own conservative ones, not a claim about any platform's rules.
 */
import {
  EXPORT_MAX_S,
  FPS_VALUES,
  LARGE_FRAME_PX,
  MAX_SIDE,
  MIN_SIDE,
  type EditorModel,
} from "@/lib/editor";

export const EXPORT_PRESETS = [
  { id: "youtube_1080p", width: 1920, height: 1080, fps: 30, maxDurationS: 1800 },
  { id: "youtube_720p", width: 1280, height: 720, fps: 30, maxDurationS: 1800 },
  { id: "vertical_1080p", width: 1080, height: 1920, fps: 30, maxDurationS: 180 },
  { id: "square_1080", width: 1080, height: 1080, fps: 30, maxDurationS: 600 },
  { id: "feed_4x5_1080", width: 1080, height: 1350, fps: 30, maxDurationS: 600 },
] as const;

export type ExportPreset = (typeof EXPORT_PRESETS)[number];
export type ExportPresetId = ExportPreset["id"];

/** Is this one of the closed list? Exact match: no trimming, no case folding. */
export function isExportPresetId(v: unknown): v is ExportPresetId {
  return typeof v === "string" && EXPORT_PRESETS.some((p) => p.id === v);
}

/** The preset for an id, or null for anything outside the list. */
export function exportPresetById(v: unknown): ExportPreset | null {
  return EXPORT_PRESETS.find((p) => p.id === v) ?? null;
}

/** Every rule a preset must satisfy to be offered; empty = fine. The test runs it on the whole
 *  list, so an entry that breaks a limit fails the build instead of a member's export. */
export function presetProblems(p: {
  width: number;
  height: number;
  fps: number;
  maxDurationS: number;
}): string[] {
  const out: string[] = [];
  for (const [k, v] of [["width", p.width], ["height", p.height]] as const) {
    if (!Number.isInteger(v) || v < MIN_SIDE || v > MAX_SIDE || v % 2 !== 0)
      out.push(`${k} must be an even integer from ${MIN_SIDE} to ${MAX_SIDE}`);
  }
  if (p.width * p.height > LARGE_FRAME_PX) out.push("the frame is bigger than 1440p");
  if (!(FPS_VALUES as readonly number[]).includes(p.fps)) out.push("fps is not on the list");
  if (!(p.maxDurationS > 0 && p.maxDurationS <= EXPORT_MAX_S))
    out.push("the recommended length is above the export's cap");
  return out;
}

/** The preset a frame and rate are exactly, or null (a custom size, or a document from
 *  another tool: the picker then shows none selected). */
export function exportPresetOf(
  m: Pick<EditorModel, "width" | "height" | "fps">,
): ExportPresetId | null {
  return (
    EXPORT_PRESETS.find(
      (p) => p.width === m.width && p.height === m.height && p.fps === m.fps,
    )?.id ?? null
  );
}

/** The model with the preset's frame size and rate, and nothing else changed. The same
 *  model back when it already is that frame (choosing it again is not an undo step) and
 *  for an id outside the list. Clips, texts and sounds are untouched. */
export function applyExportPreset(model: EditorModel, id: unknown): EditorModel {
  const p = exportPresetById(id);
  if (
    !p ||
    (model.width === p.width && model.height === p.height && model.fps === p.fps)
  )
    return model;
  return { ...model, width: p.width, height: p.height, fps: p.fps };
}

/** Is a video this long past the preset's recommended length? Only advice. */
export function isLongForPreset(id: ExportPresetId, totalS: number): boolean {
  const p = exportPresetById(id);
  return p !== null && totalS > p.maxDurationS;
}
