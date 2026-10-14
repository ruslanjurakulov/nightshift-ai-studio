// @vitest-environment jsdom
/**
 * Text looks (backend half): the table is the fixture the Python test renders
 * with the real export, applying one only writes fields a text clip already
 * has (plus the three the export draws), two looks never mix, and a look
 * survives the model round trip and a #434 draft.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { allowDraftWrites, readDraft, writeDraft } from "@/lib/editor-draft";
import {
  SHADOW_MAX,
  addText,
  newDocForAsset,
  toDoc,
  toModel,
  updateText,
  validateTimeline,
  type EditorModel,
  type TextClip,
} from "@/lib/editor";
import {
  TEXT_LOOKS,
  TEXT_LOOK_KEYS,
  applyTextLook,
  textLookById,
  textLookOf,
} from "@/lib/editorTextLook";

const A = "11111111-1111-4111-8111-111111111111";
const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "samples", "text_looks.json"), "utf8"),
) as { looks: { id: string; fields: Record<string, unknown> }[] };

function withText(): { m: EditorModel; id: string } {
  const m0 = toModel(newDocForAsset({ id: A, durationS: 10, width: 1080, height: 1920 })!);
  const r = addText(m0, 1, "Hello there")!;
  return { m: r.model, id: r.id };
}
const textOf = (m: EditorModel, id: string) => m.texts.find((t) => t.id === id)!;

describe("the table", () => {
  it("is samples/text_looks.json, field by field, in the same order", () => {
    expect(TEXT_LOOKS.map((l) => ({ id: l.id, fields: l.fields }))).toEqual(fixture.looks);
  });

  it("has eight looks with distinct ids, each a valid text", () => {
    expect(TEXT_LOOKS).toHaveLength(8);
    expect(new Set(TEXT_LOOKS.map((l) => l.id)).size).toBe(8);
    const { m, id } = withText();
    for (const look of TEXT_LOOKS) {
      const doc = toDoc(applyTextLook(m, id, look.id));
      expect(validateTimeline(doc), look.id).toEqual([]);
    }
  });

  it("only uses fields a text clip has, within the document's ranges", () => {
    for (const look of TEXT_LOOKS) {
      for (const k of Object.keys(look.fields)) expect(TEXT_LOOK_KEYS as readonly string[], k).toContain(k);
      const f = look.fields;
      expect(f.size).toBeGreaterThanOrEqual(24); // the editor's own size slider range
      expect(f.size).toBeLessThanOrEqual(200);
      if (f.shadow !== undefined) expect(f.shadow).toBeLessThanOrEqual(SHADOW_MAX);
      if (f.box_opacity !== undefined) expect(f.box_color).toBeDefined();
    }
  });
});

describe("applyTextLook", () => {
  it("writes the look's fields and keeps the text, id and times", () => {
    const { m, id } = withText();
    const before = textOf(m, id);
    const next = applyTextLook(m, id, "lower_third");
    const t = textOf(next, id);
    expect(t).toMatchObject(textLookById("lower_third")!.fields);
    expect([t.id, t.text, t.start_s, t.end_s]).toEqual([before.id, before.text, before.start_s, before.end_s]);
    expect(next.texts).toHaveLength(m.texts.length);
    expect(next.clips).toBe(m.clips);
  });

  it("never mixes two looks: a field the next look leaves out is gone", () => {
    const { m, id } = withText();
    const boxed = applyTextLook(m, id, "highlight");
    expect(textOf(boxed, id).box_color).toBe("#FFE600");
    const shadowed = applyTextLook(boxed, id, "shadow");
    const t = textOf(shadowed, id) as unknown as Record<string, unknown>;
    expect("box_color" in t).toBe(false);
    expect("box_opacity" in t).toBe(false);
    expect(t.shadow).toBe(8);
    const plain = applyTextLook(shadowed, id, "title") as EditorModel;
    expect("shadow" in (textOf(plain, id) as unknown as object)).toBe(false);
    expect(validateTimeline(toDoc(plain))).toEqual([]);
    // the document has no key set to undefined (it would be a field the validator sees)
    for (const l of TEXT_LOOKS) {
      const doc = toDoc(applyTextLook(applyTextLook(m, id, "highlight"), id, l.id));
      const clip = doc.tracks.find((tr) => tr.kind === "T")!.clips[0];
      for (const v of Object.values(clip)) expect(v).not.toBeUndefined();
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    }
  });

  it("returns the same model when nothing changes (not an undo step)", () => {
    const { m, id } = withText();
    const once = applyTextLook(m, id, "caption");
    expect(applyTextLook(once, id, "caption")).toBe(once);
    expect(applyTextLook(m, id, "nope")).toBe(m);
    expect(applyTextLook(m, "nope", "caption")).toBe(m);
  });

  it("is recognised afterwards, and a hand edit makes it no look", () => {
    const { m, id } = withText();
    expect(textLookOf(textOf(m, id))).toBeNull();
    for (const look of TEXT_LOOKS) {
      const t = textOf(applyTextLook(m, id, look.id), id);
      expect(textLookOf(t)).toBe(look.id);
    }
    const lt = applyTextLook(m, id, "title");
    const edited = updateText(lt, id, { size: 100 });
    expect(textLookOf(textOf(edited, id))).toBeNull();
    const edited2 = updateText(lt, id, { shadow: 3 });
    expect(textLookOf(textOf(edited2, id))).toBeNull();
    const moved = updateText(lt, id, { x: 0.2 });
    expect(textLookOf(textOf(moved, id))).toBeNull();
  });

  it("leaves other texts alone", () => {
    const { m, id } = withText();
    const r2 = addText(m, 2, "Second")!;
    const next = applyTextLook(r2.model, id, "outline");
    expect(textOf(next, r2.id)).toBe(textOf(r2.model, r2.id));
  });
});

describe("round trips", () => {
  it("a look comes back out of the document through the model", () => {
    const { m, id } = withText();
    for (const look of TEXT_LOOKS) {
      const doc = toDoc(applyTextLook(m, id, look.id));
      expect(toDoc(toModel(doc))).toEqual(doc);
      expect(textLookOf(textOf(toModel(doc), id) as TextClip)).toBe(look.id);
    }
  });

  describe("a #434 draft", () => {
    beforeEach(() => {
      localStorage.clear();
      allowDraftWrites();
    });

    it("is read back as the same document, still valid, still the look", () => {
      const { m, id } = withText();
      const doc = toDoc(applyTextLook(m, id, "label"));
      expect(writeDraft("u", "p", 4, { title: "T", doc }, 1000)).toBe("ok");
      const back = readDraft("u", "p", 4, 2000);
      expect(back?.doc).toEqual(doc);
      expect(validateTimeline(back!.doc)).toEqual([]);
      expect(textLookOf(textOf(toModel(back!.doc), id))).toBe("label");
    });

    it("is dropped when a look field would not render", () => {
      const { m, id } = withText();
      const doc = toDoc(applyTextLook(m, id, "label"));
      (doc.tracks.find((t) => t.kind === "T")!.clips[0] as Record<string, unknown>).shadow = 99;
      writeDraft("u", "p", 4, { title: "T", doc }, 1000);
      expect(readDraft("u", "p", 4, 2000)).toBeNull();
    });
  });
});

describe("the document's text validation", () => {
  const doc = () => {
    const { m, id } = withText();
    return { d: toDoc(applyTextLook(m, id, "label")), id };
  };
  const clipOf = (d: ReturnType<typeof toDoc>) =>
    d.tracks.find((t) => t.kind === "T")!.clips[0] as Record<string, unknown>;

  it("refuses a look outside its range or shape", () => {
    for (const [k, v, needle] of [
      ["shadow", -1, "shadow"],
      ["shadow", 21, "shadow"],
      ["shadow", "6", "shadow"],
      ["shadow", null, "shadow"],
      ["box_color", "yellow", "box_color"],
      ["box_color", "#FFF", "box_color"],
      ["box_color", "#112233\n", "box_color"],
      ["box_opacity", 1.5, "box_opacity"],
      ["box_opacity", -0.1, "box_opacity"],
      ["rotation", 10, "rotation"],
    ] as const) {
      const { d } = doc();
      clipOf(d)[k] = v;
      expect(validateTimeline(d).join(";"), `${k}=${String(v)}`).toContain(needle);
    }
    const { d } = doc();
    delete clipOf(d).box_color;
    expect(validateTimeline(d).join(";")).toContain("box_opacity needs a box_color");
  });

  it("does not take the looks on the captions' style", () => {
    const { d } = doc();
    d.captions = { style: { shadow: 3 }, cues: [{ id: "q1", start_s: 0, end_s: 1, text: "x" }] };
    expect(validateTimeline(d).join(";")).toContain("shadow is not a known field");
  });
});
