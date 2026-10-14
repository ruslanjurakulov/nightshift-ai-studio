"""Tests for the animated caption styles (modules/caption_styles.py, the styled
path of modules/ass_captions.py, and the validators that name a style).

What would break:
  * a style id outside the closed list reaching the export, or a document with
    one passing a validator the other refuses;
  * the Python table, the TypeScript table and samples/caption_styles.json
    drifting apart (the editor would offer a look the export does not draw);
  * a caption without a style changing at all (older documents render as before);
  * a cue's words smuggling an ASS tag through the styled path;
  * the exact libass tags of a style changing without anyone noticing: the
    string tests below always run; the real-render tests (ffmpeg + libass) skip
    when it is absent and measure what each style puts on the picture.
"""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import ass_captions, caption_styles as cs, render_backend
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = json.loads((ROOT / "samples" / "caption_styles.json").read_text(encoding="utf-8"))
W, H = 540, 960


def overlay(sid, text="Go big now", start=1.0, end=3.0, **over):
    d = cs.STYLES[sid]
    fields = dict(start_s=start, end_s=end, text=text, font=d.font, size=cs.size_for(sid, W, H),
                  color=d.color, outline_color=d.outline_color, outline_width=float(d.outline_width),
                  bold=d.bold, x=d.x, y=d.y, anchor=d.anchor, caption_style=sid,
                  highlight_color=d.highlight_color)
    fields.update(over)
    return rs.TextOverlay(**fields)


def ass_of(*overlays, w=W, h=H):
    return ass_captions.build_overlay_ass(list(overlays), width=w, height=h)


def pinned(ass):
    return tuple(ln for ln in ass.splitlines() if ln.startswith(("Style", "Dialogue")))


def doc(style=None, text="Hello big wide world", w=W, h=H):
    captions = {"cues": [{"id": "k1", "start_s": 0.5, "end_s": 3.0, "text": text}]}
    if style is not None:
        captions["style"] = style
    return {"version": 1, "width": w, "height": h, "fps": 30,
            "tracks": [{"id": "v1", "kind": "V", "clips": []}], "captions": captions}


GOLDEN = {
    'karaoke': (
        'Style: O0,DejaVu Sans,33,&H0000D4FF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,749)\\fad(80,80)}{\\kf55}Go {\\kf72}big {\\kf73}now',
    ),
    'pop_in': (
        'Style: O0,DejaVu Sans,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\q2\\pos(270,710)\\fscx60\\fscy60\\t(0,130,\\fscx118\\fscy118)\\t(130,250,\\fscx100\\fscy100)\\fad(70,100)}Go big now',
    ),
    'boxed': (
        'Style: O0,DejaVu Sans,31,&H00FFFFFF,&H00FFFFFF,&H40000000,&H00000000,-1,0,0,0,100,100,0,0,3,5,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,768)\\fad(80,80)}{\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&\\t(0,1,\\1c&H000000&\\3c&H00D4FF&\\3a&H00&)\\t(545,546,\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&)}Go{\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&} {\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&\\t(545,546,\\1c&H000000&\\3c&H00D4FF&\\3a&H00&)\\t(1273,1274,\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&)}big{\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&} {\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&\\t(1273,1274,\\1c&H000000&\\3c&H00D4FF&\\3a&H00&)}now{\\1c&HFFFFFF&\\3c&H000000&\\3a&H40&}',
    ),
    'big_centre': (
        'Style: O0,DejaVu Sans,65,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,5,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,480)\\fad(60,60)}{\\1c&HFFFFFF&\\t(0,1,\\1c&H00D4FF&)\\t(545,546,\\1c&HFFFFFF&)}Go {\\1c&HFFFFFF&\\t(545,546,\\1c&H00D4FF&)\\t(1273,1274,\\1c&HFFFFFF&)}big {\\1c&HFFFFFF&\\t(1273,1274,\\1c&H00D4FF&)}now',
    ),
    'lower_third': (
        'Style: O0,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H19FF6B1E,&H00000000,-1,0,0,0,100,100,0,0,3,6,0,1,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\move(-16,845,32,845,0,240)\\fad(150,120)}Go big now',
    ),
    'outlined': (
        'Style: O0,DejaVu Sans,49,&H00FFFFFF,&H00FFFFFF,&H00303BFF,&H00000000,-1,0,0,0,100,100,0,0,1,8,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,672)\\fad(60,60)}Go big now',
    ),
    'neon': (
        'Style: O0,DejaVu Sans,40,&H00FFFFFF,&H00FFFFFF,&H00FFE500,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,691)\\bord5\\blur8\\1c&HFFE500&\\3c&HFFE500&\\1a&H80&\\3a&H30&\\fad(120,120)}Go big now',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,691)\\blur0.6\\fad(120,120)}Go big now',
    ),
    'typewriter': (
        'Style: O0,DejaVu Sans,31,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,768)}{\\alpha&HFF&\\t(0,1,\\alpha&H00&)}G{\\alpha&HFF&\\t(60,61,\\alpha&H00&)}o{\\alpha&HFF&\\t(120,121,\\alpha&H00&)} {\\alpha&HFF&\\t(180,181,\\alpha&H00&)}b{\\alpha&HFF&\\t(240,241,\\alpha&H00&)}i{\\alpha&HFF&\\t(300,301,\\alpha&H00&)}g{\\alpha&HFF&\\t(360,361,\\alpha&H00&)} {\\alpha&HFF&\\t(420,421,\\alpha&H00&)}n{\\alpha&HFF&\\t(480,481,\\alpha&H00&)}o{\\alpha&HFF&\\t(540,541,\\alpha&H00&)}w',
    ),
    'line_slide': (
        'Style: O0,DejaVu Sans,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\move(270,835,270,816,0,260)\\fad(180,140)}Go big now',
    ),
    'clean': (
        'Style: O0,Liberation Sans,27,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,2,2,22,22,0,1',
        'Dialogue: 0,0:00:01.00,0:00:03.00,O0,,0,0,0,,{\\pos(270,883)\\fad(150,150)}Go big now',
    ),
}


class TableTestCase(unittest.TestCase):
    def test_the_python_table_is_the_shared_sample(self):
        rows = {r["id"]: r for r in SAMPLE["styles"]}
        self.assertEqual(tuple(rows), cs.STYLE_IDS)
        self.assertEqual(tuple(cs.STYLES), cs.STYLE_IDS)
        for sid, s in cs.STYLES.items():
            r = rows[sid]
            self.assertEqual(
                (s.font, s.bold, s.size_frac, s.color, s.highlight_color, s.outline_color,
                 s.outline_width, s.x, s.y, s.anchor, list(s.uses)),
                (r["font"], r["bold"], r["size_frac"], r["color"], r["highlight_color"],
                 r["outline_color"], r["outline_width"], r["x"], r["y"], r["anchor"], r["uses"]), sid)
        self.assertEqual((cs.SIZE_MIN, cs.SIZE_MAX), (SAMPLE["size_min"], SAMPLE["size_max"]))
        self.assertEqual((cs.MAX_STYLED_WORDS, cs.MAX_TYPE_STEPS),
                         (SAMPLE["max_styled_words"], SAMPLE["max_type_steps"]))

    def test_a_style_only_uses_tweaks_that_exist_and_fonts_the_worker_has(self):
        for sid, s in cs.STYLES.items():
            self.assertTrue(set(s.uses) <= set(cs.TWEAKS), sid)
            self.assertIn("color", s.uses)
            self.assertIn(s.font, tl.FONTS, sid)
            self.assertIn(s.anchor, tl.ANCHORS, sid)
            self.assertTrue(cs.HEX.fullmatch(s.color) and cs.HEX.fullmatch(s.highlight_color), sid)
            self.assertTrue(0 <= s.x <= 1 and 0 <= s.y <= 1, sid)

    def test_ten_styles_with_generic_names(self):
        self.assertEqual(len(cs.STYLE_IDS), 10)
        for sid in cs.STYLE_IDS:
            self.assertRegex(sid, r"^[a-z_]+$")

    def test_defaults_are_a_valid_caption_style_for_every_frame_shape(self):
        for w, h in ((1080, 1920), (1920, 1080), (1080, 1080), (16, 16), (4096, 2304)):
            for sid in cs.STYLE_IDS:
                style = cs.defaults_for(sid, w, h)
                self.assertEqual(tl.validate(doc(style, w=min(w, 3840), h=min(h, 2160))
                                              if w * h <= tl.MAX_FRAME_PIXELS else doc(style)), [], (sid, w, h))
                self.assertTrue(cs.SIZE_MIN <= style["size"] <= cs.SIZE_MAX)

    def test_word_spans_follow_the_shared_cases(self):
        for case in SAMPLE["word_spans"]:
            self.assertEqual([list(s) for s in cs.word_spans_ms(case["words"], case["duration_ms"])],
                             case["spans"], case)

    def test_the_typewriter_schedule_follows_the_shared_cases(self):
        for case in SAMPLE["type_schedule"]:
            self.assertEqual([list(x) for x in cs.type_schedule(case["atoms"], case["duration_ms"])],
                             case["schedule"], case)

    def test_the_typewriter_schedule_reveals_everything_in_order_inside_the_cue(self):
        for n in (1, 7, 40, 41, 500):
            for ms in (100, 2000, 60000):
                sched = cs.type_schedule(n, ms)
                self.assertEqual(sched[0], (0, 0))
                self.assertLessEqual(len(sched), cs.MAX_TYPE_STEPS)
                self.assertEqual([a for a, _ in sched], sorted(a for a, _ in sched))
                self.assertEqual([t for _, t in sched], sorted(t for _, t in sched))
                self.assertLess(sched[-1][1], ms)

    def test_word_spans_cover_the_cue_without_gap_or_overlap(self):
        for words in (["a"], ["a", "bb", "ccc"], ["x"] * 79, ["Привет", "мир", "и", "всем"]):
            for ms in (0, 10, 333, 2500, 99999):
                spans = cs.word_spans_ms(words, ms)
                self.assertEqual(spans[0][0], 0)
                self.assertEqual(spans[-1][1], ms)
                for (_a, b), (c, _d) in zip(spans, spans[1:]):
                    self.assertEqual(b, c)
                self.assertTrue(all(s <= e for s, e in spans))

    def test_wrap_lines_breaks_by_letter_count_and_keeps_every_word(self):
        words = "the quick brown fox jumps over the lazy dog again and again".split()
        out = cs.wrap_lines([words], 540, 22, 42)
        self.assertGreater(len(out), 1)
        self.assertEqual([w for ln in out for w in ln], words)
        limit = int((540 - 44) / (cs.AVG_GLYPH_EM * 42))
        for ln in out:
            self.assertLessEqual(len(" ".join(ln)), limit)
        self.assertEqual(cs.wrap_lines([["a", "b"], ["c"]], 540, 22, 42), [["a", "b"], ["c"]])   # paragraphs stay
        self.assertEqual(cs.wrap_lines([["x" * 90]], 540, 22, 42), [["x" * 90]])                 # a long word keeps its line

    def test_text_on_picks_a_readable_colour(self):
        for case in SAMPLE["text_on"]:
            self.assertEqual(cs.text_on(case["colour"]), case["text"], case)


class AssStringTestCase(unittest.TestCase):
    def test_every_style_writes_exactly_these_tags(self):
        self.assertEqual(set(GOLDEN), set(cs.STYLE_IDS))
        for sid in cs.STYLE_IDS:
            with self.subTest(sid):
                self.assertEqual(pinned(ass_of(overlay(sid))), GOLDEN[sid])

    def test_a_styled_cue_never_changes_the_other_overlays_lines(self):
        plain = rs.TextOverlay(0.0, 1.0, "Title", size=40)
        alone = ass_captions.build_overlay_ass([plain], width=W, height=H)
        both = ass_captions.build_overlay_ass([plain, overlay("karaoke")], width=W, height=H)
        self.assertEqual([ln for ln in alone.splitlines() if "O0" in ln],
                         [ln for ln in both.splitlines() if "O0," in ln])
        self.assertIn("Style: O1,", both)
        self.assertIn("Dialogue: 1,", both)

    def test_karaoke_durations_fill_the_whole_cue(self):
        line = pinned(ass_of(overlay("karaoke", text="one two three four", start=0.0, end=4.37)))[1]
        self.assertEqual(sum(int(n) for n in re.findall(r"\\kf(\d+)", line)), 437)

    def test_each_word_is_lit_once_and_the_last_stays_lit(self):
        line = pinned(ass_of(overlay("big_centre", text="a bb ccc", start=0.0, end=3.0)))[1]
        self.assertEqual(line.count(r"\t(") , 5)    # three lights on, two off
        boxed = pinned(ass_of(overlay("boxed", text="a bb ccc", start=0.0, end=3.0)))[1]
        self.assertEqual(boxed.count(r"\t("), 5)

    def test_a_pasted_page_is_not_lit_word_by_word(self):
        text = " ".join(["word"] * (cs.MAX_STYLED_WORDS + 1))
        for sid in ("boxed", "big_centre"):
            line = pinned(ass_of(overlay(sid, text=text, start=0.0, end=60.0)))[1]
            self.assertNotIn(r"\t(", line, sid)
            self.assertTrue(line.endswith("word"), sid)

    def test_typewriter_steps_are_bounded(self):
        line = pinned(ass_of(overlay("typewriter", text="x" * 500, start=0.0, end=20.0)))[1]
        steps = line.count(r"\alpha&HFF&")
        self.assertTrue(30 <= steps <= cs.MAX_TYPE_STEPS, steps)
        self.assertEqual(line.count("x"), 500)    # every letter is there from the start: no re-wrap

    def test_line_breaks_are_kept_in_every_style(self):
        for sid in cs.STYLE_IDS:
            ass = ass_of(overlay(sid, text="first line\nsecond line"))
            self.assertIn(r"\N", [ln for ln in ass.splitlines() if ln.startswith("Dialogue")][0], sid)

    def test_fades_never_exceed_a_short_cue(self):
        for sid in ("karaoke", "pop_in", "boxed", "big_centre", "lower_third", "outlined", "neon",
                    "line_slide", "clean"):
            line = pinned(ass_of(overlay(sid, start=0.0, end=0.2)))[1]
            m = re.search(r"\\fad\((\d+),(\d+)\)", line)
            self.assertTrue(m and int(m[1]) <= 100 and int(m[2]) <= 100, (sid, line))

    def test_cue_words_cannot_add_tags_in_any_style(self):
        evil = r"{\fs900\pos(0,0)\1c&H0000FF&}boom\N{\r}"
        for sid in cs.STYLE_IDS:
            with self.subTest(sid):
                events = [ln for ln in ass_of(overlay(sid, text=evil)).splitlines()
                          if ln.startswith("Dialogue")]
                for ev in events:
                    body = ev.split(",,0,0,0,,", 1)[1]
                    text = re.sub(r"\{[^{}]*\}", "", body)        # what is left once our own tag blocks go
                    self.assertNotIn("{", text)
                    self.assertNotIn("}", text)
                    self.assertNotIn("\\", text.replace("\\N", ""))   # no tag can start in the words
                    self.assertIn("boom", text)

    def test_colours_come_from_the_validated_fields_only(self):
        line = pinned(ass_of(overlay("karaoke", color="#112233", highlight_color="#AABBCC")))
        self.assertIn("&H00CCBBAA", line[0])   # BGR
        self.assertIn("&H00332211", line[0])


class TimelineTestCase(unittest.TestCase):
    def test_a_document_without_a_style_normalises_exactly_as_before(self):
        n = tl.normalise(doc())
        self.assertEqual(n["captions"]["style"], {**tl.CAPTION_STYLE_DEFAULTS, "y": 0.9,
                                                   "outline_width": 3.0})
        self.assertNotIn("preset", n["captions"]["style"])
        self.assertNotIn("highlight_color", n["captions"]["style"])
        spec = tr.to_render_spec(doc(), lambda _a: None, "/tmp/out.mp4")
        for o in spec.overlays:
            self.assertIsNone(o.caption_style)
            self.assertNotIn("caption_style", o.to_dict())
            self.assertNotIn("highlight_color", o.to_dict())

    def test_every_preset_is_valid_and_fills_what_the_document_leaves_out(self):
        for sid in cs.STYLE_IDS:
            with self.subTest(sid):
                d = doc({"preset": sid})
                self.assertEqual(tl.validate(d), [])
                style = tl.normalise(d)["captions"]["style"]
                self.assertEqual(style, {**cs.defaults_for(sid, W, H), "y": cs.STYLES[sid].y})

    def test_what_the_document_sets_beats_the_preset(self):
        style = tl.normalise(doc({"preset": "boxed", "color": "#123456", "highlight_color": "#ABCDEF",
                                   "size": 77, "y": 0.4}))["captions"]["style"]
        self.assertEqual((style["color"], style["highlight_color"], style["size"], style["y"]),
                         ("#123456", "#ABCDEF", 77, 0.4))
        self.assertEqual(style["font"], "DejaVu Sans")

    def test_unknown_or_malformed_styles_are_refused(self):
        for bad, needle in (({"preset": "spin"}, "preset must be one of"),
                            ({"preset": 3}, "preset must be one of"),
                            ({"preset": None}, "preset must be one of"),
                            ({"preset": "karaoke;rm"}, "preset must be one of"),
                            ({"preset": ["karaoke"]}, "preset must be one of"),
                            ({"highlight_color": "red"}, "highlight_color must be a #RRGGBB"),
                            ({"highlight_color": "#12345"}, "highlight_color must be a #RRGGBB"),
                            ({"highlight_color": 5}, "highlight_color must be a #RRGGBB"),
                            ({"preset": "neon", "size": 9999}, "size must be an integer"),
                            ({"preset": "neon", "y": 2}, "y must be a number"),
                            ({"preset": "neon", "motion": "spin"}, "motion is not a known field")):
            with self.subTest(bad):
                problems = tl.validate(doc(bad))
                self.assertTrue(any(needle in p for p in problems), problems)

    def test_the_render_spec_carries_the_style_and_its_anchor(self):
        for sid in cs.STYLE_IDS:
            spec = tr.to_render_spec(doc({"preset": sid, "highlight_color": "#ABCDEF"}),
                                     lambda _a: None, "/tmp/out.mp4")
            o = spec.overlays[0]
            s = cs.STYLES[sid]
            self.assertEqual((o.caption_style, o.highlight_color, o.x, o.anchor),
                             (sid, "#ABCDEF", s.x, s.anchor), sid)
            self.assertEqual(rs.validate(spec), [], sid)
            self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()).overlays[0], o)

    def test_the_render_spec_refuses_a_style_off_the_list(self):
        spec = tr.to_render_spec(doc({"preset": "neon"}), lambda _a: None, "/tmp/out.mp4")
        from dataclasses import replace
        bad = replace(spec, overlays=[replace(spec.overlays[0], caption_style="spin")])
        self.assertTrue(any("caption_style must be one of" in p for p in rs.validate(bad)))
        bad = replace(spec, overlays=[replace(spec.overlays[0], highlight_color="{\\fs9}")])
        self.assertTrue(any("highlight_color must be a #RRGGBB" in p for p in rs.validate(bad)))

    def test_the_schema_lists_the_same_styles_and_the_same_fields(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        props = schema["$defs"]["captions"]["properties"]["style"]["properties"]
        self.assertEqual(props["preset"]["enum"], list(cs.STYLE_IDS))
        self.assertEqual(props["highlight_color"]["pattern"], tl._HEX_RE.pattern)
        self.assertEqual(set(props), set(tl._CAPTION_STYLE_KEYS))

    def test_a_styled_caption_still_validates_against_the_json_schema_when_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed (not a project dependency)")
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        for sid in cs.STYLE_IDS:
            jsonschema.validate(doc({"preset": sid, "highlight_color": "#ABCDEF"}), schema)
            jsonschema.validate(tl.load(doc({"preset": sid})), schema)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(doc({"preset": "spin"}), schema)


# ── real renders ────────────────────────────────────────────────────────────

def _ffmpeg_ok() -> bool:
    try:
        exe = render_backend.resolve_ffmpeg()
        return subprocess.run([exe, "-version"], capture_output=True).returncode == 0 \
            and ass_captions.has_libass(exe)
    except Exception:
        return False


@unittest.skipUnless(_ffmpeg_ok(), "ffmpeg with libass not available")
class RealRenderTestCase(unittest.TestCase):
    """What each style puts on the picture, measured on frames burnt by the
    same libass the export uses (a flat colour behind, so any change is the caption)."""

    BG = (0x33, 0x55, 0x77)

    @classmethod
    def setUpClass(cls):
        try:
            from PIL import Image  # noqa: F401
        except Exception:
            raise unittest.SkipTest("PIL not available")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ffmpeg = render_backend.resolve_ffmpeg()
        cls.cache = {}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def frame(self, sid, t, text="Go big now there you are", start=1.0, end=3.0, **over):
        """The frame at ``t`` as a PIL image, the caption's ASS burnt over a flat colour."""
        from PIL import Image
        key = (sid, t, text, start, end, tuple(sorted(over.items())))
        if key in self.cache:
            return self.cache[key]
        d = Path(self.tmp.name)
        ass = d / f"{len(self.cache)}.ass"
        ass.write_text(ass_of(overlay(sid, text=text, start=start, end=end, **over)), encoding="utf-8")
        png = d / f"{len(self.cache)}.png"
        r, g, b = self.BG
        subprocess.run([self.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        f"color=c=0x{r:02x}{g:02x}{b:02x}:s={W}x{H}:r=25:d=5",
                        "-vf", ass_captions.subtitles_filter(ass), "-ss", str(t), "-frames:v", "1",
                        str(png)], check=True)
        img = Image.open(png).convert("RGB")
        self.cache[key] = img
        return img

    def ink(self, img, near=None, tol=40):
        """Pixels that differ from the background (or are near ``near`` when given), as (x, y) lists."""
        px = img.load()
        out = []
        for y in range(img.height):
            for x in range(img.width):
                p = px[x, y]
                if near is None:
                    if max(abs(p[i] - self.BG[i]) for i in range(3)) > tol:
                        out.append((x, y))
                elif max(abs(p[i] - near[i]) for i in range(3)) <= tol:
                    out.append((x, y))
        return out

    def test_every_style_draws_while_the_cue_is_on_and_nothing_outside_it(self):
        for sid in cs.STYLE_IDS:
            with self.subTest(sid):
                self.assertEqual(self.ink(self.frame(sid, 0.5)), [], "before the cue")
                self.assertGreater(len(self.ink(self.frame(sid, 2.5))), 100, "during the cue")
                self.assertEqual(self.ink(self.frame(sid, 3.8)), [], "after the cue")

    def test_karaoke_fills_with_the_highlight_colour_as_the_cue_plays(self):
        hi = (0xFF, 0xD4, 0x00)
        early = len(self.ink(self.frame("karaoke", 1.3), hi, 30))
        late = len(self.ink(self.frame("karaoke", 2.8), hi, 30))
        self.assertGreater(late, early * 2)
        self.assertGreater(early, 0)

    def test_big_centre_lights_one_word_and_it_moves_along_the_line(self):
        hi = (0xFF, 0xD4, 0x00)
        first = self.ink(self.frame("big_centre", 1.2, text="aaa bbb ccc"), hi, 30)
        last = self.ink(self.frame("big_centre", 2.9, text="aaa bbb ccc"), hi, 30)
        self.assertTrue(first and last)
        mid = lambda pts: sum(y for _x, y in pts) / len(pts)      # noqa: E731
        self.assertLess(abs(mid(first) - H / 2) + abs(mid(last) - H / 2), H / 2)   # centre of the frame
        self.assertNotEqual((min(x for x, _ in first), min(y for _x, y in first)),
                            (min(x for x, _ in last), min(y for _x, y in last)))

    def test_boxed_draws_a_solid_box_behind_the_lit_word_only(self):
        hi = (0xFF, 0xD4, 0x00)
        self.assertGreater(len(self.ink(self.frame("boxed", 1.4), hi, 12)), 200)   # solid highlight box
        dark = self.ink(self.frame("boxed", 1.4), (0, 0, 0), 60)                    # the others' dark box
        self.assertGreater(len(dark), 200)

    def test_lower_third_hugs_the_left_edge_and_is_a_colour_block(self):
        block = (0x1E, 0x6B, 0xFF)
        img = self.frame("lower_third", 2.5, text="Name here")
        pts = self.ink(img, block, 30)
        self.assertGreater(len(pts), 300)
        self.assertLess(min(x for x, _ in pts), W * 0.12)
        self.assertLess(max(x for x, _ in pts), W * 0.7)

    def test_typewriter_types_more_letters_over_time(self):
        counts = [len(self.ink(self.frame("typewriter", t, text="abcdefghijkl mnopqrstuv", start=1.0, end=5.0)))
                  for t in (1.1, 1.8, 2.5, 4.0)]
        self.assertEqual(counts, sorted(counts))
        self.assertLess(counts[0], counts[-1] / 2)

    def test_pop_in_grows_from_small_to_full_size(self):
        small = self.ink(self.frame("pop_in", 1.03))
        full = self.ink(self.frame("pop_in", 2.0))
        width = lambda pts: (max(x for x, _ in pts) - min(x for x, _ in pts)) if pts else 0   # noqa: E731
        self.assertLess(width(small), width(full) * 0.9)

    def test_line_slide_settles_at_its_position_after_sliding_up(self):
        early = self.ink(self.frame("line_slide", 1.05))
        late = self.ink(self.frame("line_slide", 2.0))
        bottom = lambda pts: max(y for _x, y in pts)      # noqa: E731
        self.assertGreater(bottom(early), bottom(late))     # started lower, then rose into place
        self.assertAlmostEqual(bottom(late), H * cs.STYLES["line_slide"].y, delta=H * 0.03)

    def test_neon_glows_in_the_highlight_colour_around_white_text(self):
        img = self.frame("neon", 2.0, text="GLOW")
        cyan = self.ink(img, (0x00, 0xE5, 0xFF), 90)
        white = self.ink(img, (255, 255, 255), 25)
        self.assertGreater(len(cyan), len(white))
        self.assertGreater(len(white), 50)

    def test_outlined_draws_its_outline_in_the_highlight_colour(self):
        img = self.frame("outlined", 2.0, text="OUT")
        self.assertGreater(len(self.ink(img, (0xFF, 0x3B, 0x30), 25)), 300)

    def test_clean_is_light_text_with_a_soft_shadow_and_no_outline(self):
        img = self.frame("clean", 2.0, text="clean look")
        self.assertGreater(len(self.ink(img, (255, 255, 255), 25)), 50)
        self.assertEqual(len(self.ink(img, (255, 0, 0), 25)), 0)

    def test_tweaks_reach_the_picture(self):
        red = self.ink(self.frame("outlined", 2.0, text="OUT", highlight_color="#00FF00"), (0, 255, 0), 25)
        self.assertGreater(len(red), 300)
        low = self.frame("karaoke", 2.8, y=0.5, anchor="bottom")
        ys = [y for _x, y in self.ink(low)]
        self.assertLess(max(ys), H * 0.55)

    def test_a_caption_with_no_style_renders_as_it_always_did(self):
        d = doc()
        spec = tr.to_render_spec(d, lambda _a: None, "/tmp/unused.mp4")
        again = ass_captions.build_overlay_ass(spec.overlays, width=W, height=H)
        self.assertNotIn(r"\kf", again)
        self.assertIn(r"\pos(270,864)", again)    # bottom-centre at y = 0.9, as ever

    def test_the_whole_export_burns_a_styled_caption_in(self):
        d = doc({"preset": "karaoke"}, w=144, h=256)
        d["captions"]["cues"] = [{"id": "k1", "start_s": 0.2, "end_s": 1.6, "text": "Hello wide world"}]
        out = Path(self.tmp.name) / "export.mp4"
        tr.render(d, lambda _a: None, str(out))
        raw = subprocess.run([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(out),
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        size = 144 * 256
        frames = [raw[i:i + size] for i in range(0, len(raw), size)]
        self.assertEqual(len(frames), 48)    # 1.6 s at 30 fps
        self.assertEqual(max(frames[2]), 0)  # before the caption: black
        self.assertGreater(max(frames[30]), 100)   # the caption is burnt in


if __name__ == "__main__":
    unittest.main()
