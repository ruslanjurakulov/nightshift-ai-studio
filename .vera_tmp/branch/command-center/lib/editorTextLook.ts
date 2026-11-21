/**
 * Text looks: ready-made styles for a text clip.
 *
 * A look is NOT an effect and not a new kind of object: it is a set of values
 * for fields a text clip already has (font, size, colour, outline, bold,
 * position, anchor) plus the three looks the export draws since this change
 * (`shadow`, `box_color`, `box_opacity`; modules/timeline.py). Applying one
 * writes those fields into the clip and nothing else; the text, its id and
 * its times are the clip's own. Because it is only data, the export, the
 * validators and the saved document need nothing special, and a look that is
 * later changed by hand is simply a clip with other numbers.
 *
 * The table below is also samples/text_looks.json: tests/editor-text-look
 * pins this file to it, and tests/test_editor_transitions.py renders every
 * look with the real export (ffmpeg + libass) and measures it, so no look
 * promises anything the export does not draw. Sizes are output pixels of a
 * frame whose short side is 1080 (every frame preset the editor offers).
 */
import type { Anchor, EditorModel, TextClip } from "@/lib/editor";

/** What a look sets. A field a look leaves out is REMOVED from the clip
 *  (back to the renderer's default), so two looks never mix. */
export interface TextLookFields {
  font: NonNullable<TextClip["font"]>;
  size: number;
  color: string;
  bold: boolean;
  outline_color: string;
  outline_width: number;
  x: number;
  y: number;
  anchor: Anchor;
  shadow?: number;
  box_color?: string;
  box_opacity?: number;
}

export interface TextLook {
  id: string;
  fields: TextLookFields;
}

/** Every key a look owns on a clip: applying a look clears all of them first. */
export const TEXT_LOOK_KEYS = [
  "font",
  "size",
  "color",
  "bold",
  "outline_color",
  "outline_width",
  "x",
  "y",
  "anchor",
  "shadow",
  "box_color",
  "box_opacity",
] as const;

export const TEXT_LOOKS: readonly TextLook[] = [
  {
    id: "title",
    fields: {
      font: "DejaVu Sans",
      size: 96,
      color: "#FFFFFF",
      bold: true,
      outline_color: "#000000",
      outline_width: 4,
      x: 0.5,
      y: 0.45,
      anchor: "center",
    },
  },
  {
    id: "lower_third",
    fields: {
      font: "DejaVu Sans",
      size: 52,
      color: "#FFFFFF",
      bold: true,
      outline_color: "#000000",
      outline_width: 0,
      x: 0.06,
      y: 0.88,
      anchor: "bottom-left",
      box_color: "#000000",
      box_opacity: 0.65,
    },
  },
  {
    id: "caption",
    fields: {
      font: "DejaVu Sans",
      size: 56,
      color: "#FFFFFF",
      bold: true,
      outline_color: "#000000",
      outline_width: 4,
      x: 0.5,
      y: 0.9,
      anchor: "bottom",
    },
  },
  {
    id: "subtitle",
    fields: {
      font: "Liberation Sans",
      size: 44,
      color: "#FFFFFF",
      bold: false,
      outline_color: "#000000",
      outline_width: 2,
      x: 0.5,
      y: 0.93,
      anchor: "bottom",
      shadow: 3,
    },
  },
  {
    id: "outline",
    fields: {
      font: "DejaVu Sans",
      size: 88,
      color: "#FFD400",
      bold: true,
      outline_color: "#000000",
      outline_width: 8,
      x: 0.5,
      y: 0.5,
      anchor: "center",
    },
  },
  {
    id: "shadow",
    fields: {
      font: "Liberation Serif",
      size: 80,
      color: "#FFFFFF",
      bold: true,
      outline_color: "#000000",
      outline_width: 0,
      x: 0.5,
      y: 0.5,
      anchor: "center",
      shadow: 8,
    },
  },
  {
    id: "label",
    fields: {
      font: "Liberation Sans",
      size: 56,
      color: "#111111",
      bold: true,
      outline_color: "#000000",
      outline_width: 0,
      x: 0.5,
      y: 0.78,
      anchor: "center",
      box_color: "#FFFFFF",
      box_opacity: 0.9,
    },
  },
  {
    id: "highlight",
    fields: {
      font: "DejaVu Sans",
      size: 56,
      color: "#111111",
      bold: true,
      outline_color: "#000000",
      outline_width: 0,
      x: 0.5,
      y: 0.78,
      anchor: "center",
      box_color: "#FFE600",
      box_opacity: 1,
    },
  },
];

export type TextLookId = (typeof TEXT_LOOKS)[number]["id"];

export function textLookById(id: string): TextLook | undefined {
  return TEXT_LOOKS.find((l) => l.id === id);
}

/** The text clip without any of the look-owned keys. */
function stripped(t: TextClip): TextClip {
  const rest: Record<string, unknown> = { ...t };
  for (const k of TEXT_LOOK_KEYS) delete rest[k];
  return rest as unknown as TextClip;
}

/**
 * The model with look `lookId` applied to text `id`. The look's fields
 * replace the clip's own for every key a look owns (a key the look does not
 * set is removed, so the renderer's default applies); text, id and times
 * stay. The same model back when the text or the look is unknown, or the clip
 * already is exactly that look (not an undo step).
 */
export function applyTextLook(
  model: EditorModel,
  id: string,
  lookId: string,
): EditorModel {
  const look = textLookById(lookId);
  const at = model.texts.find((t) => t.id === id);
  if (!look || !at) return model;
  if (textLookOf(at) === look.id) return model;
  const next: TextClip = { ...stripped(at), ...look.fields };
  return { ...model, texts: model.texts.map((t) => (t.id === id ? next : t)) };
}

/** Defaults for the keys a look may leave out (the renderer's own). */
const OMITTED: Record<string, unknown> = {
  shadow: undefined,
  box_color: undefined,
  box_opacity: undefined,
};

/** The id of the look a text clip has exactly, or null (a look edited by hand
 *  is no look). A position-only difference counts: the look includes where. */
export function textLookOf(t: TextClip): string | null {
  const own = t as unknown as Record<string, unknown>;
  for (const look of TEXT_LOOKS) {
    const want = look.fields as unknown as Record<string, unknown>;
    if (
      TEXT_LOOK_KEYS.every((k) => {
        const w = k in want ? want[k] : OMITTED[k];
        const g = own[k];
        // The fields the renderer defaults (bold absent = false, no outline
        // colour = black, ...) are not guessed: a clip must say them.
        return w === g;
      })
    )
      return look.id;
  }
  return null;
}
