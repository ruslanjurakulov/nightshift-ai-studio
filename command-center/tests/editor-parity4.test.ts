/**
 * Editor parity 4, the talking-head pack (model half): clean voice, bleeps, a text's tracking / italic / alignment and
 * the one-word caption style. What would break without these: the editor and the worker disagreeing on a document
 * (samples/timeline_parity4_fuzz.json is modules/timeline.py's verdicts, judged here with lib/editor.ts), a number or a
 * list drifting from the Python one, a model edit leaving a document the validators refuse (a voice beside loudnorm, two
 * bleeps that overlap, a 0.01 s bleep, a tracking of 7.5), the save losing a field, or the preview's word times
 * differing from the export's.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALIGNS,
  BLEEP_MAX_S,
  BLEEP_MIN_S,
  BLEEP_MODES,
  MAX_BLEEPS,
  TRACKING_MAX,
  TRACKING_MIN,
  VOICES,
  VOICE_SECONDS_PER_S,
  detachClipAudio,
  ms,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  voiceSeconds,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";
import { renderWork } from "@/lib/editorMotion";
import { settleAll } from "@/lib/editorSettle";
import { setClipClean, setClipVoice, setSoundClean, setSoundVoice, voiceCheck } from "@/lib/editorClean";
import { bleepAt, cueWords, removeBleep, setBleepMode, toggleWordBleep } from "@/lib/editorBleeps";
import { setTextAlign, setTextItalic, setTextTracking } from "@/lib/editorTextProps";
import { CAPTION_STYLE_IDS, wordSpansMs } from "@/lib/captionStyleTable";
import { previewStyledCaption } from "@/lib/captionStylePreview";

const ROOT = join(__dirname, "..", "..");
const V = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";

function doc(extra: Partial<TimelineDoc> = {}, clip: Record<string, unknown> = {}): TimelineDoc {
  return {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: V, start_s: 0, in_s: 0, out_s: 20, speed: 1, audio: true, ...clip }] },
      { id: "a1", kind: "A", clips: [{ id: "s1", asset_id: S, start_s: 0, in_s: 0, out_s: 10, gain_db: 0, fade_in_s: 0, fade_out_s: 0 }] },
      { id: "t1", kind: "T", clips: [{ id: "x1", start_s: 0, end_s: 2, text: "two\nlines", size: 64, x: 0.5, y: 0.5, anchor: "center" }] },
    ],
    ...extra,
  };
}
const model = (extra: Partial<TimelineDoc> = {}, clip: Record<string, unknown> = {}): EditorModel => toModel(doc(extra, clip));

describe("both validators agree on the seeded fuzz of voices, bleeps and text properties", () => {
  const corpus = JSON.parse(readFileSync(join(ROOT, "samples", "timeline_parity4_fuzz.json"), "utf8")) as {
    cases: { valid: boolean; doc: unknown }[];
  };
  it("judges every document as modules/timeline.py did", () => {
    expect(corpus.cases.length).toBe(400);
    const wrong = corpus.cases
      .map((c, i) => ({ i, py: c.valid, ts: validateTimeline(c.doc).length === 0, why: validateTimeline(c.doc) }))
      .filter((x) => x.py !== x.ts);
    expect(wrong).toEqual([]);
  });
});

describe("the numbers are modules/timeline.py's", () => {
  const py = readFileSync(join(ROOT, "modules", "timeline.py"), "utf8");
  it("lists and limits", () => {
    const tuple = (xs: readonly string[]) => `(${xs.map((x) => `"${x}"`).join(", ")}${xs.length === 1 ? "," : ""})`;
    expect(py).toContain(`VOICES = ${tuple(VOICES)}`);
    expect(py).toContain(`VOICE_SECONDS_PER_S = ${VOICE_SECONDS_PER_S}`);
    expect(py).toContain(`BLEEP_MODES = ${tuple(BLEEP_MODES)}`);
    expect(py).toContain(`MAX_BLEEPS = ${MAX_BLEEPS}`);
    expect(py).toContain(`BLEEP_MIN_S = ${BLEEP_MIN_S}`);
    expect(py).toContain(`BLEEP_MAX_S = ${BLEEP_MAX_S.toFixed(1)}`);
    expect(py).toContain(`TRACKING_MIN = ${TRACKING_MIN}`);
    expect(py).toContain(`TRACKING_MAX = ${TRACKING_MAX}`);
    expect(py).toContain(`ALIGNS = ${tuple(ALIGNS)}`);
  });
  it("the caption styles end with the one-word style", () => {
    expect(CAPTION_STYLE_IDS.at(-1)).toBe("single_word");
    expect(CAPTION_STYLE_IDS).toHaveLength(11);
  });
});

describe("the document keeps every field through the editor", () => {
  it("round-trips voice, bleeps and text properties", () => {
    const d = doc({ bleeps: [{ start_s: 1, end_s: 1.5, mode: "tone" }] }, { voice: "clean" });
    (d.tracks[1].clips[0] as Record<string, unknown>).voice = "clean";
    Object.assign(d.tracks[2].clips[0], { tracking: 120, italic: true, align: "right" });
    expect(validateTimeline(d)).toEqual([]);
    const back = toDoc(toModel(d));
    expect(validateTimeline(back)).toEqual([]);
    expect(back.bleeps).toEqual([{ start_s: 1, end_s: 1.5, mode: "tone" }]);
    expect(back.tracks[0].clips[0].voice).toBe("clean");
    expect(back.tracks.find((t) => t.kind === "A")!.clips[0].voice).toBe("clean");
    const tx = back.tracks.find((t) => t.kind === "T")!.clips[0];
    expect([tx.tracking, tx.italic, tx.align]).toEqual([120, true, "right"]);
    expect("bleeps" in toDoc(model())).toBe(false);
  });
  it("a split keeps the preset on both halves", () => {
    const m = splitClip(model({}, { voice: "clean" }), "c1", 5)!.model;
    expect(m.clips.map((c) => c.voice)).toEqual(["clean", "clean"]);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
  it("detaching a clean-voiced clip's sound carries the preset to the new sound", () => {
    const m = model({}, { voice: "clean" });
    const r = detachClipAudio(m, "c1", "video");
    expect(r).not.toBeNull();
    const snd = r!.model.sounds.find((x) => x.id === r!.soundId)!;
    expect(snd.voice).toBe("clean");
    expect(r!.model.clips[0].voice).toBeUndefined();
    expect(validateTimeline(toDoc(r!.model))).toEqual([]);
  });
});

describe("clean voice", () => {
  it("replaces denoise and loudnorm, and they cannot come back beside it", () => {
    let m = setClipClean(setClipClean(model(), "c1", "denoise", true), "c1", "loudnorm", true);
    m = setClipVoice(m, "c1", true);
    expect(m.clips[0]).toMatchObject({ voice: "clean" });
    expect(m.clips[0].denoise).toBeUndefined();
    expect(m.clips[0].loudnorm).toBeUndefined();
    expect(setClipClean(m, "c1", "loudnorm", true)).toBe(m);
    expect(validateTimeline(toDoc(m))).toEqual([]);
    const off = setClipVoice(m, "c1", false);
    expect(off.clips[0].voice).toBeUndefined();
    let s = setSoundVoice(setSoundClean(model(), "s1", "loudnorm", true), "s1", true);
    expect(s.sounds[0]).toMatchObject({ voice: "clean" });
    expect(s.sounds[0].loudnorm).toBeUndefined();
    expect(setSoundClean(s, "s1", "denoise", true)).toBe(s);
    s = setSoundVoice(s, "s1", false);
    expect(s.sounds[0].voice).toBeUndefined();
  });
  it("both validators refuse a voice beside denoise or loudnorm", () => {
    for (const k of ["denoise", "loudnorm"])
      expect(validateTimeline(doc({}, { voice: "clean", [k]: true })).join(" ")).toContain('voice "clean" already');
    expect(validateTimeline(doc({}, { voice: "Clean" })).join(" ")).toContain("voice must be one of");
  });
  it("is charged to the render budget, and refused where it would not fit", () => {
    expect(voiceSeconds({ voice: "clean", audio: true, in_s: 0, out_s: 10, speed: 2 }, "V")).toBeCloseTo(0.5, 9);
    expect(voiceSeconds({ voice: "clean", in_s: 0, out_s: 10 }, "V")).toBe(0);
    expect(voiceSeconds({ voice: "clean", in_s: 1, out_s: 4 }, "A")).toBeCloseTo(0.3, 9);
    const m = setClipVoice(model(), "c1", true);
    expect(renderWork(m).voiceEst).toBeCloseTo(2, 9);
    // A 120 s timeline with 31 full-length sounds: 30 clean voices fit 480 s to the second, the 31st does not.
    const sounds = Array.from({ length: 31 }, (_v, i) => ({
      id: `s${i}`, asset_id: S, start_s: 0, in_s: 0, out_s: 120, gain_db: 0, fade_in_s: 0, fade_out_s: 0,
      ...(i < 30 ? { voice: "clean" as const } : {}),
    }));
    const big: EditorModel = { ...model(), clips: [{ ...model().clips[0], out_s: 120, audio: false }], texts: [], sounds };
    expect(voiceCheck(big, "A", "s29").ok).toBe(true);
    expect(validateTimeline(toDoc(big))).toEqual([]);
    const check = voiceCheck(big, "A", "s30");
    expect(check.ok).toBe(false);
    expect(Math.round(check.render.work)).toBe(492);
    expect(setSoundVoice(big, "s30", true)).toBe(big);
    const over = { ...big, sounds: sounds.map((x) => ({ ...x, voice: "clean" as const })) };
    expect(validateTimeline(toDoc(over)).join(" ")).toContain("cleaning voices would take about 492 s");
    // An edit that leaves it over (here: all 31 at once) is settled: the last clean voice comes off, with a notice.
    const settled = settleAll(over, big);
    expect(settled.changes).toEqual([{ kind: "voiceSound", sound: 31 }]);
    expect(validateTimeline(toDoc(settled.model))).toEqual([]);
    expect(settled.model.sounds.filter((x) => x.voice)).toHaveLength(30);
  });
});

describe("bleeps", () => {
  const cue = { id: "k1", start_s: 2, end_s: 4, text: "Go big now" };
  it("a word's time is the export's spread of its caption", () => {
    const ws = cueWords(cue);
    const spans = wordSpansMs(["Go", "big", "now"], 2000);
    expect(ws.map((w) => [w.text, w.start_s, w.end_s])).toEqual(
      spans.map(([a, b], i) => [["Go", "big", "now"][i], ms(2 + a / 1000), ms(2 + b / 1000)]),
    );
  });
  it("a press adds a bleep over the word, a second press takes it off", () => {
    const m = model();
    const [go, big] = cueWords(cue);
    const r = toggleWordBleep(m, go, "tone");
    expect(r.ok && r.change).toBe("added");
    if (!r.ok) return;
    expect(r.model.bleeps).toEqual([{ start_s: go.start_s, end_s: go.end_s, mode: "tone" }]);
    // the next word joins it: touching is apart
    const r2 = toggleWordBleep(r.model, big, "mute");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.model.bleeps!.map((b) => b.mode)).toEqual(["tone", "mute"]);
    expect(validateTimeline(toDoc(r2.model))).toEqual([]);
    const off = toggleWordBleep(r2.model, go, "tone");
    expect(off.ok && off.change).toBe("removed");
    if (off.ok) expect(off.model.bleeps).toEqual([{ start_s: big.start_s, end_s: big.end_s, mode: "mute" }]);
    const none = removeBleep(r.model, 0);
    expect(none.bleeps).toBeUndefined();
    expect("bleeps" in toDoc(none)).toBe(false);
  });
  it("a short word grows to the shortest bleep, a long one is cut to the longest, and neighbours are never crossed", () => {
    const m = model();
    const tiny = toggleWordBleep(m, { start_s: 3, end_s: 3.01 }, "mute");
    expect(tiny.ok && tiny.model.bleeps).toEqual([{ start_s: 3, end_s: 3.05, mode: "mute" }]);
    const long = toggleWordBleep(m, { start_s: 3, end_s: 15 }, "mute");
    expect(long.ok && long.model.bleeps).toEqual([{ start_s: 3, end_s: 13, mode: "mute" }]);
    if (!tiny.ok) return;
    // a word just before an existing bleep, too close to fit 0.05 s in front of it: grows backwards instead
    const before = toggleWordBleep({ ...tiny.model }, { start_s: 2.98, end_s: 2.99 }, "tone");
    expect(before.ok && before.model.bleeps![0]).toEqual({ start_s: 2.95, end_s: 3, mode: "tone" });
    // squeezed between two with 0.03 s free: refused
    const tight: EditorModel = { ...m, bleeps: [{ start_s: 1, end_s: 2, mode: "mute" }, { start_s: 2.03, end_s: 3, mode: "mute" }] };
    expect(toggleWordBleep(tight, { start_s: 2.005, end_s: 2.02 }, "tone")).toEqual({ ok: false, reason: "no_room" });
  });
  it("stops at the document's hundred", () => {
    const full: EditorModel = {
      ...model(),
      bleeps: Array.from({ length: MAX_BLEEPS }, (_v, i) => ({ start_s: i * 0.1, end_s: i * 0.1 + 0.05, mode: "mute" as const })),
    };
    expect(validateTimeline(toDoc(full))).toEqual([]);
    expect(toggleWordBleep(full, { start_s: 15, end_s: 15.5 }, "tone")).toEqual({ ok: false, reason: "full" });
  });
  it("a mode change and the preview's test", () => {
    const m: EditorModel = { ...model(), bleeps: [{ start_s: 1, end_s: 1.5, mode: "mute" }] };
    expect(setBleepMode(m, 0, "mute")).toBe(m);
    expect(setBleepMode(m, 0, "tone").bleeps![0].mode).toBe("tone");
    expect([bleepAt(m.bleeps, 0.99), bleepAt(m.bleeps, 1), bleepAt(m.bleeps, 1.49), bleepAt(m.bleeps, 1.5)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
  it("both validators keep them in order and apart, closed and bounded", () => {
    const v = (bleeps: unknown) => validateTimeline(doc({ bleeps: bleeps as unknown[] })).join(" ");
    expect(v([{ start_s: 1, end_s: 2, mode: "mute" }, { start_s: 1.5, end_s: 3, mode: "mute" }])).toContain("before the bleep");
    expect(v([{ start_s: 1, end_s: 1.04, mode: "mute" }])).toContain("a bleep lasts");
    expect(v([{ start_s: 1, end_s: 2, mode: "beep" }])).toContain("mode must be one of");
    expect(v([{ start_s: 1, end_s: 2, mode: "mute", x: 1 }])).toContain("x is not a known field");
    expect(v("x")).toContain("bleeps must be a list");
  });
});

describe("text properties", () => {
  it("whole numbers held to the range, off is no field, every result validates", () => {
    let m = setTextTracking(model(), "x1", 777);
    expect(m.texts[0].tracking).toBe(TRACKING_MAX);
    m = setTextTracking(m, "x1", -12.4);
    expect(m.texts[0].tracking).toBe(-12);
    m = setTextItalic(setTextAlign(m, "x1", "left"), "x1", true);
    expect(validateTimeline(toDoc(m))).toEqual([]);
    expect(setTextAlign(m, "x1", "left")).toBe(m);
    m = setTextItalic(setTextAlign(setTextTracking(m, "x1", 0), "x1", null), "x1", false);
    expect(["tracking", "italic", "align"].filter((k) => k in m.texts[0])).toEqual([]);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
  it("both validators refuse what is off the lists", () => {
    const v = (props: Record<string, unknown>) => {
      const d = doc();
      Object.assign(d.tracks[2].clips[0], props);
      return validateTimeline(d).join(" ");
    };
    expect(v({ tracking: 7.5 })).toContain("tracking must be an integer");
    expect(v({ tracking: 50.0 })).toBe("");
    expect(v({ italic: "yes" })).toContain("italic must be true or false");
    expect(v({ align: "justify" })).toContain("align must be one of");
  });
});

describe("the one-word caption preview", () => {
  const input = (t: number) => ({
    style: { preset: "single_word", color: "#FFFFFF", outline_color: "#000000", outline_width: 6, size: 72, y: 0.62, font: "DejaVu Sans" as const, bold: true },
    text: "Go big now",
    startS: 1,
    endS: 3,
    t,
    frameWidth: 1280,
  });
  it("shows the word whose share of the cue the playhead is in, and only it", () => {
    const words = (t: number) => previewStyledCaption(input(t))!.lines.flat().map((s) => s.text);
    expect(words(1.0)).toEqual(["Go"]);
    expect(words(1.6)).toEqual(["big"]);
    expect(words(2.99)).toEqual(["now"]);
  });
  it("past the word budget it shows the cue whole, as the export writes it", () => {
    const p = previewStyledCaption({ ...input(1.5), perWord: false })!;
    expect(p.lines.flat().map((s) => s.text)).toEqual(["Go big now"]);
  });
});
