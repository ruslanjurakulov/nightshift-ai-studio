/**
 * Animated caption styles, the pure half: the closed list is the export's list
 * (samples/caption_styles.json, also pinned by tests/test_caption_styles.py),
 * applying one writes only data the document validator accepts, every tweak is
 * clamped, typed and imported captions are cleaned and bounded, and the
 * preview follows the export's own timings. Nothing here spends or renders.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { dictionaries } from "@/lib/i18n";
import { PROVIDER_BRANDS } from "./helpers/brands";
import {
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_STYLES,
  CAPTION_STYLE_IDS,
  CAPTION_Y_MAX,
  CAPTION_Y_MIN,
  MAX_STYLED_WORDS,
  MAX_TYPE_STEPS,
  cueLines,
  isCaptionStyleId,
  sizeFor,
  styleDefaults,
  textOn,
  typeSchedule,
  typedAtoms,
  wordSpansMs,
} from "@/lib/captionStyleTable";
import {
  activeCaptionStyle,
  applyCaptionStyle,
  clearCaptionStyle,
  setCaptionTweak,
} from "@/lib/captionStyles";
import { captionsOf, presetMatching, setCaptions, styleFor, DEFAULT_PRESET, type Captions } from "@/lib/captions";
import { MAX_CUES, MAX_TEXT, toDoc, validateTimeline, type EditorModel } from "@/lib/editor";
import { IMPORT_MAX_BYTES, NEW_CUE_S, addCue, captionsFromImport, parseCaptionFile } from "@/lib/captionCues";
import { BOXED_OPACITY, popScale, previewStyledCaption } from "@/lib/captionStylePreview";

const SAMPLE = JSON.parse(readFileSync(join(__dirname, "..", "..", "samples", "caption_styles.json"), "utf8"));
const A = "11111111-1111-4111-8111-111111111111";

const model = (over: Partial<EditorModel> = {}): EditorModel => ({
  width: 1080,
  height: 1920,
  fps: 30,
  clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 30, speed: 1, audio: true }],
  texts: [],
  sounds: [],
  keep: [],
  ...over,
});

const withCues = (over: Partial<EditorModel> = {}): EditorModel => {
  const base = model(over);
  return setCaptions(base, {
    style: styleFor(DEFAULT_PRESET, base.width, base.height),
    cues: [
      { id: "cap1", start_s: 0.5, end_s: 3, text: "Hello big wide world" },
      { id: "cap2", start_s: 3, end_s: 5, text: "second one" },
    ],
  });
};

describe("the closed list is the export's list", () => {
  it("is exactly samples/caption_styles.json", () => {
    expect([...CAPTION_STYLE_IDS]).toEqual(SAMPLE.styles.map((s: { id: string }) => s.id));
    expect(CAPTION_STYLES.map((s) => ({ ...s, uses: [...s.uses] }))).toEqual(SAMPLE.styles);
    expect([CAPTION_SIZE_MIN, CAPTION_SIZE_MAX]).toEqual([SAMPLE.size_min, SAMPLE.size_max]);
    expect([MAX_STYLED_WORDS, MAX_TYPE_STEPS]).toEqual([SAMPLE.max_styled_words, SAMPLE.max_type_steps]);
  });

  it("has ten styles with generic names", () => {
    expect(CAPTION_STYLE_IDS).toHaveLength(10);
    for (const id of CAPTION_STYLE_IDS) expect(id).toMatch(/^[a-z_]+$/);
  });

  it("only offers a name from the list", () => {
    for (const bad of ["spin", "Karaoke", "", null, undefined, 3, ["karaoke"], { id: "karaoke" }]) {
      expect(isCaptionStyleId(bad), String(bad)).toBe(false);
    }
    for (const id of CAPTION_STYLE_IDS) expect(isCaptionStyleId(id)).toBe(true);
  });

  it("spreads a cue's time over its words by the export's rule", () => {
    for (const c of SAMPLE.word_spans) expect(wordSpansMs(c.words, c.duration_ms), JSON.stringify(c)).toEqual(c.spans);
  });

  it("picks dark or light text on a colour by the export's rule", () => {
    for (const c of SAMPLE.text_on) expect(textOn(c.colour), c.colour).toBe(c.text);
  });

  it("reveals the typewriter's letters on the export's schedule", () => {
    for (const c of SAMPLE.type_schedule) expect(typeSchedule(c.atoms, c.duration_ms), JSON.stringify(c)).toEqual(c.schedule);
  });

  it("types more letters as time passes and has typed them all by the end", () => {
    let last = 0;
    for (let ms = 0; ms <= 2000; ms += 100) {
      const n = typedAtoms(30, 2000, ms);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(typedAtoms(30, 2000, 2000)).toBe(30);
    expect(typedAtoms(30, 2000, 0)).toBeGreaterThan(0);
  });

  it("splits a cue into lines of words", () => {
    expect(cueLines("a  b\n\nc d e")).toEqual([["a", "b"], ["c", "d", "e"]]);
    expect(cueLines("")).toEqual([]);
  });
});

describe("applying a style writes only data the document accepts", () => {
  it("every style on every frame shape validates and is the style's own look", () => {
    for (const [w, h] of [
      [1080, 1920],
      [1920, 1080],
      [1080, 1080],
    ]) {
      for (const id of CAPTION_STYLE_IDS) {
        const next = applyCaptionStyle(withCues({ width: w, height: h }), id);
        expect(validateTimeline(toDoc(next))).toEqual([]);
        expect(activeCaptionStyle(next)).toBe(id);
        const st = captionsOf(next)!.style;
        expect(st).toEqual(styleDefaults(id, w, h));
        expect(st.size).toBeGreaterThanOrEqual(CAPTION_SIZE_MIN);
        expect(st.size).toBeLessThanOrEqual(CAPTION_SIZE_MAX);
      }
    }
  });

  it("keeps the person's captions: ids, words and times", () => {
    const before = captionsOf(withCues())!.cues;
    for (const id of CAPTION_STYLE_IDS) expect(captionsOf(applyCaptionStyle(withCues(), id))!.cues).toEqual(before);
  });

  it("sizes by the short side so a portrait and a landscape frame read alike", () => {
    expect(sizeFor("karaoke", 1080, 1920)).toBe(sizeFor("karaoke", 1920, 1080));
    expect(sizeFor("big_centre", 16, 16)).toBe(CAPTION_SIZE_MIN);
    expect(sizeFor("big_centre", 4096, 4096)).toBe(CAPTION_SIZE_MAX);
  });

  it("does nothing without captions", () => {
    const bare = model();
    expect(applyCaptionStyle(bare, "neon")).toBe(bare);
    expect(activeCaptionStyle(bare)).toBeNull();
  });

  it("plain puts the default look back, without an animation", () => {
    const plain = clearCaptionStyle(applyCaptionStyle(withCues(), "neon"));
    expect(activeCaptionStyle(plain)).toBeNull();
    expect(captionsOf(plain)!.style).toEqual(styleFor(DEFAULT_PRESET, 1080, 1920));
    expect("preset" in (plain.captions as { style: object }).style).toBe(false);
    expect("highlight_color" in (plain.captions as { style: object }).style).toBe(false);
  });

  it("an animated look is never mistaken for one of the four transcript looks", () => {
    const m = applyCaptionStyle(withCues(), "clean");
    expect(presetMatching(captionsOf(m)!.style, 1080, 1920)).toBeNull();
  });

  it("a caption without a style is the document it always was", () => {
    expect(JSON.stringify((withCues().captions as { style: unknown }).style)).toBe(JSON.stringify(styleFor(DEFAULT_PRESET, 1080, 1920)));
  });
});

describe("tweaks are clamped to what the export draws", () => {
  const styled = () => applyCaptionStyle(withCues(), "karaoke");
  const style = (m: EditorModel) => captionsOf(m)!.style;

  it("size is a whole number inside the range", () => {
    expect(style(setCaptionTweak(styled(), "size", 9999)).size).toBe(CAPTION_SIZE_MAX);
    expect(style(setCaptionTweak(styled(), "size", -4)).size).toBe(CAPTION_SIZE_MIN);
    expect(style(setCaptionTweak(styled(), "size", 71.6)).size).toBe(72);
  });

  it("position keeps the caption inside the picture", () => {
    expect(style(setCaptionTweak(styled(), "y", 5)).y).toBe(CAPTION_Y_MAX);
    expect(style(setCaptionTweak(styled(), "y", -1)).y).toBe(CAPTION_Y_MIN);
    expect(style(setCaptionTweak(styled(), "y", 0.123456)).y).toBe(0.123);
  });

  it("colours must be #RRGGBB; anything else changes nothing", () => {
    const m = styled();
    expect(style(setCaptionTweak(m, "color", "#00ff7f")).color).toBe("#00FF7F");
    expect(style(setCaptionTweak(m, "highlight_color", "#abcdef")).highlight_color).toBe("#ABCDEF");
    for (const bad of ["red", "#12345", "#GGGGGG", "javascript:1", "{\\fs9}", "", "#FFF"]) {
      expect(setCaptionTweak(m, "color", bad), bad).toBe(m);
      expect(setCaptionTweak(m, "highlight_color", bad), bad).toBe(m);
    }
    expect(setCaptionTweak(m, "color", 5)).toBe(m);
  });

  it("a number that is not a number changes nothing", () => {
    const m = styled();
    for (const bad of [NaN, Infinity, "x"]) {
      expect(setCaptionTweak(m, "size", bad as number)).toBe(m);
      expect(setCaptionTweak(m, "y", bad as number)).toBe(m);
    }
  });

  it("the same value gives the same model: no empty history step", () => {
    const m = styled();
    expect(setCaptionTweak(m, "size", style(m).size)).toBe(m);
    expect(setCaptionTweak(m, "color", style(m).color.toLowerCase())).toBe(m);
  });

  it("does nothing on plain captions or without captions", () => {
    const plain = withCues();
    expect(setCaptionTweak(plain, "size", 80)).toBe(plain);
    const bare = model();
    expect(setCaptionTweak(bare, "size", 80)).toBe(bare);
  });

  it("every tweaked document still validates", () => {
    let m = styled();
    m = setCaptionTweak(m, "size", 120);
    m = setCaptionTweak(m, "y", 0.4);
    m = setCaptionTweak(m, "color", "#112233");
    m = setCaptionTweak(m, "highlight_color", "#445566");
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("the document validator knows the field", () => {
  const doc = (style: unknown) => {
    const d = toDoc(withCues());
    (d as { captions: { style: unknown } }).captions.style = style;
    return validateTimeline(d);
  };

  it("accepts a preset from the list and a highlight colour", () => {
    expect(doc({ preset: "neon", highlight_color: "#00E5FF" })).toEqual([]);
    expect(doc({ highlight_color: "#00E5FF" })).toEqual([]);
  });

  it("refuses a preset off the list, however it is spelt", () => {
    for (const bad of ["spin", "Karaoke", 7, null, "karaoke;x", ["karaoke"], {}]) {
      expect(doc({ preset: bad }).some((p) => p.includes("preset must be one of")), String(bad)).toBe(true);
    }
  });

  it("refuses a highlight colour that is not #RRGGBB", () => {
    for (const bad of ["cyan", "#0EF", 5, null]) {
      expect(doc({ preset: "neon", highlight_color: bad }).some((p) => p.includes("highlight_color")), String(bad)).toBe(true);
    }
  });

  it("refuses a field it does not know next to a preset", () => {
    expect(doc({ preset: "neon", motion: "spin" }).some((p) => p.includes("motion is not a known field"))).toBe(true);
  });
});

describe("typed and imported captions", () => {
  const SRT = `﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond &amp; last\r\nline two\r\n`;
  const VTT = `WEBVTT\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.500 align:start position:0%\n<v Ann>Hello</v> {\\an8}world\n\n01:00:05.250 --> 01:00:06.000\nLate one\n`;

  it("reads SubRip: markup and entities cleaned, lines kept, times in seconds", () => {
    const { cues, skipped } = parseCaptionFile(SRT);
    expect(skipped).toBe(0);
    expect(cues).toEqual([
      { start_s: 1, end_s: 2.5, text: "Hello there" },
      { start_s: 3, end_s: 4, text: "Second & last\nline two" },
    ]);
  });

  it("reads WebVTT: header, notes and styles skipped, short and long times, settings ignored", () => {
    const { cues } = parseCaptionFile(VTT);
    expect(cues).toEqual([
      { start_s: 1, end_s: 2.5, text: "Hello world" },
      { start_s: 3605.25, end_s: 3606, text: "Late one" },
    ]);
  });

  it("an empty or foreign file gives nothing and never throws", () => {
    for (const raw of ["", "just words", "WEBVTT\n", "1\nnot a time --> nope\nx", "\u0000\u0001", "00:00:02,000 --> 00:00:01,000\nbackwards"]) {
      expect(() => parseCaptionFile(raw), raw).not.toThrow();
      expect(parseCaptionFile(raw).cues, raw).toEqual([]);
    }
    expect(parseCaptionFile("1\n00:00:01,000 --> 00:00:02,000\n\n").skipped).toBe(1);
    expect(parseCaptionFile("00:00:02,000 --> 00:00:01,000\nbackwards").skipped).toBe(1);
  });

  it("cues come out in time order and never overlap", () => {
    const raw = "1\n00:00:05,000 --> 00:00:08,000\nlate\n\n2\n00:00:01,000 --> 00:00:06,000\nearly\n";
    const { cues } = parseCaptionFile(raw);
    expect(cues.map((c) => c.text)).toEqual(["early", "late"]);
    expect(cues[0].end_s).toBe(5);
    for (let i = 0; i + 1 < cues.length; i++) expect(cues[i].end_s).toBeLessThanOrEqual(cues[i + 1].start_s);
  });

  it("two cues that start together keep one", () => {
    const { cues, skipped } = parseCaptionFile("1\n00:00:01,000 --> 00:00:03,000\na\n\n2\n00:00:01,000 --> 00:00:02,000\nb\n");
    expect(cues).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("bounds the text, the control characters and the number of cues", () => {
    const long = parseCaptionFile(`1\n00:00:01,000 --> 00:00:02,000\n${"x".repeat(MAX_TEXT + 100)}\n`);
    expect(long.cues[0].text).toHaveLength(MAX_TEXT);
    const sneaky = parseCaptionFile("1\n00:00:01,000 --> 00:00:02,000\na‮b​c\u0007d\n");
    expect(sneaky.cues[0].text).toBe("abcd");
    const many = Array.from({ length: MAX_CUES + 3 }, (_, i) => `${i + 1}\n00:00:00,${String(0).padStart(3, "0")} --> 00:00:01,000\nx`);
    // Same start times collapse; spread them out to test the cap.
    const spread = Array.from({ length: MAX_CUES + 3 }, (_, i) => {
      const s = i * 2;
      const t = (n: number) => `${String(Math.floor(n / 3600)).padStart(2, "0")}:${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")},000`;
      return `${i + 1}\n${t(s)} --> ${t(s + 1)}\nx`;
    }).join("\n\n");
    expect(parseCaptionFile(spread).cues).toHaveLength(MAX_CUES);
    expect(parseCaptionFile(spread).skipped).toBe(3);
    expect(many.length).toBeGreaterThan(MAX_CUES);
    expect(IMPORT_MAX_BYTES).toBeLessThanOrEqual(1_000_000);
  });

  it("imported captions get fresh ids, are cut at the picture's end and keep the current style", () => {
    const m = applyCaptionStyle(withCues(), "neon");
    const parsed = parseCaptionFile("1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:20,000 --> 00:00:40,000\nb\n\n3\n00:01:00,000 --> 00:01:02,000\nc\n");
    const made = captionsFromImport(m, parsed, 30)!;
    expect(made.cues.map((c) => c.text)).toEqual(["a", "b"]);
    expect(made.cues[1].end_s).toBe(30);
    expect(new Set(made.cues.map((c) => c.id)).size).toBe(2);
    expect(made.style.preset).toBe("neon");
    expect(captionsFromImport(m, parseCaptionFile("1\n00:01:00,000 --> 00:01:02,000\nc\n"), 30)).toBeNull();
    // With no captions yet it starts from the default look.
    expect(captionsFromImport(model(), parsed, 30)!.style).toEqual(styleFor(DEFAULT_PRESET, 1080, 1920));
    expect(validateTimeline(toDoc(setCaptions(model(), made as Captions)))).toEqual([]);
  });

  it("a typed caption goes after the last one, two seconds long, with a fresh id", () => {
    const m = addCue(withCues(), "New caption", 30)!;
    const cues = captionsOf(m)!.cues;
    expect(cues).toHaveLength(3);
    expect(cues[2]).toMatchObject({ start_s: 5, end_s: 5 + NEW_CUE_S, text: "New caption" });
    expect(new Set(cues.map((c) => c.id)).size).toBe(3);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("a typed caption works on a project with no captions and keeps an animated style", () => {
    const first = addCue(model(), "New caption", 30)!;
    expect(captionsOf(first)!.cues[0]).toMatchObject({ start_s: 0, end_s: NEW_CUE_S });
    const styled = applyCaptionStyle(withCues(), "typewriter");
    expect(captionsOf(addCue(styled, "x", 30)!)!.style.preset).toBe("typewriter");
  });

  it("a typed caption is refused when the picture leaves no room", () => {
    expect(addCue(withCues(), "x", 5.2)).toBeNull();
    expect(addCue(model(), "x", 0.2)).toBeNull();
    expect(captionsOf(addCue(withCues(), "x", 5.5)!)!.cues[2].end_s).toBe(5.5);
  });
});

describe("the preview follows the export's timings", () => {
  const base = (preset: string, over: Record<string, unknown> = {}) => ({
    style: { ...styleDefaults("karaoke", 1080, 1920), ...styleDefaults(preset as never, 1080, 1920), ...over } as never,
    text: "aaa bbb ccc",
    startS: 1,
    endS: 4,
    frameWidth: 1080,
  });
  const colours = (p: ReturnType<typeof previewStyledCaption>) =>
    p!.lines.flat().filter((s) => s.text.trim()).map((s) => s.style?.color);

  it("is null for a caption without a style, or with one off the list", () => {
    expect(previewStyledCaption({ ...base("karaoke"), style: { ...styleDefaults("karaoke", 1080, 1920), preset: undefined } as never, t: 2 })).toBeNull();
    expect(previewStyledCaption({ ...base("karaoke"), style: { ...styleDefaults("karaoke", 1080, 1920), preset: "spin" } as never, t: 2 })).toBeNull();
  });

  it("karaoke fills words with the highlight colour as the cue plays", () => {
    const hi = "#FFD400";
    const white = "#FFFFFF";
    const at = (t: number) => colours(previewStyledCaption({ ...base("karaoke"), t }));
    // Three equal words over 3 s: each is half-filled 0.5 s, 1.5 s and 2.5 s in.
    expect(at(1.01)).toEqual([white, white, white]);
    expect(at(2.4)).toEqual([hi, white, white]);
    expect(at(3.4)).toEqual([hi, hi, white]);
    expect(at(3.99)).toEqual([hi, hi, hi]);
  });

  it("big centre lights exactly one word at a time", () => {
    for (const t of [1.2, 2.0, 3.0, 3.9]) {
      const lit = colours(previewStyledCaption({ ...base("big_centre"), t })).filter((c) => c === "#FFD400");
      expect(lit, String(t)).toHaveLength(1);
    }
  });

  it("boxed puts a solid box behind the lit word and a translucent one behind the rest", () => {
    const p = previewStyledCaption({ ...base("boxed"), t: 1.2 })!;
    const words = p.lines.flat().filter((s) => s.text.trim());
    expect(words[0].style!.backgroundColor).toBe("#FFD400");
    expect(words[0].style!.color).toBe("#000000");
    expect(String(words[1].style!.backgroundColor)).toContain(String(BOXED_OPACITY));
  });

  it("pop grows from small to full size and settles at 1", () => {
    expect(popScale(0)).toBeCloseTo(0.6);
    expect(popScale(130)).toBeCloseTo(1.18);
    expect(popScale(250)).toBe(1);
    expect(String(previewStyledCaption({ ...base("pop_in"), t: 1.0 })!.box.transform)).toContain("scale(0.600)");
    expect(String(previewStyledCaption({ ...base("pop_in"), t: 2.0 })!.box.transform)).toContain("scale(1.000)");
  });

  it("typewriter shows more letters over time and hides the rest without moving the line", () => {
    const shown = (t: number) => {
      const p = previewStyledCaption({ ...base("typewriter"), text: "abcdefghij klmnop", t })!;
      return p.lines[0][0].text.length;
    };
    // 17 letters are typed over 70 % of the cue, at most 60 ms a letter: 1.02 s.
    expect(shown(1.0)).toBeLessThan(shown(1.4));
    expect(shown(1.4)).toBeLessThan(shown(3.99));
    expect(shown(3.99)).toBe(17);
    const half = previewStyledCaption({ ...base("typewriter"), text: "abcdefghij klmnop", t: 1.5 })!;
    expect(half.lines[0].map((s) => s.text).join("")).toBe("abcdefghij klmnop");
    expect(half.lines[0][1].style!.color).toBe("transparent");
  });

  it("lower third slides in from the left and sits on a colour block", () => {
    const early = previewStyledCaption({ ...base("lower_third"), t: 1.0 })!;
    const late = previewStyledCaption({ ...base("lower_third"), t: 2.0 })!;
    expect(String(early.box.transform)).toContain("translateX(-");
    expect(String(late.box.transform)).toMatch(/translateX\(0(cqw)?\)/);
    expect(early.lines[0][0].style!.backgroundColor).toContain("rgba(30, 107, 255");
    expect(early.box.left).toBe("6%");
  });

  it("line slide rises into place; every style fades in and out inside the cue", () => {
    expect(String(previewStyledCaption({ ...base("line_slide"), t: 1.0 })!.box.transform)).toContain("translateY(");
    // (A typewriter has no fade: its letters are the entrance.)
    for (const id of CAPTION_STYLE_IDS.filter((x) => x !== "typewriter")) {
      const o = (t: number) => Number(previewStyledCaption({ ...base(id), t })!.box.opacity);
      expect(o(1.0), id).toBeLessThan(1);
      expect(o(2.5), id).toBe(1);
      expect(o(3.999), id).toBeLessThan(1);
    }
  });

  it("text is placed where the style says and never as markup", () => {
    const p = previewStyledCaption({ ...base("big_centre"), text: "<img src=x onerror=1> & more", t: 2 })!;
    expect(p.box.top).toBe("50%");
    expect(p.lines.flat().map((s) => s.text).join("")).toBe("<img src=x onerror=1> & more");
  });

  it("a very long caption is not lit word by word", () => {
    const text = Array.from({ length: MAX_STYLED_WORDS + 1 }, () => "w").join(" ");
    const p = previewStyledCaption({ ...base("big_centre"), text, t: 2 })!;
    expect(p.lines.flat().every((s) => !s.style?.color)).toBe(true);
  });
});

describe("the words people read", () => {
  it("are complete in every language, name no provider, and use no role words", () => {
    const flat = (v: unknown): string[] => (typeof v === "string" ? [v] : Object.values(v as object).flatMap(flat));
    const en = flat(dictionaries.en.captions.animated);
    expect(en.length).toBeGreaterThan(30);
    for (const [name, d] of Object.entries(dictionaries)) {
      const mine = flat(d.captions.animated);
      expect(mine).toHaveLength(en.length);
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      mine.forEach((text, i) => {
        expect(text.trim(), `${name} ${i}`).not.toBe("");
        expect(holes(text), `${name}: ${text}`).toBe(holes(en[i]));
      });
      const copy = JSON.stringify(d.captions.animated);
      expect(PROVIDER_BRANDS.test(copy), name).toBe(false);
      for (const word of ["owner", "viewer", "editor", "владелец", "наблюдател", "редактор", "egasi", "kuzatuvchi", "muharrir"]) {
        expect(copy.toLowerCase(), `${name}: ${word}`).not.toContain(word);
      }
    }
  });

  it("shares no name with the four transcript looks beside them (they are told apart by name)", () => {
    for (const [name, d] of Object.entries(dictionaries)) {
      const mine = [d.captions.animated.plain, d.captions.animated.plainNote]
        .concat(CAPTION_STYLE_IDS.flatMap((id) => [d.captions.animated.styles[id], d.captions.animated.notes[id]]))
        .join(" | ");
      for (const look of Object.values(d.captions.presets)) {
        expect(mine.includes(look), `${name}: ${look}`).toBe(false);
      }
    }
  });

  it("names every style and gives each a note, in every language", () => {
    for (const d of Object.values(dictionaries)) {
      const names = CAPTION_STYLE_IDS.map((id) => d.captions.animated.styles[id]);
      expect(new Set(names).size).toBe(10);
      for (const id of CAPTION_STYLE_IDS) expect(d.captions.animated.notes[id].trim()).not.toBe("");
    }
  });
});
