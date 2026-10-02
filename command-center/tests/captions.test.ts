/**
 * Auto-captions (migration 0072), the pure half: a transcript's words become
 * cues for a language and a look, are laid on the timeline through the clips'
 * own trims and speeds, become a document the renderer accepts, and download
 * as SRT / WebVTT. Nothing here prices, holds or spends — and the code's
 * rules are pinned to the database's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { dictionaries } from "@/lib/i18n";
import { PROVIDER_BRANDS } from "./helpers/brands";
import {
  CAPTION_LANGUAGES,
  CAPTION_PRESETS,
  CAPTIONS_MAX_SECONDS,
  MAX_CUE_S,
  MIN_CUE_S,
  PAUSE_S,
  buildSrt,
  buildVtt,
  captionFileName,
  captionIdPrefix,
  captionParams,
  captionsFromTrack,
  captionsOf,
  coerceCaptionJobs,
  coerceTrack,
  coerceTrackSummary,
  coerceWords,
  cueWarnings,
  cuesAt,
  defaultCaptionLanguage,
  lineLimit,
  playedClips,
  presetMatching,
  recordingProblem,
  removeCue,
  segmentWords,
  setCaptionStyle,
  setCaptions,
  srtTime,
  styleFor,
  updateCue,
  vttTime,
  withinPicture,
  wordsOnTimeline,
  wrapLines,
  type CaptionWord,
  type Cue,
} from "@/lib/captions";
import { coerceJobs, failureReason } from "@/lib/creative/studio";
import {
  CAPTION_LANGUAGES as OPS_LANGUAGES,
  CREATIVE_CAPABILITIES,
  PARAM_KEYS,
  parseGenerationInput,
} from "@/lib/creative/operations";
import { CAPABILITIES } from "@/lib/creative/registry";
import { toDoc, toModel, validateTimeline, type EditorModel, type TimelineDoc } from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "33333333-3333-4333-8333-333333333333";
const TRACK = "44444444-4444-4444-8444-444444444444";

/** Words from text, spoken at `rate` words a second from `start`, with `gap` after each. */
function say(text: string, start = 0, rate = 2.5, gap = 0.05): CaptionWord[] {
  const out: CaptionWord[] = [];
  let t = start;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const len = 1 / rate;
    out.push({ t: w, s: Math.round(t * 1000) / 1000, e: Math.round((t + len) * 1000) / 1000 });
    t += len + gap;
  }
  return out;
}

const SPEECH_EN =
  "Welcome back to the channel. Today we are going to look at how a small team ships a video every single day, " +
  "without burning out, and what they changed first. Let's start with the simplest part: the script.";
const SPEECH_RU =
  "Добро пожаловать обратно на канал. Сегодня мы разберём, как небольшая команда выпускает видео каждый день, " +
  "не выгорая, и что они изменили в первую очередь. Начнём с самого простого: со сценария.";
const SPEECH_UZ =
  "Kanalimizga qaytganingiz bilan tabriklaymiz. Bugun kichik jamoa har kuni qanday qilib video chiqarishini, " +
  "charchamasdan, va avval nimani o'zgartirganini ko'rib chiqamiz. Eng oddiy qismdan boshlaymiz: ssenariydan.";

const opts = (o: Partial<Parameters<typeof segmentWords>[1]> = {}) => ({
  language: "en",
  width: 1920,
  height: 1080,
  preset: "classic" as const,
  ...o,
});

function model(over: Partial<EditorModel> = {}): EditorModel {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 60, speed: 1, audio: true }],
    texts: [],
    sounds: [],
    keep: [],
    ...over,
  };
}

// ── cues from words ──────────────────────────────────────────────────────────

describe("segmenting words into cues", () => {
  for (const [lang, speech] of [["en", SPEECH_EN], ["ru", SPEECH_RU], ["uz", SPEECH_UZ]] as const) {
    for (const preset of CAPTION_PRESETS) {
      for (const [w, h] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
        it(`${lang} / ${preset.id} / ${w}x${h}: cues never overlap, fit their lines, and keep every word`, () => {
          const words = say(speech, 1.0);
          const cues = segmentWords(words, opts({ language: lang, preset: preset.id, width: w, height: h }));
          const limit = lineLimit(lang, w, h, preset.id);
          expect(cues.length).toBeGreaterThan(1);
          for (let i = 0; i < cues.length; i++) {
            const c = cues[i];
            expect(c.end_s).toBeGreaterThan(c.start_s);
            if (i + 1 < cues.length) expect(c.end_s).toBeLessThanOrEqual(cues[i + 1].start_s);
            const lines = c.text.split("\n");
            expect(lines.length).toBeLessThanOrEqual(preset.segmentation.maxLines);
            for (const line of lines) {
              // A single word longer than the line stays whole; nothing else may run over.
              if (line.includes(" ")) expect(line.length).toBeLessThanOrEqual(limit);
            }
            expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(preset.segmentation.maxWords);
            expect(c.end_s - c.start_s).toBeLessThanOrEqual(MAX_CUE_S + 1.6);
          }
          // Every word is on screen exactly once, in order.
          expect(cues.map((c) => c.text.replace(/\s+/g, " ")).join(" ")).toBe(words.map((x) => x.t).join(" "));
        });
      }
    }
  }

  it("is deterministic: the same words and options give the same cues", () => {
    const words = say(SPEECH_UZ, 0.5);
    expect(segmentWords(words, opts({ language: "uz" }))).toEqual(segmentWords(words, opts({ language: "uz" })));
  });

  it("starts a new caption at a sentence end and at a pause", () => {
    const words = [...say("One short sentence.", 0), ...say("Then another one", 1.5)];
    const cues = segmentWords(words, opts());
    expect(cues.map((c) => c.text)).toEqual(["One short sentence.", "Then another one"]);
    const paused = [...say("Same breath", 0), ...say("after a long pause", 0.8 + PAUSE_S + 0.1)];
    expect(segmentWords(paused, opts()).length).toBe(2);
  });

  it("ends a clause early only once the caption is more than half full", () => {
    const early = segmentWords(say("Yes, and then we kept going for a good while", 0), opts());
    expect(early[0].text.startsWith("Yes, and then")).toBe(true);
    const late = segmentWords(say("Well, okay", 0), opts());
    expect(late.length).toBe(1);
  });

  it("the pop look shows a few words at a time, in one line", () => {
    const cues = segmentWords(say(SPEECH_EN, 0), opts({ preset: "pop" }));
    for (const c of cues) {
      expect(c.text.includes("\n")).toBe(false);
      expect(c.text.split(" ").length).toBeLessThanOrEqual(3);
    }
  });

  it("a portrait frame wraps shorter lines than a landscape one, and Cyrillic shorter than Latin", () => {
    expect(lineLimit("en", 1080, 1920, "classic")).toBeLessThan(lineLimit("en", 1920, 1080, "classic"));
    expect(lineLimit("ru", 1920, 1080, "classic")).toBeLessThan(lineLimit("en", 1920, 1080, "classic"));
    expect(lineLimit("uz", 1920, 1080, "classic")).toBeLessThan(lineLimit("en", 1920, 1080, "classic"));
    // A bigger look fits fewer letters per line.
    expect(lineLimit("en", 1920, 1080, "pop")).toBeLessThan(lineLimit("en", 1920, 1080, "clean"));
  });

  it("a very short caption stays on screen long enough, but never into the next one", () => {
    const words = [{ t: "Hi.", s: 1, e: 1.1 }, { t: "Hello", s: 1.2, e: 1.3 }];
    const [a, b] = segmentWords(words, opts());
    expect(a.end_s - a.start_s).toBeGreaterThanOrEqual(0.19);
    expect(a.end_s).toBeLessThanOrEqual(b.start_s);
    const lone = segmentWords([{ t: "Hi.", s: 1, e: 1.1 }], opts());
    expect(lone[0].end_s - lone[0].start_s).toBeCloseTo(MIN_CUE_S, 3);
  });

  it("a caption read too fast is held longer when there is room", () => {
    const words = say("Extraordinarily complicated sentence structure indeed.", 0, 8, 0);
    const [c] = segmentWords(words, opts());
    const chars = c.text.replace(/\n/g, " ").length;
    expect((c.end_s - c.start_s) * 17).toBeGreaterThanOrEqual(Math.min(chars, (words[words.length - 1].e + 1.5 - 0) * 17) - 1);
  });

  it("random speech always makes valid, non-overlapping cues", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run = 0; run < 40; run++) {
      const words: CaptionWord[] = [];
      let t = rnd() * 3;
      const n = 20 + Math.floor(rnd() * 200);
      for (let i = 0; i < n; i++) {
        const len = 0.1 + rnd() * 0.7;
        const text = "w".repeat(1 + Math.floor(rnd() * 14)) + (rnd() < 0.12 ? "." : rnd() < 0.1 ? "," : "");
        words.push({ t: text, s: Math.round(t * 1000) / 1000, e: Math.round((t + len) * 1000) / 1000 });
        t += len + (rnd() < 0.1 ? 1.2 : rnd() * 0.15);
      }
      for (const preset of CAPTION_PRESETS) {
        const cues = segmentWords(words, opts({ preset: preset.id, language: ["en", "ru", "uz"][run % 3] }));
        for (let i = 0; i < cues.length; i++) {
          expect(cues[i].end_s).toBeGreaterThan(cues[i].start_s);
          expect(cues[i].text.length).toBeGreaterThan(0);
          if (i + 1 < cues.length) expect(cues[i].end_s).toBeLessThanOrEqual(cues[i + 1].start_s);
        }
        const ids = new Set(cues.map((c) => c.id));
        expect(ids.size).toBe(cues.length);
      }
    }
  });

  it("wraps words into lines without breaking a word", () => {
    expect(wrapLines(["aaa", "bbb", "ccc"], 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines(["abcdefghij"], 4)).toEqual(["abcdefghij"]);
    expect(wrapLines([], 4)).toEqual([]);
  });
});

// ── the timeline ─────────────────────────────────────────────────────────────

describe("words on the timeline", () => {
  const words = [{ t: "a", s: 1, e: 2 }, { t: "b", s: 2, e: 3 }, { t: "c", s: 5, e: 6 }];

  it("moves the words inside a clip's trim to where the clip starts", () => {
    const out = wordsOnTimeline(words, [{ asset_id: A, start_s: 10, in_s: 1, out_s: 3.5, speed: 1 }]);
    expect(out).toEqual([{ t: "a", s: 10, e: 11 }, { t: "b", s: 11, e: 12 }]);
  });

  it("scales by the clip's speed", () => {
    const out = wordsOnTimeline(words, [{ asset_id: A, start_s: 0, in_s: 0, out_s: 10, speed: 2 }]);
    expect(out[0]).toEqual({ t: "a", s: 0.5, e: 1 });
    expect(out[2]).toEqual({ t: "c", s: 2.5, e: 3 });
  });

  it("keeps a word cut only by a sliver out, and one cut in half in", () => {
    const sliver = wordsOnTimeline([{ t: "x", s: 1, e: 2 }], [{ asset_id: A, start_s: 0, in_s: 1.95, out_s: 9, speed: 1 }]);
    expect(sliver).toEqual([]);
    const half = wordsOnTimeline([{ t: "x", s: 1, e: 2 }], [{ asset_id: A, start_s: 0, in_s: 1.4, out_s: 9, speed: 1 }]);
    expect(half.length).toBe(1);
  });

  it("two clips of the same recording each show their own part, in order and never overlapping", () => {
    const out = wordsOnTimeline(words, [
      { asset_id: A, start_s: 20, in_s: 5, out_s: 7, speed: 1 },
      { asset_id: A, start_s: 0, in_s: 1, out_s: 3, speed: 1 },
    ]);
    expect(out.map((w) => w.t)).toEqual(["a", "b", "c"]);
    for (let i = 1; i < out.length; i++) expect(out[i].s).toBeGreaterThanOrEqual(out[i - 1].e);
  });

  it("only clips that are heard play a recording: a muted video clip does not", () => {
    const m = model({
      clips: [
        { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 5, speed: 1, audio: false },
        { id: "c2", asset_id: B, start_s: 5, in_s: 0, out_s: 5, speed: 1, audio: true },
      ],
      sounds: [{ id: "m1", asset_id: A, start_s: 0, in_s: 0, out_s: 5, gain_db: 0, fade_in_s: 0, fade_out_s: 0 }],
    });
    expect(playedClips(m, A).map((c) => c.start_s)).toEqual([0]);
    expect(playedClips(m, A.toUpperCase()).length).toBe(1);
    expect(playedClips(m, B).length).toBe(1);
    expect(playedClips(model({ clips: [{ ...model().clips[0], audio: false }] }), A)).toEqual([]);
  });

  it("a recording none of whose sound is heard gives no captions", () => {
    const m = model({ clips: [{ ...model().clips[0], audio: false }] });
    expect(captionsFromTrack(m, { words, language: "en" }, A, "classic", 60)).toBeNull();
  });
});

// ── the document ─────────────────────────────────────────────────────────────

describe("captions in the document", () => {
  const track = { words: say(SPEECH_EN, 1), language: "en" };

  it("a made set of captions is a valid timeline the renderer takes, in every language and look", () => {
    for (const [lang, speech] of [["en", SPEECH_EN], ["ru", SPEECH_RU], ["uz", SPEECH_UZ]] as const) {
      for (const preset of CAPTION_PRESETS) {
        const m = model();
        const caps = captionsFromTrack(m, { words: say(speech, 0.4), language: lang }, A, preset.id, 60);
        expect(caps).not.toBeNull();
        const doc = toDoc(setCaptions(m, caps));
        expect(validateTimeline(doc), `${lang}/${preset.id}`).toEqual([]);
        // The document survives a round trip through the editor's own model.
        expect(captionsOf(toModel(doc))?.cues.length).toBe(caps!.cues.length);
      }
    }
  });

  it("the look is exactly a preset for this frame, and is told apart from a hand-made one", () => {
    for (const p of CAPTION_PRESETS) {
      expect(presetMatching(styleFor(p.id, 1080, 1920), 1080, 1920)).toBe(p.id);
    }
    expect(presetMatching({ ...styleFor("classic", 1080, 1920), size: 77 }, 1080, 1920)).toBeNull();
    expect(presetMatching(undefined, 1080, 1920)).toBeNull();
    // The same look is a different size in a different frame.
    expect(styleFor("classic", 1920, 1080).size).toBe(styleFor("classic", 1080, 1920).size);
    expect(styleFor("classic", 3840, 2160).size).toBeGreaterThan(styleFor("classic", 1920, 1080).size);
  });

  it("every look is something the renderer draws: its closed fonts, #RRGGBB colours, sizes in range", () => {
    for (const p of CAPTION_PRESETS) {
      const s = styleFor(p.id, 1080, 1920);
      expect(["DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif"]).toContain(s.font);
      expect(s.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(s.outline_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(s.size).toBeGreaterThanOrEqual(8);
      expect(s.size).toBeLessThanOrEqual(512);
      expect(s.outline_width).toBeLessThanOrEqual(20);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
      expect(Object.keys(s).sort()).toEqual(["bold", "color", "font", "outline_color", "outline_width", "size", "y"]);
    }
  });

  it("cues never run past the picture (a caption after it would lengthen the video with black)", () => {
    const cues: Cue[] = [
      { id: "a", start_s: 1, end_s: 2, text: "in" },
      { id: "b", start_s: 9, end_s: 12, text: "cut" },
      { id: "c", start_s: 12, end_s: 14, text: "gone" },
    ];
    expect(withinPicture(cues, 10)).toEqual([cues[0], { id: "b", start_s: 9, end_s: 10, text: "cut" }]);
    const made = captionsFromTrack(model(), track, A, "classic", 8);
    expect(Math.max(...made!.cues.map((c) => c.end_s))).toBeLessThanOrEqual(8);
  });

  it("cue ids never collide with a clip, a text, a sound or a track", () => {
    const busy = model({
      clips: [{ id: "cap1", asset_id: A, start_s: 0, in_s: 0, out_s: 5, speed: 1, audio: true }],
      keep: [{ id: "cue9", kind: "T", clips: [] }],
    });
    const prefix = captionIdPrefix(busy);
    expect(["cap", "cue"]).not.toContain(prefix);
    const made = captionsFromTrack(busy, track, A, "classic", 60)!;
    expect(made.cues.every((c) => c.id.startsWith(prefix))).toBe(true);
    expect(validateTimeline(toDoc(setCaptions(busy, made)))).toEqual([]);
  });

  it("editing a cue: words, and times kept inside the neighbours", () => {
    const made = captionsFromTrack(model(), track, A, "classic", 60)!;
    const m0 = setCaptions(model(), made);
    const [c0, c1] = made.cues;
    const m1 = updateCue(m0, c0.id, { text: "Edited" });
    expect(captionsOf(m1)!.cues[0].text).toBe("Edited");
    // Cannot be moved into the next cue.
    const m2 = updateCue(m0, c0.id, { end_s: c1.start_s + 5 });
    expect(captionsOf(m2)!.cues[0].end_s).toBeLessThanOrEqual(c1.start_s);
    // Cannot start before the cue before it ended, and keeps a visible length.
    const m3 = updateCue(m0, c1.id, { start_s: 0 });
    expect(captionsOf(m3)!.cues[1].start_s).toBeGreaterThanOrEqual(c0.end_s);
    const m4 = updateCue(m0, c0.id, { start_s: c0.end_s });
    expect(captionsOf(m4)!.cues[0].end_s - captionsOf(m4)!.cues[0].start_s).toBeGreaterThanOrEqual(0.099);
    expect(updateCue(m0, "nope", { text: "x" })).toBe(m0);
    expect(validateTimeline(toDoc(m3))).toEqual([]);
  });

  it("text is cut at the document's 500 characters, and an empty cue is a warning, never silently dropped", () => {
    const made = captionsFromTrack(model(), track, A, "classic", 60)!;
    const m0 = setCaptions(model(), made);
    expect(captionsOf(updateCue(m0, made.cues[0].id, { text: "x".repeat(900) }))!.cues[0].text.length).toBe(500);
    const emptied = updateCue(m0, made.cues[0].id, { text: "  " });
    expect(cueWarnings(captionsOf(emptied)!.cues)).toEqual({ [made.cues[0].id]: "empty" });
  });

  it("removing every cue removes the captions from the document (nothing empty is saved)", () => {
    const made = captionsFromTrack(model(), track, A, "classic", 60)!;
    let m = setCaptions(model(), made);
    for (const c of made.cues) m = removeCue(m, c.id);
    expect(m.captions).toBeUndefined();
    expect(setCaptions(model(), null)).toEqual(model());
  });

  it("restyling keeps the person's words and times", () => {
    const made = captionsFromTrack(model(), track, A, "classic", 60)!;
    const edited = updateCue(setCaptions(model(), made), made.cues[0].id, { text: "Mine" });
    const restyled = setCaptionStyle(edited, styleFor("bold", 1080, 1920));
    expect(captionsOf(restyled)!.cues).toEqual(captionsOf(edited)!.cues);
    expect(captionsOf(restyled)!.style.color).toBe("#FFE600");
    expect(setCaptionStyle(model(), styleFor("bold", 1080, 1920))).toEqual(model());
  });

  it("finds the cues on screen at a time", () => {
    const made = captionsFromTrack(model(), track, A, "classic", 60)!;
    const m = setCaptions(model(), made);
    expect(cuesAt(m, 0)).toEqual([]);
    expect(cuesAt(m, made.cues[0].start_s + 0.01)).toEqual([made.cues[0]]);
    expect(cuesAt(model(), 1)).toEqual([]);
  });

  it("a malformed document gives no captions, never a crash", () => {
    expect(captionsOf({ captions: "x" })).toBeNull();
    expect(captionsOf({ captions: { cues: "x" } })).toBeNull();
    expect(captionsOf({ captions: { cues: [{ id: 1 }, null, { id: "a", text: "t", start_s: 2, end_s: 1 }] } })!.cues).toEqual([]);
    expect(captionsOf({})).toBeNull();
  });
});

// ── SRT and WebVTT ───────────────────────────────────────────────────────────

describe("subtitle files", () => {
  const cues: Cue[] = [
    { id: "a", start_s: 0.5, end_s: 2.25, text: "Hello there,\nfriend." },
    { id: "b", start_s: 3661.007, end_s: 3662, text: "Salom <dunyo> & \"do'stlar\"" },
  ];

  it("writes SubRip exactly: numbers, comma times, a blank line between cues", () => {
    expect(buildSrt(cues)).toBe(
      "1\n00:00:00,500 --> 00:00:02,250\nHello there,\nfriend.\n\n" +
        "2\n01:01:01,007 --> 01:01:02,000\nSalom <dunyo> & \"do'stlar\"\n",
    );
  });

  it("writes WebVTT exactly: the header, dot times, and the text escaped", () => {
    expect(buildVtt(cues)).toBe(
      "WEBVTT\n\n" +
        "1\n00:00:00.500 --> 00:00:02.250\nHello there,\nfriend.\n\n" +
        "2\n01:01:01.007 --> 01:01:02.000\nSalom &lt;dunyo&gt; &amp; \"do'stlar\"\n",
    );
  });

  it("times are zero-padded and rounded to the millisecond", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(59.9996)).toBe("00:01:00,000");
    expect(vttTime(7200.5)).toBe("02:00:00.500");
    expect(srtTime(-3)).toBe("00:00:00,000");
  });

  it("a blank line inside a cue would end it: it is removed, and so are control characters", () => {
    const out = buildSrt([{ id: "a", start_s: 0, end_s: 1, text: "one\n\n\ntwo\u0007‮ three\r\nfour" }]);
    expect(out).toBe("1\n00:00:00,000 --> 00:00:01,000\none\ntwo three\nfour\n");
    expect(out).not.toContain("\n\n\n");
  });

  it("WebVTT text can never contain the arrow that ends a cue's timing", () => {
    const out = buildVtt([{ id: "a", start_s: 0, end_s: 1, text: "a --> b" }]);
    const text = out.split("\n").slice(4).join("\n");
    expect(text).not.toContain("-->");
  });

  it("cues are written in time order, and empty or backwards ones are left out", () => {
    const out = buildSrt([
      { id: "b", start_s: 5, end_s: 6, text: "second" },
      { id: "a", start_s: 1, end_s: 2, text: "first" },
      { id: "x", start_s: 7, end_s: 7, text: "zero" },
      { id: "y", start_s: 8, end_s: 9, text: "   " },
    ]);
    expect(out).toBe("1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n00:00:05,000 --> 00:00:06,000\nsecond\n");
    expect(buildSrt([])).toBe("");
    expect(buildVtt([])).toBe("WEBVTT\n\n");
  });

  it("every language's captions survive the file: Cyrillic and Uzbek letters are written as they are", () => {
    const out = buildSrt([{ id: "a", start_s: 0, end_s: 1, text: "Привет, мир!\nO'zbekcha: oʻgʻil, gʻoya" }]);
    expect(out).toContain("Привет, мир!");
    expect(out).toContain("oʻgʻil, gʻoya");
  });

  it("file names are safe: letters and digits, the language, the extension", () => {
    expect(captionFileName("My Edit: Part 1/2?", "uz", "srt")).toBe("My-Edit-Part-1-2.uz.srt");
    expect(captionFileName("Мой монтаж", "ru", "vtt")).toBe("Мой-монтаж.ru.vtt");
    expect(captionFileName("../../etc/passwd", "en", "srt")).toBe("etc-passwd.en.srt");
    expect(captionFileName("   ", "xx!", "vtt")).toBe("captions.und.vtt");
  });
});

// ── what the database kept ───────────────────────────────────────────────────

describe("a transcript read back", () => {
  it("words are defended again: backwards, malformed and control-laden ones are dropped", () => {
    const out = coerceWords([
      { t: "ok", s: 0, e: 1 },
      { t: "back", s: 0.2, e: 0.4 },
      { t: "", s: 2, e: 3 },
      { t: "a‮b\u0000", s: 2, e: 3 },
      { t: "bad", s: 5, e: 4 },
      { t: 5, s: 6, e: 7 },
      "x",
      null,
    ]);
    expect(out).toEqual([{ t: "ok", s: 0, e: 1 }, { t: "ab", s: 2, e: 3 }]);
    expect(coerceWords("x")).toEqual([]);
  });

  it("a track needs an id, a language tag, a length and words", () => {
    const row = { id: TRACK, language: "uz", duration_s: "95.000", word_count: 2, created_at: "2026-10-01T10:00:00Z", asset_id: A, words: [{ t: "a", s: 0, e: 1 }] };
    expect(coerceTrack(row)).toMatchObject({ id: TRACK, language: "uz", durationS: 95, wordCount: 2, assetId: A });
    expect(coerceTrackSummary(row)?.id).toBe(TRACK);
    for (const bad of [{ ...row, id: "x" }, { ...row, language: "UZ" }, { ...row, language: "uzbek" }, { ...row, duration_s: 0 }, { ...row, word_count: 0 }, { ...row, words: [] }, null, "x"]) {
      expect(coerceTrack(bad)).toBeNull();
    }
    expect(coerceTrack({ ...row, asset_id: "nope" })?.assetId).toBeNull();
  });

  it("captions jobs are read from raw job rows, and the Studio's feed never shows them", () => {
    const rows = [
      { id: JOB, capability: "captions", status: "completed", params: { source_asset_id: A }, result: { track_id: TRACK }, quoted_credits: "3.2", charged_credits: 3, created_at: "2026-10-01T10:00:00Z" },
      { id: "55555555-5555-4555-8555-555555555555", capability: "t2i", status: "completed", params: {}, result: null },
      { id: "x", capability: "captions", status: "queued", params: {} },
    ];
    expect(coerceCaptionJobs(rows)).toEqual([
      { id: JOB, status: "completed", sourceAssetId: A, quoted: 3.2, charged: 3, errorCode: null, trackId: TRACK, createdAt: "2026-10-01T10:00:00Z" },
    ]);
    expect(coerceJobs(rows).map((j) => j.capability)).toEqual(["t2i"]);
    expect(coerceCaptionJobs("x")).toEqual([]);
  });
});

// ── the request ──────────────────────────────────────────────────────────────

describe("the request", () => {
  const parse = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseGenerationInput({ org_id: ORG, capability: "captions", model: "scribe", params, max_credits: 3, ...extra }, null, { requirePrice: true });
  const bad = (r: ReturnType<typeof parse>) => (r.ok ? "ok" : (r.result.body.error as string));

  it("a recording, and a language only when one was named", () => {
    expect(captionParams(A, null)).toEqual({ source_asset_id: A });
    expect(captionParams(A, "uz")).toEqual({ source_asset_id: A, language: "uz" });
    expect(parse(captionParams(A, "ru")).ok).toBe(true);
    expect(parse(captionParams(A, null)).ok).toBe(true);
  });

  // The shape checks here; prompt, voice_id and the rest of 0072's refusals are the database's (tests/security/test_sec_captions.py).
  it("refuses what 0072 refuses", () => {
    for (const params of [
      {},
      { source_asset_id: "https://evil.example/a.mp3" },
      { source_asset_id: A, language: "de" },
      { source_asset_id: A, language: "EN" },
      { source_asset_id: A, duration_s: 5 },
      { source_asset_id: A, target_language: "ru" },
      { source_asset_id: A, factor: 2 },
    ]) {
      expect(bad(parse(params)), JSON.stringify(params)).not.toBe("ok");
    }
    // A language belongs to describe and captions only.
    expect(bad(parseGenerationInput({ org_id: ORG, capability: "t2i", model: "m", params: { prompt: "x", language: "en" }, max_credits: 1 }, null, { requirePrice: true }))).toBe("invalid_params");
    // The price is the person's to confirm.
    expect(bad(parseGenerationInput({ org_id: ORG, capability: "captions", model: "scribe", params: { source_asset_id: A } }, null, { requirePrice: true }))).toBe("confirm_price");
  });

  it("the language allow-list is one list in the code and the database", () => {
    expect([...OPS_LANGUAGES]).toEqual([...CAPTION_LANGUAGES]);
    expect(defaultCaptionLanguage("uz")).toBe("uz");
    expect(defaultCaptionLanguage("de")).toBe("en");
    expect(CAPTIONS_MAX_SECONDS).toBe(1800);
  });

  it("a recording is checked before it is priced: kind, known length, at most 30 minutes", () => {
    expect(recordingProblem({ kind: "audio", durationS: 61 })).toBeNull();
    expect(recordingProblem({ kind: "video", durationS: 1800 })).toBeNull();
    expect(recordingProblem({ kind: "video", durationS: 1801 })).toBe("too_long");
    expect(recordingProblem({ kind: "video", durationS: null })).toBe("unknown");
    expect(recordingProblem({ kind: "video", durationS: 0 })).toBe("unknown");
    expect(recordingProblem({ kind: "image", durationS: 5 })).toBe("not_recording");
    expect(recordingProblem(undefined)).toBe("unknown");
  });
});

// ── pinned to the database ───────────────────────────────────────────────────

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0072_captions.sql"), "utf8");
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0072`);
  return m[1] + m[2];
}

describe("pinned to 0072", () => {
  it("every capability and param key the code sends is one 0072 accepts", () => {
    const supported = fn("creative_capability_supported");
    for (const c of CREATIVE_CAPABILITIES) expect(supported, c).toContain(`'${c}'`);
    const params = fn("creative_params_problem");
    for (const k of PARAM_KEYS) expect(params, k).toContain(`'${k}'`);
    expect(CAPABILITIES as readonly string[]).toContain("captions");
  });

  it("the language allow-list is the same in the code and the database", () => {
    expect(fn("creative_params_problem")).toContain(`not in (${CAPTION_LANGUAGES.map((l) => `'${l}'`).join(", ")})`);
  });

  it("the longest recording and the price are the database's: 30 minutes, and the file's own seconds", () => {
    expect(fn("creative_source_problem")).toContain(`a.duration_s > ${CAPTIONS_MAX_SECONDS}`);
    expect(fn("creative_price")).toMatch(/if cap in \('voice_change', 'dub', 'video_upscale', 'captions'\) then\s+[\s\S]*?qty := public\.creative_source_seconds\(p_org, p_params\)/);
  });

  it("the words the table keeps match what the browser reads: 1..80 characters, forward times, at most 20000", () => {
    const store = fn("store_caption_track");
    expect(store).toContain("char_length(x.t) not between 1 and 80");
    expect(store).toContain("n > 20000");
    expect(SQL).toContain("check (word_count between 1 and 20000)");
  });

  it("a track is never a library asset and never readable before its job has completed", () => {
    expect(SQL).toContain("cardinality(result_asset_ids) = 0");
    expect(SQL).toContain("and j.status = 'completed'");
    expect(SQL).toContain("accessible_org_ids('viewer')");
  });
});

// ── customer copy ────────────────────────────────────────────────────────────

describe("the copy", () => {
  const keys = (o: unknown, prefix = ""): string[] =>
    typeof o === "object" && o !== null
      ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix.slice(0, -1)];

  it("is complete in English, Russian and Uzbek, with the same placeholders", () => {
    const en = dictionaries.en.captions;
    for (const [name, d] of Object.entries(dictionaries)) {
      expect(keys(d.captions).sort(), name).toEqual(keys(en).sort());
      const flat = (o: unknown): string[] => (typeof o === "string" ? [o] : typeof o === "object" && o ? Object.values(o).flatMap(flat) : []);
      const mine = flat(d.captions);
      const theirs = flat(en);
      mine.forEach((text, i) => {
        expect(text.trim(), `${name} ${i}`).not.toBe("");
        const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        expect(holes(text), `${name}: ${text}`).toBe(holes(theirs[i]));
      });
      expect(d.gen.kinds.captions.trim()).not.toBe("");
      expect(d.gen.reasons.no_speech.trim()).not.toBe("");
    }
  });

  it("names no provider or model, and no role words", () => {
    for (const [name, d] of Object.entries(dictionaries)) {
      const copy = JSON.stringify([d.captions, d.gen.kinds.captions, d.gen.reasons.no_speech]);
      expect(PROVIDER_BRANDS.test(copy), name).toBe(false);
      for (const word of ["owner", "viewer", "whisper", "scribe", "владелец", "наблюдател", "egasi", "kuzatuvchi"]) {
        expect(copy.toLowerCase(), `${name}: ${word}`).not.toContain(word);
      }
    }
  });

  it("a recording without speech has its own sentence, and the failure reasons use it", () => {
    for (const d of Object.values(dictionaries)) {
      expect(failureReason(d, { status: "failed", error_code: "no_speech" })).toBe(d.gen.reasons.no_speech);
      expect(failureReason(d, { status: "failed", error_code: "too_many_words" })).toBe(d.gen.reasons.bad_request);
    }
  });
});
