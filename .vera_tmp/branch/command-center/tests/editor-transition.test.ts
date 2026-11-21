// @vitest-environment jsdom
/**
 * Cross-fade styles (backend half): the closed list, the pure model edit, and
 * what must survive: a style through layout / trim / split / the model round
 * trip / a #434 draft, and the plain fade staying "no field" so a project that
 * never picks one keeps exactly the document it had. The Python half
 * (tests/test_editor_transitions.py) renders every style with real ffmpeg.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { allowDraftWrites, readDraft, writeDraft } from "@/lib/editor-draft";
import {
  XFADE_DEFAULT_STYLE,
  XFADE_STYLES,
  addClip,
  crossfadeOf,
  layout,
  newDocForAsset,
  removeClip,
  setCrossfade,
  setCrossfadeStyle,
  splitClip,
  toDoc,
  toModel,
  trimClip,
  validateTimeline,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** Two clips of 6 s and 4 s with a cross-fade of 1 s into the second. */
function joined(): EditorModel {
  let m = toModel(newDocForAsset({ id: A, durationS: 6, width: 1920, height: 1080 })!);
  m = addClip(m, { id: B, durationS: 4 });
  return setCrossfade(m, m.clips[1].id, 1);
}
const second = (m: EditorModel) => m.clips[1];
const styleOf = (m: EditorModel) => second(m).transition?.style;

describe("the styles", () => {
  it("are the document's closed list, in the picker's order", () => {
    expect([...XFADE_STYLES]).toEqual([
      "fade", "dissolve", "fadeblack", "fadewhite", "wipeleft", "wiperight", "slideleft",
      "slideright", "slideup", "slidedown", "circleopen", "circleclose", "radial", "zoomin",
      "wipeup", "wipedown", "smoothleft", "smoothright", "smoothup", "smoothdown", "vertopen",
      "vertclose", "horzopen", "horzclose", "diagtl", "diagtr", "diagbl", "diagbr", "wipetl",
      "wipetr", "wipebl", "wipebr", "squeezeh", "squeezev", "pixelize", "hblur", "distance",
    ]);
    expect(XFADE_DEFAULT_STYLE).toBe("fade");
    expect(new Set(XFADE_STYLES).size).toBe(XFADE_STYLES.length);
  });

  it("are each a valid document, and nothing else is", () => {
    for (const st of XFADE_STYLES) {
      const doc = toDoc(setCrossfadeStyle(joined(), second(joined()).id, st));
      expect(validateTimeline(doc), st).toEqual([]);
    }
    const doc = toDoc(joined()) as TimelineDoc;
    for (const bad of ["custom", "Fade", "fade ", "", null, 3, ["fade"], "fade:duration=9"]) {
      const d = structuredClone(doc);
      (d.tracks[0].clips[1].transition as Record<string, unknown>).style = bad;
      expect(validateTimeline(d).join(";"), String(bad)).toContain("style is not known");
    }
    const cut = structuredClone(doc);
    cut.tracks[0].clips[1].transition = { type: "cut", duration_s: 0, style: "wipeleft" };
    expect(validateTimeline(cut).join(";")).toContain("a style is only for a crossfade");
  });
});

describe("setCrossfadeStyle", () => {
  it("sets the style of the cross-fade into a clip and nothing else", () => {
    const m = joined();
    const next = setCrossfadeStyle(m, second(m).id, "circleopen");
    expect(styleOf(next)).toBe("circleopen");
    expect(second(next).transition).toEqual({ type: "crossfade", duration_s: 1, style: "circleopen" });
    expect({ ...second(next), transition: undefined }).toEqual({ ...second(m), transition: undefined });
    expect(next.clips[0]).toBe(m.clips[0]);
    expect(layout(next.clips).map((c) => c.start_s)).toEqual(layout(m.clips).map((c) => c.start_s));
  });

  it("removes the field for the plain fade, so a never-styled project is the document it was", () => {
    const m = joined();
    const before = toDoc(m);
    const styled = setCrossfadeStyle(m, second(m).id, "radial");
    expect(toDoc(styled)).not.toEqual(before);
    const back = setCrossfadeStyle(styled, second(styled).id, "fade");
    expect("style" in (second(back).transition ?? {})).toBe(false);
    expect(toDoc(back)).toEqual(before);
    expect(JSON.stringify(toDoc(back))).toBe(JSON.stringify(before));
  });

  it("returns the same model when nothing changes (not an undo step)", () => {
    const m = joined();
    expect(setCrossfadeStyle(m, second(m).id, "fade")).toBe(m);
    const s = setCrossfadeStyle(m, second(m).id, "wiperight");
    expect(setCrossfadeStyle(s, second(s).id, "wiperight")).toBe(s);
    expect(setCrossfadeStyle(m, "nope", "wiperight")).toBe(m);
    expect(setCrossfadeStyle(m, m.clips[0].id, "wiperight")).toBe(m); // no cross-fade into the first clip
    expect(setCrossfadeStyle(m, second(m).id, "custom" as never)).toBe(m);
  });

  it("does nothing for a clip that is a cut", () => {
    const m = setCrossfade(joined(), second(joined()).id, 0);
    expect(second(m).transition).toBeUndefined();
    expect(setCrossfadeStyle(m, second(m).id, "wipeleft")).toBe(m);
  });

  it("is kept when the length changes, and gone with the cross-fade", () => {
    let m = setCrossfadeStyle(joined(), second(joined()).id, "slideleft");
    m = setCrossfade(m, second(m).id, 0.6);
    expect(second(m).transition).toEqual({ type: "crossfade", duration_s: 0.6, style: "slideleft" });
    expect(crossfadeOf(second(m))).toBe(0.6);
    m = setCrossfade(m, second(m).id, 0);
    expect(second(m).transition).toBeUndefined();
    // choosing a cross-fade again starts from the plain fade, not from the old style
    m = setCrossfade(m, second(m).id, 0.5);
    expect(second(m).transition).toEqual({ type: "crossfade", duration_s: 0.5 });
  });

  it("survives a trim, a split and removing another clip", () => {
    let m = setCrossfadeStyle(joined(), second(joined()).id, "zoomin");
    m = trimClip(m, second(m).id, "out", 3, 4);
    expect(styleOf(m)).toBe("zoomin");
    const first = m.clips[0].id;
    const split = splitClip(m, first, 2);
    expect(split).not.toBeNull();
    // the style stays on the clip it was on
    const sc = split!.model.clips.find((c) => c.transition?.type === "crossfade");
    expect(sc?.id).toBe(second(m).id);
    expect(sc?.transition?.style).toBe("zoomin");
    expect(validateTimeline(toDoc(split!.model))).toEqual([]);
    const gone = removeClip(m, first);
    expect(validateTimeline(toDoc(gone))).toEqual([]);
  });

  it("is dropped, never invented, when layout makes the cross-fade too short", () => {
    let m = setCrossfadeStyle(joined(), second(joined()).id, "wipeleft");
    m = trimClip(m, second(m).id, "out", 0, 0.3); // the clip is now shorter than the cross-fade can be
    const t = second(m).transition;
    if (t) expect(t.style === undefined || (XFADE_STYLES as readonly string[]).includes(t.style)).toBe(true);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("the model round trip", () => {
  it("keeps a style and drops the plain one, from any document", () => {
    const doc = toDoc(setCrossfadeStyle(joined(), second(joined()).id, "fadewhite"));
    expect(toDoc(toModel(doc))).toEqual(doc);
    const withFade = structuredClone(doc);
    (withFade.tracks[0].clips[1].transition as Record<string, unknown>).style = "fade";
    const round = toDoc(toModel(withFade));
    expect("style" in (round.tracks[0].clips[1].transition as object)).toBe(false);
    expect(validateTimeline(round)).toEqual([]);
    // a style on something that is not a cross-fade is not carried into the model
    const odd = structuredClone(doc);
    odd.tracks[0].clips[1].transition = { type: "dip_to_black", duration_s: 0.5, style: "wipeleft" };
    expect(toModel(odd).clips[1].transition).toEqual({ type: "dip_to_black", duration_s: 0.5 });
  });
});

describe("a #434 draft with styles", () => {
  beforeEach(() => {
    localStorage.clear();
    allowDraftWrites();
  });

  it("is read back as the same document, which is still valid", () => {
    const doc = toDoc(setCrossfadeStyle(joined(), second(joined()).id, "circleclose"));
    expect(writeDraft("u", "p", 4, { title: "T", doc }, 1000)).toBe("ok");
    const back = readDraft("u", "p", 4, 2000);
    expect(back?.doc).toEqual(doc);
    expect(validateTimeline(back!.doc)).toEqual([]);
    expect(toDoc(toModel(back!.doc))).toEqual(doc);
  });

  it("is dropped when the style would not render", () => {
    const doc = toDoc(setCrossfadeStyle(joined(), second(joined()).id, "circleclose"));
    (doc.tracks[0].clips[1].transition as Record<string, unknown>).style = "custom";
    writeDraft("u", "p", 4, { title: "T", doc }, 1000);
    expect(readDraft("u", "p", 4, 2000)).toBeNull();
  });
});

describe("the constants are the worker's", () => {
  it("match modules/timeline.py", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    const list = /XFADE_STYLES = \(([^)]*)\)/.exec(py)![1];
    expect([...list.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...XFADE_STYLES]);
  });
});
