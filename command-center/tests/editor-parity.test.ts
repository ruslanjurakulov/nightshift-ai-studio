/**
 * Editor parity, first pass (model half, lib/editor.ts): a clip's own volume (0-200 %, `gain_db` on a
 * V clip, -60..+6 dB), "detach audio" (the clip's sound becomes a sound of its own on the same file),
 * duplicate / copy / paste of a clip, and the shortcut that runs them (lib/editor-shortcuts.ts). What
 * would break without these: a control that writes what the validator refuses, a detached sound that
 * no longer matches the picture it came from, a copy that shares an id or a cross-fade with its
 * original, a document that silently gains a field older validators refuse, or Ctrl+C stolen from a
 * person copying text. The shared document cases (samples/timeline_doc_cases.json) judge the same
 * rules in both validators (editor-timeline.test.ts and tests/test_editor_doc_cases.py).
 */
import { describe, expect, it } from "vitest";
import {
  CLIP_GAIN_DB_MAX,
  GAIN_DB_MIN,
  MAX_AUDIO_CLIPS,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  addClip,
  audioInputs,
  canInsertClip,
  clipEnd,
  clipVolumePct,
  detachClipAudio,
  detachProblem,
  docAssetProblems,
  duplicateClip,
  insertClipCopy,
  layout,
  newDocForAsset,
  setClipVolume,
  setCrossfade,
  setSpeed,
  toDoc,
  toModel,
  validateTimeline,
  volumePctToDb,
  type EditorModel,
  type SoundClip,
  type TimelineDoc,
  type VideoClip,
} from "@/lib/editor";
import { resolveClipShortcut, SHORTCUT_HELP } from "@/lib/editor-shortcuts";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const base = (clip: Partial<VideoClip> = {}): EditorModel => {
  const m = toModel(newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!);
  return { ...m, clips: m.clips.map((c) => ({ ...c, audio: true, ...clip })) };
};
const c0 = (m: EditorModel) => m.clips[0];
const v0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;
const sound = (id: string): SoundClip => ({ id, asset_id: B, start_s: 0, in_s: 0, out_s: 1, gain_db: 0, fade_in_s: 0, fade_out_s: 0 });

describe("a clip's own volume, 0 to 200 %", () => {
  it("maps percent to dB and back: 100 % is as recorded, 200 % is +6 dB, 0 % is the floor", () => {
    expect(volumePctToDb(100)).toBe(0);
    expect(volumePctToDb(200)).toBe(CLIP_GAIN_DB_MAX);
    expect(volumePctToDb(50)).toBe(-6.021);
    expect(volumePctToDb(0)).toBe(GAIN_DB_MIN);
    expect(volumePctToDb(-5)).toBe(GAIN_DB_MIN);
    expect(volumePctToDb(Number.NaN)).toBe(GAIN_DB_MIN);
    expect(volumePctToDb(1000)).toBe(CLIP_GAIN_DB_MAX);
    for (const pct of [0, 5, 25, 50, 75, 100, 150, 200]) expect(clipVolumePct({ gain_db: volumePctToDb(pct) }), String(pct)).toBe(pct);
    expect(clipVolumePct({})).toBe(100);
  });

  it("writes gain_db the validator accepts at every step, and 100 % removes the field", () => {
    for (let pct = 0; pct <= 200; pct += 5) {
      const m = setClipVolume(base(), "c1", pct);
      const doc = toDoc(m);
      expect(validateTimeline(doc), String(pct)).toEqual([]);
      if (pct === 100) expect("gain_db" in v0(doc)).toBe(false);
      else expect(v0(doc).gain_db).toBe(volumePctToDb(pct));
    }
    const m = base();
    expect(setClipVolume(m, "c1", 100)).toBe(m);
    expect(setClipVolume(m, "nope", 50)).toBe(m);
    const loud = setClipVolume(m, "c1", 200);
    expect(setClipVolume(loud, "c1", 200)).toBe(loud);
    // back to 100 % is the document it was: the field goes, it is not written as 0
    const back = setClipVolume(loud, "c1", 100);
    expect("gain_db" in c0(back)).toBe(false);
    expect(toDoc(back)).toEqual(toDoc(m));
  });

  it("survives the round trip through the document, and an untouched clip gains no field", () => {
    const m = setClipVolume(base(), "c1", 150);
    expect(c0(toModel(toDoc(m))).gain_db).toBe(c0(m).gain_db);
    expect("gain_db" in v0(toDoc(base()))).toBe(false);
    expect("gain_db" in c0(toModel({ ...toDoc(base()), tracks: [{ ...toDoc(base()).tracks[0], clips: [{ ...v0(toDoc(base())), gain_db: 0 }] }] }))).toBe(false);
  });

  it("the validator refuses a level past +6 dB, under -60 dB or not a number, and still refuses unknown fields", () => {
    const doc = (extra: Record<string, unknown>) => {
      const d = toDoc(base());
      Object.assign(v0(d), extra);
      return d;
    };
    expect(validateTimeline(doc({ gain_db: 6 }))).toEqual([]);
    expect(validateTimeline(doc({ gain_db: -60 }))).toEqual([]);
    for (const bad of [6.001, 12, -60.5, "3", null, true, Number.NaN, Number.POSITIVE_INFINITY])
      expect(validateTimeline(doc({ gain_db: bad })).join(";"), String(bad)).toContain("gain_db must be a number from -60 to 6");
    for (const k of ["volume", "gain", "mute"])
      expect(validateTimeline(doc({ [k]: 1 })).join(";"), k).toContain(`${k} is not a known field`);
  });
});

describe("detach audio", () => {
  it("moves the clip's sound to a speech sound of the same file, where it plays now, and silences the clip", () => {
    let m = base({ in_s: 2, out_s: 6, gain_db: -3, denoise: true });
    m = addClip(m, { id: A, durationS: 10 });
    const second = layout(m.clips)[1];
    const out = detachClipAudio(m, second.id, "video")!;
    expect(out).not.toBeNull();
    const s = out.model.sounds.find((x) => x.id === out.soundId)!;
    expect(s).toMatchObject({ asset_id: A, start_s: second.start_s, in_s: 0, out_s: 10, gain_db: 0, role: "speech" });
    const first = detachClipAudio(out.model, "c1", "video")!;
    const s1 = first.model.sounds.find((x) => x.id === first.soundId)!;
    expect(s1).toMatchObject({ start_s: 0, in_s: 2, out_s: 6, gain_db: -3, denoise: true });
    const c = first.model.clips.find((x) => x.id === "c1")!;
    expect(c.audio).toBe(false);
    expect(c.gain_db).toBeUndefined();
    expect(c.denoise).toBeUndefined();
    // one input of the mix either way, and the document validates
    expect(audioInputs(first.model)).toBe(audioInputs(m));
    expect(validateTimeline(toDoc(first.model))).toEqual([]);
    // the sound lasts as long as the clip played and starts where it did
    expect(s1.out_s - s1.in_s).toBe(clipEnd(c0(m)) - c0(m).start_s);
  });

  it("the document's file check takes a video's sound on a sound track, never a picture", () => {
    const out = detachClipAudio(base(), "c1", "video")!;
    const doc = toDoc(out.model);
    expect(docAssetProblems(doc, { [A]: "video" })).toEqual([]);
    const pic = toDoc({ ...out.model, sounds: [{ ...out.model.sounds[0], asset_id: B }] });
    expect(docAssetProblems(pic, { [A]: "video", [B]: "image" }).join(";")).toContain("a A track takes audio or video, not image");
  });

  it("is offered only for a forward clip at 1x that plays its own sound, from a video, with room for a sound", () => {
    expect(detachProblem(base(), "c1", "video")).toBeNull();
    expect(detachProblem(base({ audio: false }), "c1", "video")).toBe("no_sound");
    expect(detachProblem(base(), "c1", "image")).toBe("not_video");
    expect(detachProblem(base(), "c1", undefined)).toBe("not_video");
    expect(detachProblem(setSpeed(base(), "c1", 2), "c1", "video")).toBe("retimed");
    expect(detachProblem(base({ reverse: true, out_s: 4 }), "c1", "video")).toBe("retimed");
    expect(detachProblem(base({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }), "c1", "video")).toBe("retimed");
    const full = { ...base(), sounds: Array.from({ length: MAX_EDITOR_SOUNDS }, (_, i) => sound(`m${i + 10}`)) };
    expect(detachProblem(full, "c1", "video")).toBe("sounds_full");
    expect(detachClipAudio(full, "c1", "video")).toBeNull();
    expect(detachProblem(base(), "nope", "video")).toBe("no_sound");
  });
});

describe("duplicate, copy and paste", () => {
  it("a duplicate is the same clip with a fresh id right after it, and the picture is one clip longer", () => {
    let m = base({ out_s: 4, gain_db: -2, filter: "mono" });
    m = addClip(m, { id: A, durationS: 3 });
    const before = clipEnd(layout(m.clips)[1]);
    const out = duplicateClip(m, "c1")!;
    const ids = layout(out.model.clips).map((c) => c.id);
    expect(ids).toEqual(["c1", out.id, layout(m.clips)[1].id]);
    expect(new Set(ids).size).toBe(3);
    const copy = out.model.clips.find((c) => c.id === out.id)!;
    expect(copy).toMatchObject({ asset_id: A, in_s: 0, out_s: 4, gain_db: -2, filter: "mono", audio: true });
    expect(clipEnd(layout(out.model.clips)[2])).toBe(before + 4);
    expect(validateTimeline(toDoc(out.model))).toEqual([]);
  });

  it("a copy follows the clip before it with a cut, and changing it leaves the original alone", () => {
    let m = base({ out_s: 4 });
    m = addClip(m, { id: A, durationS: 4 });
    const second = layout(m.clips)[1].id;
    m = setCrossfade(m, second, 0.5);
    const src = m.clips.find((c) => c.id === second)!;
    expect(src.transition?.type).toBe("crossfade");
    const out = insertClipCopy(m, src, "c1")!;
    const copy = out.model.clips.find((c) => c.id === out.id)!;
    expect(copy.transition).toBeUndefined();
    copy.move = { from: { zoom: 2 }, to: { zoom: 1 } };
    expect(src.move).toBeUndefined();
    expect(validateTimeline(toDoc(out.model))).toEqual([]);
  });

  it("paste goes after the chosen clip, or at the end when that clip is gone", () => {
    let m = base({ out_s: 3 });
    m = addClip(m, { id: A, durationS: 2 });
    const clip = { ...c0(m) };
    const atEnd = insertClipCopy(m, clip, "gone")!;
    expect(layout(atEnd.model.clips).at(-1)!.id).toBe(atEnd.id);
    const after = insertClipCopy(m, clip, "c1")!;
    expect(layout(after.model.clips)[1].id).toBe(after.id);
  });

  it("is refused when the picture lane is full, and a copy's sound is off when the mix is full", () => {
    const one = c0(base());
    const full: EditorModel = { ...base(), clips: Array.from({ length: MAX_EDITOR_CLIPS }, (_, i) => ({ ...one, id: `c${i + 1}`, audio: false })) };
    expect(canInsertClip(full)).toBe(false);
    expect(duplicateClip(full, "c1")).toBeNull();
    const loud: EditorModel = { ...base(), clips: Array.from({ length: MAX_AUDIO_CLIPS - 1 }, (_, i) => ({ ...one, id: `c${i + 1}`, audio: i === 0 })) };
    const many = { ...loud, sounds: Array.from({ length: MAX_AUDIO_CLIPS - 1 }, (_, i) => sound(`m${i + 100}`)) };
    expect(audioInputs(many)).toBe(MAX_AUDIO_CLIPS);
    const out = duplicateClip(many, "c1")!;
    expect(out.model.clips.find((c) => c.id === out.id)!.audio).toBe(false);
  });
});

describe("the clipboard keys", () => {
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, ctrlKey: true, ...extra });
  it("Ctrl or Cmd + D, C, V on the editor; never in a text field, on a slider, with Alt or Shift, or held down", () => {
    expect(resolveClipShortcut(key("d"), "other")).toBe("duplicate");
    expect(resolveClipShortcut(key("c"), "control")).toBe("copy");
    expect(resolveClipShortcut({ key: "v", metaKey: true }, "choice")).toBe("paste");
    expect(resolveClipShortcut({ key: "d" }, "other")).toBeNull();
    expect(resolveClipShortcut(key("c"), "text")).toBeNull();
    expect(resolveClipShortcut(key("v"), "slider")).toBeNull();
    expect(resolveClipShortcut(key("d", { altKey: true }), "other")).toBeNull();
    expect(resolveClipShortcut(key("v", { shiftKey: true }), "other")).toBeNull();
    expect(resolveClipShortcut(key("d", { repeat: true }), "other")).toBeNull();
    expect(resolveClipShortcut(key("c", { defaultPrevented: true }), "other")).toBeNull();
    expect(resolveClipShortcut(key("x"), "other")).toBeNull();
  });

  it("copy stays the browser's while text is selected; a Cyrillic layout uses the physical key", () => {
    expect(resolveClipShortcut(key("c"), "other", true)).toBeNull();
    expect(resolveClipShortcut(key("v"), "other", true)).toBe("paste");
    expect(resolveClipShortcut(key("с", { code: "KeyC" }), "other")).toBe("copy");
    expect(resolveClipShortcut(key("в", { code: "KeyD" }), "other")).toBe("duplicate");
  });

  it("is in the shortcuts help, with words in every language", () => {
    for (const a of ["duplicate", "copy", "paste"] as const) expect(SHORTCUT_HELP.some((r) => r.action === a)).toBe(true);
    for (const d of [en, ru, uz]) {
      const cb = d.editor.clipTools.clipboard;
      for (const k of ["scDuplicate", "scCopy", "scPaste"] as const) expect(cb[k].length).toBeGreaterThan(0);
    }
  });
});

describe("words in en, ru and uz", () => {
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
  const flat = (o: object, pre = ""): [string, string][] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[`${pre}${k}`, v] as [string, string]] : flat(v, `${pre}${k}.`)));
  it("have the same keys, none empty, the same placeholders, and ru / uz are not English", () => {
    const e = flat(en.editor.clipTools);
    for (const d of [ru, uz]) {
      const o = new Map(flat(d.editor.clipTools));
      expect([...o.keys()].sort()).toEqual(e.map(([k]) => k).sort());
      for (const [k, v] of e) {
        expect(o.get(k)!.trim().length, k).toBeGreaterThan(0);
        expect(holes(o.get(k)!), k).toEqual(holes(v));
        if (v.length > 8) expect(o.get(k), k).not.toBe(v);
      }
    }
  });
});
