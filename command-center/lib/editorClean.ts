/**
 * Chroma key, sound clean-up and stabilise: the pure model edits behind the
 * "Remove a background colour", "Clean up sound" and "Steady the picture"
 * controls (docs/editor-render-fields.md sections 7 and 10).
 *
 * Same rules as the other panels: the SAME model back when nothing changes,
 * clamped to the document's own limits (imported from lib/editor.ts), an "off"
 * value removes the field, and what the document refuses is made impossible
 * here with the number that decides it (`stabilizeCheck`).
 */
import {
  CHROMA_BLEND_DEFAULT,
  CHROMA_BLEND_MAX,
  CHROMA_SIMILARITY_DEFAULT,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  STABILIZE_MAX_DOC_S,
  STABILIZE_MAX_S,
  clamp,
  ms,
  type ChromaKey,
  type EditorModel,
  type PictureOverlay,
  type SoundClip,
  type VideoClip,
} from "@/lib/editor";
import { renderWork, sourceRange, type RenderWork } from "@/lib/editorMotion";

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
const HEX = /^#[0-9a-fA-F]{6}$/;

// ── chroma key (an overlay's) ───────────────────────────────────────────────

/** Ready colours for the two usual backdrops (a UI choice; the document takes any #RRGGBB). */
export const CHROMA_COLORS = { green: "#00FF00", blue: "#0000FF" } as const;

/** The key with the document's defaults filled in, or null. */
export function chromaOf(
  o: Pick<PictureOverlay, "chroma">,
): { color: string; similarity: number; blend: number } | null {
  return o.chroma
    ? {
        color: o.chroma.color,
        similarity: o.chroma.similarity ?? CHROMA_SIMILARITY_DEFAULT,
        blend: o.chroma.blend ?? CHROMA_BLEND_DEFAULT,
      }
    : null;
}

function withOverlay(
  model: EditorModel,
  id: string,
  f: (o: PictureOverlay) => PictureOverlay,
): EditorModel {
  const list = model.overlays ?? [];
  const at = list.find((o) => o.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return { ...model, overlays: list.map((o) => (o.id === id ? next : o)) };
}

/** Turn the key on (green, the document's default softness) or off (null). */
export function setOverlayChroma(
  model: EditorModel,
  id: string,
  chroma: ChromaKey | null,
): EditorModel {
  return withOverlay(model, id, (o) => {
    if (chroma === null) {
      if (!o.chroma) return o;
      const { chroma: _old, ...rest } = o;
      void _old;
      return rest;
    }
    if (!HEX.test(chroma.color)) return o;
    return JSON.stringify(chroma) === JSON.stringify(o.chroma)
      ? o
      : { ...o, chroma };
  });
}

export function startChroma(model: EditorModel, id: string): EditorModel {
  return withOverlay(model, id, (o) =>
    o.chroma ? o : { ...o, chroma: { color: CHROMA_COLORS.green } },
  );
}

/** The colour to remove, as #RRGGBB (any case; stored upper case). Refused otherwise. */
export function setChromaColor(model: EditorModel, id: string, color: string): EditorModel {
  if (!HEX.test(color)) return model;
  return withOverlay(model, id, (o) => {
    if (!o.chroma) return o;
    const next = color.toUpperCase();
    return next === o.chroma.color ? o : { ...o, chroma: { ...o.chroma, color: next } };
  });
}

/** How far from the colour still goes (similarity) or how soft the edge is
 *  (blend), clamped to the document's range; the default is stored as nothing. */
export function setChromaAmount(
  model: EditorModel,
  id: string,
  key: "similarity" | "blend",
  value: number,
): EditorModel {
  return withOverlay(model, id, (o) => {
    if (!o.chroma) return o;
    const lo = key === "similarity" ? CHROMA_SIMILARITY_MIN : 0;
    const hi = key === "similarity" ? CHROMA_SIMILARITY_MAX : CHROMA_BLEND_MAX;
    const def = key === "similarity" ? CHROMA_SIMILARITY_DEFAULT : CHROMA_BLEND_DEFAULT;
    const now = o.chroma[key] ?? def;
    const v = round3(clamp(finite(value, now), lo, hi));
    if (v === now) return o;
    const next: ChromaKey = { ...o.chroma, [key]: v };
    if (v === def) delete next[key];
    return { ...o, chroma: next };
  });
}

// ── sound clean-up ──────────────────────────────────────────────────────────

export type CleanKey = "denoise" | "loudnorm";

/** Turn a clean-up on or off for a video clip's own sound. */
export function setClipClean(
  model: EditorModel,
  id: string,
  key: CleanKey,
  on: boolean,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at || Boolean(at[key]) === on) return model;
  const next: VideoClip = { ...at };
  if (on) next[key] = true;
  else delete next[key];
  return { ...model, clips: model.clips.map((c) => (c.id === id ? next : c)) };
}

/** Turn a clean-up on or off for a music or sound-effect clip. */
export function setSoundClean(
  model: EditorModel,
  id: string,
  key: CleanKey,
  on: boolean,
): EditorModel {
  const at = model.sounds.find((x) => x.id === id);
  if (!at || Boolean(at[key]) === on) return model;
  const next: SoundClip = { ...at };
  if (on) next[key] = true;
  else delete next[key];
  return { ...model, sounds: model.sounds.map((x) => (x.id === id ? next : x)) };
}

// ── stabilise ───────────────────────────────────────────────────────────────

/** The seconds of source the other clips of the project already stabilise. */
export function stabilizeUsedByOthers(model: EditorModel, exceptId: string): number {
  return ms(
    model.clips
      .filter((c) => c.id !== exceptId && c.stabilize)
      .reduce((n, c) => n + sourceRange(c), 0),
  );
}

export type StabilizeCheck =
  | { ok: true; range: number; used: number; render: RenderWork }
  | {
      ok: false;
      reason: "freeze" | "clip_range" | "doc_budget" | "render_time";
      range: number;
      used: number;
      render: RenderWork;
    };

/**
 * Can this clip be stabilised? (Judged as if it were on: the same answer tells a
 * clip that is on whether it still fits.) Not a frozen frame; its source range
 * within STABILIZE_MAX_S; the project's stabilised ranges within STABILIZE_MAX_DOC_S;
 * and the export's time allowance (`renderWork`: the timeline, the interpolated
 * frames and the steadying, weighted by frame size, against `renderTimeoutS`).
 */
export function stabilizeCheck(model: EditorModel, c: VideoClip): StabilizeCheck {
  const range = sourceRange(c);
  const used = stabilizeUsedByOthers(model, c.id);
  const render = renderWork({
    ...model,
    clips: model.clips.map((x) => (x.id === c.id ? { ...x, stabilize: true } : x)),
  });
  if (c.freeze) return { ok: false, reason: "freeze", range, used, render };
  if (range > STABILIZE_MAX_S + 1e-9) return { ok: false, reason: "clip_range", range, used, render };
  if (used + range > STABILIZE_MAX_DOC_S + 1e-9)
    return { ok: false, reason: "doc_budget", range, used, render };
  if (!render.ok) return { ok: false, reason: "render_time", range, used, render };
  return { ok: true, range, used, render };
}

export function setClipStabilize(model: EditorModel, id: string, on: boolean): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at || Boolean(at.stabilize) === on) return model;
  if (on && !stabilizeCheck(model, at).ok) return model;
  const next: VideoClip = { ...at };
  if (on) next.stabilize = true;
  else delete next.stabilize;
  return { ...model, clips: model.clips.map((c) => (c.id === id ? next : c)) };
}
