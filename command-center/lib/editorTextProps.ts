/**
 * A text's letter spacing, italic and line alignment: the pure model edits behind the inspector's "Text properties"
 * (docs/editor-render-fields.md section 18). The export writes them into the text's ASS style (Spacing, Italic) and
 * libass's Justify (modules/render_spec.py `overlay_subtitles_filter`). An "off" value is no field, so a text without
 * them is the document it always was; the same model back when nothing changes.
 */
import {
  ALIGNS,
  TRACKING_MAX,
  TRACKING_MIN,
  clamp,
  type EditorModel,
  type TextAlign,
  type TextClip,
} from "@/lib/editor";

function withText(model: EditorModel, id: string, f: (t: TextClip) => TextClip): EditorModel {
  const at = model.texts.find((t) => t.id === id);
  if (!at) return model;
  const next = f(at);
  return next === at ? model : { ...model, texts: model.texts.map((t) => (t.id === id ? next : t)) };
}

function without<K extends keyof TextClip>(t: TextClip, key: K): TextClip {
  const next = { ...t };
  delete next[key];
  return next;
}

/** Letter spacing in thousandths of the size, a whole number held to TRACKING_MIN..TRACKING_MAX; 0 is no field. */
export function setTextTracking(model: EditorModel, id: string, value: number): EditorModel {
  return withText(model, id, (t) => {
    const v = Number.isFinite(value) ? Math.round(clamp(value, TRACKING_MIN, TRACKING_MAX)) : 0;
    if (v === (t.tracking ?? 0)) return t;
    return v === 0 ? without(t, "tracking") : { ...t, tracking: v };
  });
}

export function setTextItalic(model: EditorModel, id: string, on: boolean): EditorModel {
  return withText(model, id, (t) => {
    if (Boolean(t.italic) === on) return t;
    return on ? { ...t, italic: true } : without(t, "italic");
  });
}

/** How the lines line up; null = as the anchor puts them (no field). */
export function setTextAlign(model: EditorModel, id: string, align: TextAlign | null): EditorModel {
  return withText(model, id, (t) => {
    if (align !== null && !(ALIGNS as readonly string[]).includes(align)) return t;
    if ((t.align ?? null) === align) return t;
    return align === null ? without(t, "align") : { ...t, align };
  });
}
