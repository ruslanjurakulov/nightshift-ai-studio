// @vitest-environment jsdom
/**
 * "Reuse a look" (editor parity phase 2): sync lock (texts, sounds, overlays and shapes follow ripple edits of the
 * picture, a locked lane keeps its times), multi-select edits (delete, move, nudge, copy / paste of a list) and paste
 * attributes with presets. What would break without these: a title left behind on the wrong shot after a delete, a
 * title between two silence cuts moved by both, an item pushed before 0, a multi-delete that is several undo steps
 * or leaves the picture empty, a pasted look the validator refuses, a hostile stored preset that crashes the editor
 * or reaches the document.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_EDITOR_TEXTS,
  V_CLIP_FIELDS,
  clipEnd,
  insertClipCopy,
  layout,
  removeClip,
  rippleTrimTo,
  splitClip,
  rollEdit,
  toDoc,
  trimClip,
  closeGap,
  validateTimeline,
  type EditorModel,
  type PictureOverlay,
  type SoundClip,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";
import { liftRange } from "@/lib/editorRange";
import { applyCuts } from "@/lib/editorSilence";
import { ALL_LOCKED, NO_LOCKS, extractInSync, insertInSync, loadLocks, rippleOf, saveLocks, shiftedStart, syncLock } from "@/lib/editorSync";
import {
  allItems,
  copyItems,
  existing,
  marqueeHits,
  moveClips,
  nudgeItems,
  pasteItems,
  removeItems,
  selectFrom,
  toggleItem,
  type Item,
} from "@/lib/editorSelection";
import {
  GROUP_FIELDS,
  LOOK_GROUPS,
  MAX_PRESETS,
  MAX_PRESET_BYTES,
  MAX_PRESET_NAME,
  NOT_LOOK,
  PRESET_VERSION,
  cleanPresetName,
  copyLook,
  groupsIn,
  loadPresets,
  parsePresets,
  pasteLook,
  presetStoreKey,
  sanitizeLook,
  savePresets,
  serializePresets,
  unclassifiedFields,
  withPreset,
} from "@/lib/editorPasteLook";
import type { ShapeLayer } from "@/lib/editorShapes";

const A = "11111111-1111-4111-8111-111111111111"; // a 10 s video
const P = "33333333-3333-4333-8333-333333333333"; // a picture
const O = "55555555-5555-4555-8555-555555555555"; // an overlay picture
const M = "44444444-4444-4444-8444-444444444444"; // a 30 s sound
const kindOf = (id: string) => (id === P ? ("image" as const) : id === M ? ("audio" as const) : ("video" as const));

const clip = (id: string, extra: Partial<VideoClip> = {}): VideoClip => ({
  id, asset_id: A, start_s: 0, in_s: 0, out_s: 4, speed: 1, audio: true, ...extra,
});
const text = (id: string, start: number, end = start + 1): TextClip => ({
  id, start_s: start, end_s: end, text: id, size: 64, x: 0.5, y: 0.85, anchor: "center",
});
const sound = (id: string, start: number): SoundClip => ({
  id, asset_id: M, start_s: start, in_s: 0, out_s: 1, gain_db: 0, fade_in_s: 0, fade_out_s: 0,
});
const overlay = (id: string, start: number): PictureOverlay => ({
  id, asset_id: O, start_s: start, end_s: start + 1, x: 0.5, y: 0.5, w: 0.3, opacity: 1,
});
const shape = (id: string, start: number): ShapeLayer => ({
  id, kind: "circle", start_s: start, end_s: start + 1, color: "#FFFFFF", opacity: 1,
});
/** c1 [0,4] A 0-4, c2 [4,8] A 2-6, c3 [8,12] A 5-9; a text before (x1 at 1), over c2 (x2 at 5), over c3 (x3 at 9),
 *  a sound at 9, an overlay at 10, a shape at 8.5. */
const scene = (extra: Partial<EditorModel> = {}): EditorModel => ({
  width: 1920,
  height: 1080,
  fps: 30,
  clips: layout([clip("c1"), clip("c2", { in_s: 2, out_s: 6 }), clip("c3", { in_s: 5, out_s: 9 })]),
  texts: [text("x1", 1), text("x2", 5), text("x3", 9)],
  sounds: [sound("m1", 9)],
  overlays: [overlay("o1", 10)],
  shapes: [shape("h1", 8.5)],
  keep: [],
  ...extra,
});
const at = (m: EditorModel) => ({
  texts: Object.fromEntries(m.texts.map((x) => [x.id, x.start_s])),
  sounds: Object.fromEntries(m.sounds.map((x) => [x.id, x.start_s])),
  overlays: Object.fromEntries((m.overlays ?? []).map((x) => [x.id, x.start_s])),
  shapes: Object.fromEntries((m.shapes ?? []).map((x) => [x.id, x.start_s])),
});
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const lengths = (m: EditorModel) => [
  ...m.texts.map((x) => x.end_s - x.start_s),
  ...(m.overlays ?? []).map((x) => x.end_s - x.start_s),
  ...(m.shapes ?? []).map((x) => x.end_s - x.start_s),
];

describe("sync lock: what follows a ripple edit of the picture", () => {
  it("deleting a clip moves everything after it up by that clip, and what was over it to the cut", () => {
    const m = scene();
    const out = syncLock(m, removeClip(m, "c2"), NO_LOCKS);
    expect(at(out)).toEqual({ texts: { x1: 1, x2: 4, x3: 5 }, sounds: { m1: 5 }, overlays: { o1: 6 }, shapes: { h1: 4.5 } });
    // lengths are kept: nothing is trimmed
    expect(lengths(out)).toEqual(lengths(m));
    valid(out);
  });

  it("a locked lane keeps its times; the others still follow", () => {
    const m = scene();
    const out = syncLock(m, removeClip(m, "c2"), { ...NO_LOCKS, texts: true, overlays: true });
    expect(at(out)).toEqual({ texts: { x1: 1, x2: 5, x3: 9 }, sounds: { m1: 5 }, overlays: { o1: 10 }, shapes: { h1: 4.5 } });
    // every lane locked is the editor before sync lock: nothing moves
    expect(syncLock(m, removeClip(m, "c2"), ALL_LOCKED).texts).toEqual(m.texts);
  });

  it("a tail trim moves what is after the clip; what was over the part trimmed away goes to the clip's new end", () => {
    const m = { ...scene(), texts: [text("x2", 5), text("tail", 7.5), text("x3", 9)] };
    const out = syncLock(m, trimClip(m, "c2", "out", 5, 10), NO_LOCKS);
    expect(at(out).texts).toEqual({ x2: 5, tail: 7, x3: 8 });
  });

  it("a head trim (Q) moves the rest of that clip's picture up with it: a title stays on its frame", () => {
    const m = { ...scene(), texts: [text("gone", 4.5), text("kept", 5.5), text("x3", 9)] };
    const r = rippleTrimTo(m, 5, "head")!;
    const out = syncLock(m, r.model, NO_LOCKS);
    // 1 s of c2's head went: its frame at 5.5 is now at 4.5; the one at 4.5 was trimmed away, so to the clip's start
    expect(at(out).texts).toEqual({ gone: 4, kept: 4.5, x3: 8 });
  });

  it("ripple delete between marks moves the later items by the range, those inside it to the cut", () => {
    const m = { ...scene(), texts: [text("x1", 1), text("in", 4), text("x2", 5), text("x3", 9)] };
    const out = extractInSync(m, 3, 5, NO_LOCKS);
    if ("problem" in out) throw new Error(out.problem);
    expect(at(out.model).texts).toEqual({ x1: 1, in: 3, x2: 3, x3: 7 });
    expect(at(out.model).overlays).toEqual({ o1: 8 });
    // the sound lane is cut and moved by the range itself, once (not twice)
    expect(at(out.model).sounds).toEqual({ m1: 7 });
    valid(out.model);
    // with the sound lane locked the sounds are neither cut nor moved
    const locked = extractInSync(m, 3, 5, { ...NO_LOCKS, sounds: true });
    if ("problem" in locked) throw new Error(locked.problem);
    expect(locked.model.sounds).toEqual(m.sounds);
  });

  it("an insert at the playhead moves what starts after it later by the copy's length", () => {
    const m = { ...scene(), texts: [text("x1", 1), text("before", 5), text("after", 7), text("x3", 9)] };
    const out = insertInSync(m, clip("cx", { in_s: 0, out_s: 2 }), 6, NO_LOCKS);
    if ("problem" in out) throw new Error(out.problem);
    expect(at(out.model).texts).toEqual({ x1: 1, before: 5, after: 9, x3: 11 });
    valid(out.model);
  });

  it("a paste or duplicate after a clip moves what is after that clip", () => {
    const m = scene();
    const dup = insertClipCopy(m, m.clips[0], "c1")!;
    const out = syncLock(m, dup.model, NO_LOCKS);
    expect(at(out).texts).toEqual({ x1: 1, x2: 9, x3: 13 });
  });

  it("closing a gap moves what is after it up; what was over the black goes to the cut", () => {
    const lifted = liftRange(scene(), 4, 8);
    if ("problem" in lifted) throw new Error(lifted.problem);
    const m = { ...lifted.model, texts: [text("black", 6), text("x3", 9)] };
    const out = syncLock(m, closeGap(m, "c3"), NO_LOCKS);
    expect(at(out).texts).toEqual({ black: 4, x3: 5 });
  });

  it("an edit that keeps the picture's timing moves nothing: a split, a roll, a lift", () => {
    const m = scene();
    expect(rippleOf(m, splitClip(m, "c2", 6)!.model)).toBeNull();
    expect(rippleOf(m, rollEdit(m, "c2", 0.5, () => 10))).toBeNull();
    const lifted = liftRange(m, 4, 6);
    if ("problem" in lifted) throw new Error(lifted.problem);
    expect(syncLock(m, lifted.model, NO_LOCKS).texts).toEqual(m.texts);
  });

  it("nothing is ever put before the edit point, so never before 0", () => {
    for (let s = 0; s <= 12; s += 0.25) {
      const r = { from: 2, to: 6, by: -4, kept: [] };
      const v = shiftedStart(s, r);
      expect(v).toBeGreaterThanOrEqual(0);
      if (s >= 2) expect(v).toBeGreaterThanOrEqual(2);
      else expect(v).toBe(s);
    }
    // removing the first clip: what was over it goes to 0, not below
    const m = scene({ texts: [text("x0", 0.5), text("x2", 5)] });
    const out = syncLock(m, removeClip(m, "c1"), NO_LOCKS);
    expect(at(out).texts).toEqual({ x0: 0, x2: 1 });
  });

  it("the locks are remembered in this browser, and garbage stored there is no lock", () => {
    saveLocks({ ...NO_LOCKS, shapes: true });
    expect(loadLocks()).toEqual({ ...NO_LOCKS, shapes: true });
    localStorage.setItem("ns:editor:sync-locks:v1", "{not json");
    expect(loadLocks()).toEqual(NO_LOCKS);
    localStorage.setItem("ns:editor:sync-locks:v1", JSON.stringify({ texts: "yes", sounds: 1 }));
    expect(loadLocks()).toEqual(NO_LOCKS);
    localStorage.removeItem("ns:editor:sync-locks:v1");
  });
});

describe("silence cuts with sync lock (the texts now move; before, they kept their times)", () => {
  /** One 10 s clip with a title over a word between two cuts and one after both. */
  const talk = (): EditorModel => ({
    width: 1920,
    height: 1080,
    fps: 30,
    clips: layout([clip("c1", { out_s: 10 })]),
    texts: [text("between", 4.5), text("after", 8)],
    sounds: [sound("hit", 8)],
    keep: [],
  });
  it("each cut moves what is after it by that cut alone: a title between two cuts by the first only", () => {
    const m = talk();
    const out = applyCuts(m, "c1", [[2, 3], [6, 7]]);
    expect(out.applied).toBe(2);
    expect(at(out.model).texts).toEqual({ between: 3.5, after: 6 });
    expect(at(out.model).sounds).toEqual({ hit: 6 });
    valid(out.model);
  });
  it("with the lanes locked the texts and sounds keep their times, as the editor did before", () => {
    const out = applyCuts(talk(), "c1", [[2, 3], [6, 7]], ALL_LOCKED);
    expect(at(out.model).texts).toEqual({ between: 4.5, after: 8 });
    expect(at(out.model).sounds).toEqual({ hit: 8 });
  });
});

describe("multi-select edits", () => {
  const all = (m: EditorModel) => allItems(m);
  it("toggle adds and takes out; existing drops what the model no longer has", () => {
    let s: Item[] = [];
    s = toggleItem(s, { kind: "clip", id: "c1" });
    s = toggleItem(s, { kind: "text", id: "x2" });
    expect(s).toHaveLength(2);
    s = toggleItem(s, { kind: "clip", id: "c1" });
    expect(s).toEqual([{ kind: "text", id: "x2" }]);
    expect(existing(scene(), [...s, { kind: "text", id: "gone" }])).toEqual(s);
  });

  it("a marquee takes every box it touches, either corner first", () => {
    const boxes = [
      { item: { kind: "clip" as const, id: "c1" }, left: 0, top: 0, right: 100, bottom: 50 },
      { item: { kind: "text" as const, id: "x1" }, left: 120, top: 60, right: 200, bottom: 80 },
    ];
    expect(marqueeHits(boxes, 90, 10, 130, 70).map((x) => x.id)).toEqual(["c1", "x1"]);
    expect(marqueeHits(boxes, 130, 70, 90, 10).map((x) => x.id)).toEqual(["c1", "x1"]);
    expect(marqueeHits(boxes, 101, 51, 119, 59)).toEqual([]);
  });

  it("track select forward takes every item that starts at or after the playhead", () => {
    expect(selectFrom(scene(), 8).map((x) => x.id).sort()).toEqual(["c3", "h1", "m1", "o1", "x3"].sort());
  });

  it("delete takes everything selected in one change, with sync lock per clip, and keeps one clip", () => {
    const m = scene();
    const out = removeItems(m, [{ kind: "clip", id: "c1" }, { kind: "clip", id: "c2" }, { kind: "text", id: "x1" }], NO_LOCKS);
    expect(out.removed).toBe(3);
    expect(out.model.clips.map((c) => c.id)).toEqual(["c3"]);
    // c1 and c2 went (8 s): x3 at 9 is at 1, x2 (over c2) went to the cut at 0
    expect(at(out.model).texts).toEqual({ x2: 0, x3: 1 });
    valid(out.model);
    const every = removeItems(m, all(m), NO_LOCKS);
    expect(every.model.clips).toHaveLength(1);
    expect(every.keptClip).toBe("c1");
    expect(every.model.texts).toEqual([]);
    valid(every.model);
  });

  it("move takes the selected clips one place as a block; at the end it does nothing", () => {
    const m = scene();
    const sel: Item[] = [{ kind: "clip", id: "c2" }, { kind: "clip", id: "c3" }];
    expect(layout(moveClips(m, sel, -1).clips).map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(moveClips(m, sel, 1)).toBe(m);
    valid(moveClips(m, sel, -1));
  });

  it("nudge moves texts, sounds, overlays and shapes together, never before 0; picture clips stay", () => {
    const m = scene();
    const sel: Item[] = [{ kind: "text", id: "x1" }, { kind: "sound", id: "m1" }, { kind: "clip", id: "c1" }];
    const r = nudgeItems(m, sel, 2 / 30);
    expect(r.moved).toBe(2);
    expect(at(r.model).texts.x1).toBeCloseTo(1 + 2 / 30, 3);
    expect(r.model.clips).toBe(m.clips);
    // x1 starts at 1: a nudge of 5 s earlier is held to 1 s, and the sound keeps its distance
    const back = nudgeItems(m, sel, -5);
    expect(back.by).toBe(-1);
    expect(at(back.model)).toMatchObject({ texts: { x1: 0 }, sounds: { m1: 8 } });
    valid(back.model);
  });

  it("copy and paste a list: the clips after the selected clip, the rest at the playhead with their spacing", () => {
    const m = scene();
    const board = copyItems(m, [{ kind: "clip", id: "c1" }, { kind: "text", id: "x2" }, { kind: "overlay", id: "o1" }]);
    expect(board.texts[0].start_s).toBe(0);
    expect(board.overlays[0].start_s).toBe(5);
    const out = pasteItems(m, board, "c3", 2, { locks: NO_LOCKS });
    expect(out.skipped).toBe(0);
    expect(out.items.map((x) => x.kind)).toEqual(["clip", "text", "overlay"]);
    const pasted = out.model.texts.find((x) => x.id === out.items[1].id)!;
    expect(pasted.start_s).toBe(2);
    expect(out.model.overlays!.find((x) => x.id === out.items[2].id)!.start_s).toBe(7);
    valid(out.model);
  });

  it("a paste the project has no room for is left out and counted, never forced", () => {
    const m = scene({ texts: Array.from({ length: MAX_EDITOR_TEXTS }, (_, i) => text(`t${i}`, i * 0.1)) });
    const board = copyItems(m, [{ kind: "text", id: "t0" }, { kind: "clip", id: "c1" }]);
    const out = pasteItems(m, board, null, 0);
    expect(out.skipped).toBe(1);
    expect(out.model.texts).toHaveLength(MAX_EDITOR_TEXTS);
    valid(out.model);
  });
});

describe("paste attributes", () => {
  it("every field of a picture clip is in a group or named as no look (a new field must be sorted)", () => {
    expect(unclassifiedFields()).toEqual([]);
    // the groups and NOT_LOOK do not overlap, and every group field is a real field
    for (const g of LOOK_GROUPS) for (const k of GROUP_FIELDS[g]) {
      expect(NOT_LOOK).not.toContain(k);
      expect(V_CLIP_FIELDS).toContain(k);
    }
  });

  const looked = (): VideoClip =>
    clip("src", {
      grade: { brightness: 0.1, contrast: 1.2, saturation: 1.3 },
      filter: "warm",
      vignette: 0.4,
      color: { hue: 20 },
      mask: { shape: "ellipse", w: 0.5, h: 0.5 },
      fx: { glitch: 40 },
      move: { from: { zoom: 1 }, to: { zoom: 1.3 } },
      fade_in_s: 0.5,
      gain_db: -3,
    } as Partial<VideoClip>);

  it("copies only look fields, and pastes the ticked groups; a group replaces that group on the clip", () => {
    const look = copyLook(looked());
    expect(Object.keys(look)).not.toContain("in_s");
    expect(groupsIn(look)).toEqual(["effects", "grade", "color", "mask", "fx", "motion", "fades", "audio"]);
    const m = scene();
    const withBlur = { ...m, clips: m.clips.map((c) => (c.id === "c2" ? { ...c, blur: 5 } : c)) };
    const out = pasteLook(withBlur, ["c2", "c3"], look, ["effects", "color"], kindOf);
    expect(out.changed).toBe(2);
    const c2 = out.model.clips.find((c) => c.id === "c2")!;
    expect(c2.filter).toBe("warm");
    expect(c2.blur).toBeUndefined(); // the effects group was replaced, not added to
    expect(c2.color).toEqual({ hue: 20 });
    expect(c2.grade).toBeUndefined(); // not ticked
    expect(c2.in_s).toBe(2); // never the clip's place or part of its file
    valid(out.model);
  });

  it("skips what a clip of that kind cannot take: a picture has no sound of its own", () => {
    const m = scene({ clips: layout([clip("c1"), clip("pic", { asset_id: P, out_s: 3, audio: false })]) });
    const out = pasteLook(m, ["pic"], copyLook(looked()), ["audio", "color"], kindOf);
    expect(out.skipped).toEqual([{ clip: "pic", group: "audio", why: "kind" }]);
    expect(out.model.clips.find((c) => c.id === "pic")!.color).toEqual({ hue: 20 });
  });

  it("skips a value the validator refuses on that clip (a fade longer than a short clip), never forced", () => {
    const m = scene({ clips: layout([clip("c1"), clip("short", { out_s: 0.4 })]), texts: [], sounds: [], overlays: [], shapes: [] });
    const out = pasteLook(m, ["short"], { ...copyLook(looked()), fade_in_s: 2 }, ["fades", "color"], kindOf);
    expect(out.skipped).toEqual([{ clip: "short", group: "fades", why: "invalid" }]);
    expect(out.model.clips.find((c) => c.id === "short")!.color).toEqual({ hue: 20 });
    valid(out.model);
  });

  it("the same model back when nothing changes", () => {
    const m = scene();
    expect(pasteLook(m, ["c1"], {}, ["color"], kindOf).model).toBe(m);
    expect(pasteLook(m, ["nope"], copyLook(looked()), ["color"], kindOf).model).toBe(m);
  });
});

describe("look presets kept in this browser", () => {
  afterEach(() => localStorage.clear());
  const look = { color: { hue: 30 }, vignette: 0.3 };

  it("round-trip, per member, under a versioned key", () => {
    const r = withPreset([], "Warm", look);
    if ("problem" in r) throw new Error(r.problem);
    expect(savePresets(r.list, "u1")).toBe(true);
    expect(loadPresets("u1")).toEqual([{ name: "Warm", look }]);
    expect(loadPresets("u2")).toEqual([]);
    expect(presetStoreKey("u1")).toContain(`v${PRESET_VERSION}`);
  });

  it("garbage, another version, a wrong shape or an oversized value is an empty list, never an error", () => {
    for (const raw of [
      "{",
      "null",
      "[]",
      '"x"',
      JSON.stringify({ v: 0, presets: [{ name: "Old", look }] }),
      JSON.stringify({ v: 2, presets: [{ name: "New", look }] }),
      JSON.stringify({ presets: [{ name: "No version", look }] }),
      JSON.stringify({ v: 1, presets: "nope" }),
      JSON.stringify({ v: 1, presets: [{ name: "Big", look }], pad: "x".repeat(MAX_PRESET_BYTES) }),
    ])
      expect(parsePresets(raw), raw.slice(0, 40)).toEqual([]);
    localStorage.setItem(presetStoreKey("u1"), "\u0000\u0001garbage");
    expect(loadPresets("u1")).toEqual([]);
  });

  it("a hostile value never reaches the document: unknown keys, bad values, prototype keys are dropped", () => {
    const raw = JSON.stringify({
      v: 1,
      presets: [
        { name: "Evil", look: { __proto__: { polluted: true }, constructor: 1, id: "x", in_s: 99, speed: 10, color: { hue: 9999 }, mask: { shape: "rect", evil: 1 }, vignette: 0.2 } },
        { name: "Bad types", look: { grade: "bright", fx: [1, 2], move: { from: { zoom: "big" }, to: {} } } },
        { name: "  ", look },
        { name: 42, look },
        { name: "Warm", look },
        { name: "warm", look: { vignette: 0.9 } },
      ],
    });
    const list = parsePresets(raw);
    expect(list.map((p) => p.name)).toEqual(["Evil", "Warm"]);
    expect(list[0].look).toEqual({ vignette: 0.2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // an own "__proto__" key, as JSON.parse makes it, is not a look field and pollutes nothing
    const proto = parsePresets('{"v":1,"presets":[{"name":"Proto","look":{"__proto__":{"polluted":true},"vignette":0.2}}]}');
    expect(proto).toEqual([{ name: "Proto", look: { vignette: 0.2 } }]);
    expect(Object.getPrototypeOf(proto[0].look)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // what a preset pastes always validates
    const m = scene();
    for (const p of list) valid(pasteLook(m, ["c1", "c2"], p.look, LOOK_GROUPS, kindOf).model);
  });

  it("names are cleaned and capped; the list is capped in number and in size", () => {
    expect(cleanPresetName("  a\u0000b‮c  ")).toBe("a b c");
    expect(cleanPresetName("x".repeat(100))).toHaveLength(MAX_PRESET_NAME);
    expect(withPreset([], "  ", look)).toEqual({ problem: "no_name" });
    expect(withPreset([], "Empty", { in_s: 3 })).toEqual({ problem: "empty" });
    let list: { name: string; look: typeof look }[] = [];
    for (let i = 0; i < MAX_PRESETS; i += 1) {
      const r = withPreset(list, `P${i}`, look);
      if ("problem" in r) throw new Error(r.problem);
      list = r.list as typeof list;
    }
    expect(withPreset(list, "One more", look)).toEqual({ problem: "full" });
    // the same name (any case) replaces, so it still fits
    expect("list" in withPreset(list, "p3", { vignette: 0.5 })).toBe(true);
    expect(serializePresets(list).length).toBeLessThanOrEqual(MAX_PRESET_BYTES);
    // stored past the cap in number: only the first MAX_PRESETS are read
    const many = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({ name: `N${i}`, look }));
    expect(parsePresets(JSON.stringify({ v: 1, presets: many }))).toHaveLength(MAX_PRESETS);
  });

  it("a stored look is put in the editor's own form (a no-change grade is no grade)", () => {
    expect(sanitizeLook({ grade: { brightness: 0, contrast: 1, saturation: 1 }, color: { hue: 0, tint: 5 } })).toEqual({ color: { tint: 5 } });
  });

  it("a browser that refuses storage is a failed save, not an error", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(savePresets([{ name: "x", look }], "u1")).toBe(false);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

void clipEnd;
