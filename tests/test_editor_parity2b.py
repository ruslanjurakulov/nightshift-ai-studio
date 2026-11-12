"""Editor parity 2b (backend half): the effects pack (``fx``: glitch, shake, rgb_split, flash, 0..100) and a video
clip's entrance / exit (``anim_in`` / ``anim_out``: fade, slides, zoom).

* the document: closed names and ranges in modules/timeline.py, the same in render_spec, the schema and
  lib/editor.ts; normalise drops an effect at 0 and fills an animation's length; a split keeps the way in on the
  first half and the way out on the second, each held to half its piece;
* the render budget: per second of the clip, scaled by pixels x rate, with colour and masks; above 1440p a
  cross-faded clip takes at most one effect (measured: out of memory with all four on both sides);
* old documents: one with every 2a field but none of these builds exactly the argv origin/main built
  (samples/parity2b_argv_golden.json);
* a seeded fuzz corpus (samples/timeline_parity2b_fuzz.json) that lib/editor.ts judges too;
* real ffmpeg (render_backend.resolve_ffmpeg; frames counted with it, no ffprobe) with pixel sampling.
"""

import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from modules import render_backend as rb
from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import parity2b_argv_docs as golden_docs
from tests.parity2_argv_docs import argv

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "samples" / "timeline_parity2b_fuzz.json"
B = "11111111-1111-4111-8111-111111111111"
SEED = 20261112


def vdoc(width=320, height=180, fps=30, out_s=2.0, **clip):
    c = {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": out_s}
    c.update(clip)
    return {"version": 1, "width": width, "height": height, "fps": fps, "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}


def problems(**clip):
    return tl.validate(vdoc(**clip))


class FxDocumentTestCase(unittest.TestCase):
    def test_each_effect_is_0_to_100_and_the_names_are_closed(self):
        for k in tl.FX_NAMES:
            for ok in (0.5, 50, 100):
                self.assertEqual(problems(fx={k: ok}), [], (k, ok))
            for bad in (-0.001, 100.001, "5", None, True, float("nan")):
                self.assertTrue(any(f"fx: {k} must be a number" in p for p in problems(fx={k: bad})), (k, bad))
        self.assertTrue(any("give at least one" in p for p in problems(fx={})))
        self.assertTrue(problems(fx={"blur": 3}))
        self.assertTrue(problems(fx=[1]))

    def test_normalise_drops_zero_and_an_empty_pack(self):
        c = tl.normalise(vdoc(fx={"glitch": 0, "flash": 30.0004}))["tracks"][0]["clips"][0]
        self.assertEqual(c["fx"], {"flash": 30.0})
        self.assertEqual(tl.normalise(vdoc(fx={"shake": 0})), tl.normalise(vdoc()))


class AnimDocumentTestCase(unittest.TestCase):
    def test_names_lengths_and_half_the_clip(self):
        for a in tl.V_ANIMS:
            self.assertEqual(problems(anim_in=a, anim_out=a, anim_in_s=1, anim_out_s=1), [], a)
        self.assertTrue(any("anim_in must be one of" in p for p in problems(anim_in="pop")))
        self.assertTrue(any("anim_in must be one of" in p for p in problems(anim_in="typewriter")))
        self.assertTrue(any("more than half the clip" in p for p in problems(anim_in="zoom", anim_in_s=1.001)))
        self.assertTrue(any("more than half the clip" in p for p in problems(out_s=0.6, anim_out="fade")))
        self.assertTrue(any("needs anim_in" in p for p in problems(anim_in_s=0.5)))
        for bad in (0.099, 2.001):
            self.assertTrue(problems(out_s=10, anim_in="fade", anim_in_s=bad), bad)
        self.assertTrue(any("cannot both be set" in p for p in problems(anim_in="slide-up", fade_in_s=0.2)))
        self.assertEqual(problems(anim_in="slide-up", fade_out_s=0.2), [])     # the other side keeps its fade
        # at 2x the clip is half as long on the timeline
        self.assertTrue(problems(out_s=2, speed=2, anim_in="zoom", anim_in_s=0.6))

    def test_normalise_fills_the_length_and_a_split_keeps_each_side_on_its_half(self):
        c = tl.normalise(vdoc(anim_in="zoom"))["tracks"][0]["clips"][0]
        self.assertEqual(c["anim_in_s"], tl.ANIM_DEFAULT_S)
        d = tl.normalise(vdoc(out_s=4, anim_in="slide-left", anim_in_s=1.5, anim_out="zoom", anim_out_s=1.5))
        d = tl.split_clip(d, "c1", 1.0, "c2")
        a, b = d["tracks"][0]["clips"]
        self.assertEqual((a.get("anim_in"), a.get("anim_in_s"), a.get("anim_out")), ("slide-left", 0.5, None))
        self.assertEqual((b.get("anim_in"), b.get("anim_out"), b.get("anim_out_s")), (None, "zoom", 1.5))
        self.assertEqual(tl.validate(d), [])
        d = tl.split_clip(tl.normalise(vdoc(out_s=4, anim_out="fade")), "c1", 3.85, "c2")
        self.assertNotIn("anim_out", d["tracks"][0]["clips"][1])     # 0.15 s left: half is under 0.1 s
        self.assertEqual(tl.validate(d), [])


class TwinsAndBudgetTestCase(unittest.TestCase):
    def test_render_spec_the_schema_and_the_editor_agree(self):
        for name in ("FX_NAMES", "FX_MAX", "V_ANIMS"):
            self.assertEqual(getattr(rs, name), getattr(tl, name), name)
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))["$defs"]["video_clip"]["properties"]
        self.assertEqual(set(schema["fx"]["properties"]), set(tl.FX_NAMES))
        self.assertEqual(schema["anim_in"]["enum"], list(tl.V_ANIMS))
        self.assertEqual(schema["anim_out"]["enum"], list(tl.V_ANIMS))
        ts = (ROOT / "command-center" / "lib" / "editor.ts").read_text(encoding="utf-8")
        self.assertIn("export const FX_SECONDS_PER_S: Record<FxName, number> = { "
                      + ", ".join(f"{k}: {v:g}" for k, v in tl.FX_SECONDS_PER_S.items()) + " };", ts)
        for name in ("FX_MAX", "FX_LARGE_XFADE_MAX", "ANIM_MOVE_SECONDS_PER_S"):
            self.assertIn(f"export const {name} = {getattr(tl, name):g};", ts, name)
        self.assertIn("export const V_ANIMS = [" + ", ".join(f'"{a}"' for a in tl.V_ANIMS) + "] as const;", ts)

    def test_effects_and_moves_are_charged_and_named(self):
        per = sum(tl.FX_SECONDS_PER_S.values()) + tl.ANIM_MOVE_SECONDS_PER_S
        c = {"in_s": 0, "out_s": 10, "fx": {k: 50 for k in tl.FX_NAMES}, "anim_in": "slide-up"}
        self.assertAlmostEqual(tl.look_seconds(c, 30, 1920, 1080), 10 * per)
        self.assertAlmostEqual(tl.look_seconds({**c, "anim_in": "fade"}, 30, 1920, 1080), 10 * sum(tl.FX_SECONDS_PER_S.values()))
        got = tl.validate(vdoc(width=3840, height=2160, fps=60, out_s=300, fx={"rgb_split": 10}))
        self.assertTrue(any("colour, masks and effects would take about" in p for p in got), got)
        self.assertEqual(tl.validate(vdoc(width=1920, height=1080, fps=30, out_s=600, fx={k: 100 for k in tl.FX_NAMES},
                                          anim_in="zoom", anim_out="slide-left")), [])

    def test_above_1440p_a_cross_faded_clip_takes_one_effect(self):
        def two(w, h, fx_a, fx_b):
            d = vdoc(width=w, height=h, out_s=3, fx=fx_a)
            d["tracks"][0]["clips"].append({"id": "c2", "asset_id": B, "start_s": 2.5, "in_s": 0, "out_s": 3, "fx": fx_b,
                                             "transition": {"type": "crossfade", "duration_s": 0.5}})
            return d
        self.assertEqual(tl.validate(two(3840, 2160, {"shake": 100}, {"glitch": 100})), [])
        got = tl.validate(two(3840, 2160, {"shake": 100, "flash": 5}, {"glitch": 100}))
        self.assertTrue(any("takes at most 1 effect" in p for p in got), got)
        self.assertEqual(tl.validate(two(2560, 1440, {k: 100 for k in tl.FX_NAMES}, {k: 100 for k in tl.FX_NAMES})), [])
        # a single clip above 1440p takes all four (measured)
        self.assertEqual(tl.validate(vdoc(width=3840, height=2160, fx={k: 100 for k in tl.FX_NAMES})), [])

    def test_both_sides_of_a_cross_fade_animate_with_their_own_labels(self):
        d = vdoc(out_s=2, anim_in="zoom")
        d["tracks"][0]["clips"].append({"id": "c2", "asset_id": B, "start_s": 1.5, "in_s": 0, "out_s": 2, "anim_out": "zoom",
                                        "transition": {"type": "crossfade", "duration_s": 0.5}})
        spec = tr.to_render_spec(d, lambda a: tl.ResolvedAsset(a, "video", "/m/a.mp4", 4.0, False), "/w/o.mp4")
        seg = [s for s in spec.segments if s.xfade is not None][0]
        graph = rb.segment_commands("ffmpeg", seg, Path("/w/s.mp4"), 320, 180, 30, frame_exact=True)[0]
        graph = graph[graph.index("-filter_complex") + 1]
        for label in ("[aqa]", "[aba]", "[aqb]", "[abb]"):
            self.assertEqual(graph.count(label), 2, label)     # made once, used once
        self.assertNotIn("[aq]", graph)

    def test_only_listed_names_and_numbers_reach_the_graph(self):
        self.assertTrue(rs._effects_problems("s", rs.ClipEffects(glitch=101)))
        seg = rs.Segment(duration=1.0, path="/m/a.mp4", anim_in="spin", anim_in_s=0.4)
        self.assertTrue(rs._segment_problems("s", seg, True))
        seg = rs.Segment(duration=1.0, path="/m/a.mp4", anim_in="zoom", anim_in_s=0.05)
        self.assertTrue(rs._segment_problems("s", seg, True))
        self.assertEqual(rb.fx_filters(rs.ClipEffects(), 320, 180), [])
        self.assertEqual(rb.anim_filters(rs.Segment(duration=1.0, path="/a"), 1.0, 320, 180, 30), "")


class OldDocumentsTestCase(unittest.TestCase):
    def test_documents_without_the_new_fields_build_the_argv_main_built(self):
        golden = json.loads((ROOT / "samples" / "parity2b_argv_golden.json").read_text(encoding="utf-8"))
        docs = golden_docs.docs()
        self.assertEqual(set(golden), set(docs))
        for name, d in docs.items():
            with self.subTest(name):
                self.assertEqual(argv(d), golden[name])


# ── the fuzz corpus both validators judge ───────────────────────────────────

def _num(rng, lo, hi):
    if rng.random() < 0.85:
        return rng.choice([lo, hi, round(rng.uniform(lo, hi), 3)])
    return rng.choice([round(lo - rng.choice([0.001, 1]), 3), round(hi + rng.choice([0.001, 1]), 3), "5", None, True])


def random_doc(rng):
    w, h, fps = rng.choice([(1280, 720, 30), (1920, 1080, 60), (3840, 2160, 60), (1080, 1920, 25)])
    clips, start = [], 0.0
    for i in range(rng.randint(1, 3)):
        length = rng.choice([0.5, 2.0, 30.0, 300.0])
        c = {"id": f"c{i}", "asset_id": B, "start_s": start, "in_s": 0, "out_s": length}
        if rng.random() < 0.7:
            fx = {k: _num(rng, 0, 100) for k in tl.FX_NAMES if rng.random() < 0.4}
            if rng.random() < 0.05:
                fx["blur"] = 1
            c["fx"] = fx
        for side in ("in", "out"):
            if rng.random() < 0.5:
                c[f"anim_{side}"] = rng.choice(list(tl.V_ANIMS) * 3 + ["pop", ""])
                if rng.random() < 0.6:
                    c[f"anim_{side}_s"] = _num(rng, 0.1, 2.0)
            elif rng.random() < 0.05:
                c[f"anim_{side}_s"] = 0.5
            if rng.random() < 0.1:
                c[f"fade_{side}_s"] = 0.2
        if i and rng.random() < 0.4:
            c["transition"] = {"type": "crossfade", "duration_s": 0.2}
            c["start_s"] = round(start - 0.2, 3)
        clips.append(c)
        start = tl.clip_end_s(c) if isinstance(c.get("out_s"), (int, float)) else start + length
    return {"version": 1, "width": w, "height": h, "fps": fps, "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}


def corpus():
    rng = random.Random(SEED)
    return [{"valid": tl.validate(d) == [], "doc": d} for d in (random_doc(rng) for _ in range(400))]


class FuzzCorpusTestCase(unittest.TestCase):
    def test_the_corpus_is_current_and_holds_both_verdicts(self):
        stored = json.loads(CORPUS.read_text(encoding="utf-8"))
        self.assertEqual(stored["seed"], SEED)
        self.assertEqual(stored["cases"], corpus(), "regenerate: python3 -m tests.test_editor_parity2b --write")
        valid = sum(c["valid"] for c in stored["cases"])
        self.assertGreater(valid, 60)
        self.assertGreater(400 - valid, 60)

    def test_every_valid_one_normalises_valid_and_builds_a_spec_and_its_commands(self):
        res = lambda a: tl.ResolvedAsset(a, "video", "/m/a.mp4", 1000.0, False)
        for c in corpus():
            if not c["valid"]:
                continue
            self.assertEqual(tl.validate(tl.normalise(c["doc"])), [])
            spec = tr.to_render_spec(c["doc"], res, "/w/o.mp4")
            self.assertEqual(rs.validate(spec), [])
            for i, seg in enumerate(spec.segments):
                rb.segment_commands("ffmpeg", seg, Path(f"/w/s{i}.mp4"), spec.width, spec.height, spec.fps,
                                    frame_exact=True)


# ── real renders ─────────────────────────────────────────────────────────────

def _ffmpeg():
    try:
        exe = rb.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


class RealRenderTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = _ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("ffmpeg not available")
        cls.tmp = tempfile.TemporaryDirectory()
        cls.src = Path(cls.tmp.name) / "g.mp4"
        # grey with a white bar in the middle third: an edge for the RGB split and the shake to move
        subprocess.run([cls.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=30:d=4",
                        "-vf", "drawbox=x=150:y=0:w=20:h=180:color=white:t=fill", "-c:v", "libx264", "-pix_fmt",
                        "yuv420p", str(cls.src)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def render(self, doc):
        res = lambda a: tl.ResolvedAsset(a, "video", str(self.src), 4.0, False)
        out = Path(self.tmp.name) / f"o{abs(hash(json.dumps(doc, sort_keys=True)))}.mp4"
        tr.render(doc, res, str(out))
        return out

    def rgb(self, path, pts, t):
        raw = subprocess.run([self.ffmpeg, "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f",
                              "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        return [tuple(raw[(y * 320 + x) * 3:(y * 320 + x) * 3 + 3]) for x, y in pts]

    def frames(self, path):
        from modules import scene_remotion
        n = scene_remotion.count_frames(self.ffmpeg, path)
        self.assertIsNotNone(n)
        return n

    def test_rgb_split_puts_red_and_blue_either_side_of_an_edge(self):
        out = self.render(vdoc(fx={"rgb_split": 100}))
        left, right = self.rgb(out, [(147, 90), (172, 90)], 0.5)      # just outside the white bar, 4 px shift
        self.assertGreater(left[0] - left[2], 60)       # the red plane moved left (onto the grey left of the bar)
        self.assertGreater(right[2] - right[0], 60)     # ... and the blue one right
        plain = self.rgb(self.render(vdoc()), [(147, 90), (172, 90)], 0.5)
        self.assertTrue(all(abs(v - 128) <= 3 for p in plain for v in p), plain)
        self.assertEqual(self.frames(out), 60)

    def test_flash_brightens_at_the_start_of_each_beat_and_glitch_only_in_bursts(self):
        out = self.render(vdoc(out_s=2, fx={"flash": 100}))
        lit, rest = self.rgb(out, [(40, 40)], 0.0)[0], self.rgb(out, [(40, 40)], 0.5)[0]
        self.assertGreater(lit[1], rest[1] + 60)
        self.assertLessEqual(abs(rest[1] - 128), 3)
        out = self.render(vdoc(out_s=2, fx={"glitch": 100}))
        calm = self.rgb(out, [(172, 90)], 0.5)[0]
        burst = self.rgb(out, [(172, 90)], 0.9)[0]       # a burst starts every 0.9 s
        self.assertLessEqual(max(abs(v - 128) for v in calm), 3)
        self.assertGreater(max(abs(v - 128) for v in burst), 20)

    def test_shake_moves_the_picture(self):
        out = self.render(vdoc(out_s=2, fx={"shake": 100}))
        xs = []
        for t in (0.0, 0.03, 0.07):
            row = [p[0] for p in self.rgb(out, [(x, 90) for x in range(100, 220)], t)]
            xs.append(row.index(max(row)))
        self.assertGreater(max(xs) - min(xs), 2, xs)

    def test_slides_zoom_and_fade_move_the_picture_over_black(self):
        out = self.render(vdoc(out_s=2, anim_in="slide-left", anim_in_s=1, anim_out="zoom", anim_out_s=1))
        left, right = self.rgb(out, [(40, 90), (300, 90)], 0.5)     # half way in from the right
        self.assertLess(max(left), 10)
        self.assertLessEqual(abs(right[1] - 128), 4)
        corner, middle = self.rgb(out, [(4, 4), (100, 90)], 1.95)   # nearly 60 % at the end of the zoom out
        self.assertLess(max(corner), 10)
        self.assertLessEqual(abs(middle[1] - 128), 4)
        out = self.render(vdoc(out_s=2, anim_in="fade", anim_in_s=1))
        self.assertLess(self.rgb(out, [(40, 90)], 0.0)[0][1], 20)
        self.assertLessEqual(abs(self.rgb(out, [(40, 90)], 1.5)[0][1] - 128), 3)

    def test_a_cross_fade_with_effects_animations_and_a_mask_renders_every_frame(self):
        d = vdoc(out_s=2, anim_in="slide-up", fx={"shake": 50}, mask={"shape": "ellipse"})
        d["tracks"][0]["clips"].append({"id": "c2", "asset_id": B, "start_s": 1.5, "in_s": 0, "out_s": 2,
                                        "transition": {"type": "crossfade", "duration_s": 0.5}, "anim_out": "zoom",
                                        "anim_out_s": 0.8, "fx": {"flash": 50}})
        self.assertEqual(tl.validate(d), [])
        out = self.render(d)
        self.assertEqual(self.frames(out), 105)
        self.assertLess(max(self.rgb(out, [(100, 20)], 0.1)[0]), 10)    # the slide up: the top is still black


if __name__ == "__main__":
    if "--write" in sys.argv:
        CORPUS.write_text(json.dumps({"_comment": "Seeded documents with fx / anim fields and modules/timeline.py's "
                                      "verdict; tests/test_editor_parity2b.py keeps it current and "
                                      "command-center/tests/editor-parity2b.test.ts judges each with lib/editor.ts.",
                                      "seed": SEED, "cases": corpus()}, ensure_ascii=False) + "\n", encoding="utf-8")
        print("written", CORPUS)
    else:
        unittest.main()
