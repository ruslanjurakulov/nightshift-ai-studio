/**
 * One edit, several frame sizes (migration 0129): the pure half, shared by the route and the editor.
 *
 * An export may be asked in the project's own frame (what an export always was) or in a frame of the CLOSED list of
 * export formats (lib/editorExportPresets.ts, the twin of schemas/export_presets.json). The browser and the route only
 * ever name a format by its id: no width, height or ratio travels from a client. The database reads the size from its
 * own copy of the list (editor_export_frame, 0129) and the worker checks the row against the file again.
 *
 * Each frame is ONE export: it takes one of the organization's three waiting-or-rendering places and one of its twenty
 * a day (0054), which is why one request names at most MAX_EXPORT_FRAMES.
 *
 * What a frame changes is the picture's width and height and nothing else: the frame rate, the clips, the texts and
 * every clip's own fit stay as saved. A clip whose shape is not the new frame's is fitted the way that clip already
 * says: "contain" (bars) unless the person chose "cover" or "blur" for it.
 */
import {
  toDoc,
  validateTimeline,
  type EditorAsset,
  type EditorExport,
  type EditorModel,
} from "@/lib/editor";
import {
  EXPORT_PRESETS,
  exportPresetById,
  isExportPresetId,
  type ExportPresetId,
} from "@/lib/editorExportPresets";

/** The choice that means "the project's own frame": the plain export, as before 0129. Not a preset id (ids are [a-z0-9_]). */
export const PROJECT_FRAME = "project";
export type ExportFrameChoice = typeof PROJECT_FRAME | ExportPresetId;

/** The most frames one request may name: the organization's in-flight cap (0054 / 0129: three waiting or rendering).
 *  A fourth could only be refused. tests/test_editor_export_frame_migration.py compares this with the SQL. */
export const MAX_EXPORT_FRAMES = 3;

export function isExportFrameChoice(v: unknown): v is ExportFrameChoice {
  return v === PROJECT_FRAME || isExportPresetId(v);
}

/**
 * The `frames` field of an export request, checked against the closed list: an array of 1 to MAX_EXPORT_FRAMES
 * different choices, each exactly "project" or a preset id (no trimming, no case folding, no numbers, no objects).
 * Anything else is refused whole (null): a request that is half understood is not carried out by half.
 * The project's own frame comes FIRST in the answer: the plain request refuses while any export of the project is in
 * flight, so it has to be asked before the others.
 */
export function parseExportFrames(raw: unknown): ExportFrameChoice[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_EXPORT_FRAMES) return null;
  const seen = new Set<ExportFrameChoice>();
  for (const v of raw) {
    if (!isExportFrameChoice(v) || seen.has(v)) return null;
    seen.add(v);
  }
  const order: ExportFrameChoice[] = [PROJECT_FRAME, ...EXPORT_PRESETS.map((p) => p.id)];
  return order.filter((c) => seen.has(c));
}

/** The formats the picker offers beside the project's own frame: every format whose size is NOT the project's (that
 *  one would be the same picture twice). */
export function otherFrames(model: Pick<EditorModel, "width" | "height">): ExportPresetId[] {
  return EXPORT_PRESETS.filter((p) => p.width !== model.width || p.height !== model.height).map((p) => p.id);
}

/**
 * Why this edit could not be exported in that format's frame: every rule of the timeline validator (the worker's
 * rules, written twice), applied to the document with the format's width and height. Several limits depend on the
 * frame's size (backwards play, smoothing, steadying, a blur under a cross-fade), so an edit that is fine in its own
 * frame can be over one in another. Empty = fine. The worker decides in the end; this only saves a wasted export.
 */
export function frameProblems(model: EditorModel, id: ExportPresetId): string[] {
  const p = exportPresetById(id);
  if (!p) return ["not an export format"];
  return validateTimeline(toDoc({ ...model, width: p.width, height: p.height }));
}

/** Which frame an export row was asked in, as a choice. */
export function exportFrameChoice(e: Pick<EditorExport, "frame">): string {
  return e.frame ? e.frame.preset : PROJECT_FRAME;
}

/**
 * The newest export of each frame, newest first: what the editor shows when one edit was exported in several sizes.
 * `exports` is newest first (the server's order). Only the frames of the newest revision that was exported are kept,
 * plus anything still waiting or rendering, so last week's sizes do not sit under today's.
 */
export function latestPerFrame(exports: readonly EditorExport[]): EditorExport[] {
  if (!exports.length) return [];
  const rev = exports[0].rev;
  const seen = new Set<string>();
  const out: EditorExport[] = [];
  for (const e of exports) {
    const key = exportFrameChoice(e);
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.rev === rev || e.status === "queued" || e.status === "rendering") out.push(e);
  }
  return out;
}

/**
 * A finished export whose file is NOT the size it was asked in: the file's own width and height (as the library
 * measured them) against the row's frame. null when they agree, when the export has no frame, or when the size is
 * not known (an unknown is never shown as a mismatch). This is what makes a worker older than 0129 visible: it
 * would render the project's frame.
 */
export function frameMismatch(
  e: Pick<EditorExport, "frame" | "status">,
  asset: Pick<EditorAsset, "width" | "height"> | undefined,
): { width: number; height: number } | null {
  if (!e.frame || e.status !== "done" || !asset) return null;
  const { width, height } = asset;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return width === e.frame.width && height === e.frame.height ? null : { width, height };
}
