"""Chroma key on overlays, and noise reduction / loudness normalisation of a
clip's sound (backend half).

Fields (modules/timeline.py): an overlay's ``chroma: {color, similarity?, blend?}``;
``denoise`` and ``loudnorm`` on an A clip and on a V clip that plays its sound.
By class:

* the document: the colour is a whole #RRGGBB, ranges at both ends and beyond,
  strict fields, the flags are booleans, normalisation fills the key's defaults
  and drops false flags, the JSON schema and the constants the three languages
  share;
* the argv: documents without any of it render the SAME commands as before
  (golden digests, tests/test_editor_transitions.py LEGACY); the key and the
  audio filters are pinned and sit where they should (the key before the scale,
  denoise then loudness before the gain); the colour reaches the graph only as a
  validated hex;
* the PIXELS and SAMPLES, real ffmpeg: a green-screen video with a red square
  laid over grey keeps only the square, similarity and blend change how much
  goes, a picture is keyed too, opacity and animations apply to what is left;
  a hiss under a tone drops and the tone stays, two clips of very different
  levels come out at the same loudness, and the length is the clip's.
"""

import copy
import json
import math
import re
import unittest
from pathlib import Path

from modules import render_spec as rs
from modules import timeline as tl
from modules import timeline_render as tr
from tests import test_editor_effects as fxt
from tests import test_editor_overlay as ovt
from tests import test_editor_transitions as trt

ROOT = Path(__file__).resolve().parent.parent
EDITOR_TS = ROOT / "command-center" / "lib" / "editor.ts"
BASE, PIC, VID = ovt.BASE, ovt.PIC, ovt.VID
SND = "22222222-2222-4222-8222-222222222222"


def odoc(size=(640, 360), **ov):
    o = {"id": "o1", "asset_id": PIC, "start_s": 0, "end_s": 2, "x": 0.5, "y": 0.5, "w": 0.4}
    o.update(ov)
    doc = fxt.vdoc(width=size[0], height=size[1])
    doc["overlays"] = [o]
    return doc


def problems_of(**chroma):
    return tl.validate(odoc(chroma=chroma))


def adoc(**clip):
    c = {"id": "m1", "asset_id": SND, "start_s": 0, "in_s": 0, "out_s": 2}
    c.update(clip)
    doc = fxt.vdoc()
    doc["tracks"].append({"id": "a1", "kind": "A", "clips": [c]})
    return doc


class DocumentTestCase(unittest.TestCase):
    def test_a_chroma_key_is_a_colour_with_optional_similarity_and_blend(self):
        self.assertEqual(problems_of(color="#00FF00"), [])
        self.assertEqual(problems_of(color="#00ff00", similarity=0.01, blend=0), [])
        self.assertEqual(problems_of(color="#00FF00", similarity=0.6, blend=0.5), [])
        for bad in ("green", "#0F0", "#00FF0", "#00FF000", "#GG0000", "00FF00", "#00FF00\n", "", None, 0xFF00, True,
                    ["#00FF00"]):
            self.assertTrue(any("color must be a #RRGGBB" in p for p in problems_of(color=bad)), bad)
        for k, bad in (("similarity", 0.009), ("similarity", 0.61), ("similarity", 0), ("similarity", float("nan")),
                       ("similarity", "0.2"), ("blend", -0.01), ("blend", 0.51), ("blend", None), ("blend", True)):
            self.assertTrue(any(f"{k} must be a number" in p for p in problems_of(color="#00FF00", **{k: bad})),
                            (k, bad))

    def test_the_shape_is_strict(self):
        self.assertTrue(any("color is missing" in p for p in problems_of(similarity=0.2)))
        self.assertTrue(any("tolerance is not a known field" in p
                            for p in problems_of(color="#00FF00", tolerance=0.2)))
        for bad in ("#00FF00", [], 1, None):
            self.assertTrue(any("must be an object" in p for p in tl.validate(odoc(chroma=bad))), bad)

    def test_normalise_uppercases_the_colour_and_fills_the_defaults(self):
        n = tl.normalise(odoc(chroma={"color": "#00ff00"}))["overlays"][0]["chroma"]
        self.assertEqual(n, {"color": "#00FF00", "similarity": 0.15, "blend": 0.1})
        n = tl.normalise(odoc(chroma={"color": "#0a0B0c", "similarity": 0.20004, "blend": 0}))["overlays"][0]["chroma"]
        self.assertEqual(n, {"color": "#0A0B0C", "similarity": 0.2, "blend": 0.0})
        self.assertNotIn("chroma", tl.normalise(odoc())["overlays"][0])

    def test_sound_flags_are_booleans_on_a_clips_and_v_clips(self):
        for doc_of in (lambda **k: adoc(**k), lambda **k: fxt.vdoc(**k)):
            for key in ("denoise", "loudnorm"):
                self.assertEqual(tl.validate(doc_of(**{key: True})), [])
                self.assertEqual(tl.validate(doc_of(**{key: False})), [])
                for bad in (1, 0, "true", None, [True]):
                    self.assertTrue(any(f"{key} must be true or false" in p
                                        for p in tl.validate(doc_of(**{key: bad}))), (key, bad))

    def test_normalise_drops_false_flags(self):
        for doc in (adoc(denoise=False, loudnorm=False), fxt.vdoc(denoise=False, loudnorm=False)):
            n = tl.normalise(doc)
            clip = next(c for t in n["tracks"] for c in t["clips"] if t["kind"] in ("A", "V"))
            self.assertNotIn("denoise", clip)
            self.assertNotIn("loudnorm", clip)
        n = tl.normalise(adoc(denoise=True, loudnorm=True))["tracks"][1]["clips"][0]
        self.assertTrue(n["denoise"] and n["loudnorm"])

    def test_schema_and_constants(self):
        schema = json.loads(tl.SCHEMA_PATH.read_text(encoding="utf-8"))
        defs = schema["$defs"]
        self.assertEqual(set(defs["overlay"]["properties"]), set(tl._OVERLAY_KEYS))
        self.assertEqual(set(defs["audio_clip"]["properties"]), set(tl._A_CLIP_KEYS))
        self.assertEqual(set(defs["video_clip"]["properties"]), set(tl._V_CLIP_KEYS))
        ch = defs["overlay"]["properties"]["chroma"]
        self.assertEqual(ch["required"], ["color"])
        sim, blend = ch["properties"]["similarity"], ch["properties"]["blend"]
        self.assertEqual((sim["minimum"], sim["maximum"], sim["default"]), (0.01, 0.6, 0.15))
        self.assertEqual((blend["minimum"], blend["maximum"], blend["default"]), (0, 0.5, 0.1))
        self.assertEqual((rs.CHROMA_SIMILARITY_MIN, rs.CHROMA_SIMILARITY_MAX, rs.CHROMA_SIMILARITY_DEFAULT,
                          rs.CHROMA_BLEND_MAX, rs.CHROMA_BLEND_DEFAULT),
                         (tl.CHROMA_SIMILARITY_MIN, tl.CHROMA_SIMILARITY_MAX, tl.CHROMA_SIMILARITY_DEFAULT,
                          tl.CHROMA_BLEND_MAX, tl.CHROMA_BLEND_DEFAULT))
        ts = EDITOR_TS.read_text(encoding="utf-8")
        for name in ("CHROMA_SIMILARITY_MIN", "CHROMA_SIMILARITY_MAX", "CHROMA_SIMILARITY_DEFAULT",
                     "CHROMA_BLEND_MAX", "CHROMA_BLEND_DEFAULT"):
            self.assertEqual(float(re.search(rf"export const {name} = ([\d.]+);", ts).group(1)), getattr(tl, name), name)


class SpecTestCase(unittest.TestCase):
    def test_the_key_and_the_flags_reach_the_spec_and_only_then(self):
        spec = tr.to_render_spec(odoc(chroma={"color": "#00ff00", "similarity": 0.3}), ovt.assets_table().get, "/o.mp4")
        o = spec.picture_overlays[0]
        self.assertEqual((o.chroma_color, o.chroma_similarity, o.chroma_blend), ("#00FF00", 0.3, 0.1))
        self.assertEqual(rs.RenderSpec.from_dict(spec.to_dict()), spec)
        plain = tr.to_render_spec(odoc(), ovt.assets_table().get, "/o.mp4").picture_overlays[0]
        self.assertIsNone(plain.chroma_color)
        self.assertNotIn("chroma_color", plain.to_dict())
        table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, False),
                 SND: tl.ResolvedAsset(SND, "audio", "/m/s.wav", 30.0)}
        spec = tr.to_render_spec(adoc(denoise=True, loudnorm=True), table.get, "/o.mp4")
        t = spec.audio_tracks[0]
        self.assertTrue(t.denoise and t.loudnorm)
        self.assertNotIn("denoise", tr.to_render_spec(adoc(), table.get, "/o.mp4").audio_tracks[0].to_dict())

    def test_the_own_sound_of_a_video_clip_takes_the_flags(self):
        table = {BASE: tl.ResolvedAsset(BASE, "video", "/m/a.mp4", 20.0, True)}
        spec = tr.to_render_spec(fxt.vdoc(audio=True, denoise=True), table.get, "/o.mp4")
        self.assertTrue(spec.audio_tracks[0].denoise)
        self.assertFalse(spec.audio_tracks[0].loudnorm)

    def test_a_spec_is_refused_for_what_would_not_render(self):
        base = tr.to_render_spec(odoc(chroma={"color": "#00FF00"}), ovt.assets_table().get, "/o.mp4")

        def problems(**kw):
            o = rs.PictureOverlay(**{**base.picture_overlays[0].__dict__, **kw})
            return rs.validate(rs.RenderSpec(**{**base.__dict__, "picture_overlays": [o]}))
        for kw, needle in (({"chroma_color": "green"}, "chroma colour"), ({"chroma_color": "#00FF00;movie=x"}, "chroma colour"),
                           ({"chroma_similarity": 0.9}, "chroma similarity"), ({"chroma_blend": 0.9}, "chroma blend"),
                           ({"chroma_blend": float("nan")}, "chroma blend")):
            self.assertTrue(any(needle in p for p in problems(**kw)), kw)


def graph_of(**kw):
    o = rs.PictureOverlay("/m/p.png", "image", 1.0, 3.0, 0.5, 0.5, 0.4, 1.0, **kw)
    spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")], frame_exact=True,
                         picture_overlays=[o])
    return rs.picture_overlay_filters(spec, 1, "[0:v]")[0]


class CommandTestCase(unittest.TestCase):
    def test_the_key_is_applied_to_the_source_before_it_is_scaled(self):
        # a picture: the key's alpha is multiplied by the picture's own (chromakey would overwrite
        # it), and merged back onto the colours before the picture is scaled
        g = graph_of(chroma_color="#00FF00", chroma_similarity=0.25, chroma_blend=0.05)
        self.assertEqual(g[0], "[1:v]trim=end_frame=1,setpts=PTS-STARTPTS,fps=30,format=rgba,split=3[ca0][cb0][cc0]")
        self.assertEqual(g[1], "[ca0]chromakey=color=0x00FF00:similarity=0.250:blend=0.050,format=yuva420p,"
                               "alphaextract[ka0]")
        self.assertEqual(g[2], "[cb0]alphaextract[oa0]")
        self.assertEqual(g[3], "[ka0][oa0]blend=all_mode=multiply,format=gray[ma0]")
        self.assertTrue(g[4].startswith("[cc0][ma0]alphamerge,scale="), g[4])
        self.assertIn(",format=rgba,scale=out_color_matrix=bt709", g[4], "the alpha survives to the blend")
        self.assertIn("tpad=stop=", g[4])
        self.assertEqual(" ".join(g).count("chromakey"), 1)

    def test_a_video_overlay_and_an_opacity_keep_the_key_first(self):
        o = rs.PictureOverlay("/m/v.mp4", "video", 1.0, 3.0, 0.5, 0.5, 0.4, 0.6, chroma_color="#112233",
                              chroma_similarity=0.15, chroma_blend=0.1)
        spec = rs.RenderSpec("/o.mp4", 1280, 720, 30, segments=[rs.Segment(4, "/m/b.mp4")], frame_exact=True,
                             picture_overlays=[o])
        g = rs.picture_overlay_filters(spec, 1, "[0:v]")[0][0]
        self.assertIn("fps=30,chromakey=color=0x112233:similarity=0.150:blend=0.100,scale=", g)
        self.assertIn("colorchannelmixer=aa=0.600", g)
        self.assertLess(g.index("chromakey"), g.index("colorchannelmixer"))

    def test_without_a_key_the_graph_is_the_one_it_was(self):
        self.assertNotIn("chromakey", " ".join(graph_of()))
        self.assertEqual(graph_of()[0], graph_of(anim_in=None)[0])

    def test_the_colour_reaches_the_graph_only_as_a_validated_hex(self):
        for bad in ("green", "#GGGGGG", "0x00FF00", "#00FF00:similarity=1", "x';movie=/etc/passwd"):
            with self.assertRaises(ValueError):
                graph_of(chroma_color=bad)
        g = " ".join(graph_of(chroma_color="#aabbcc"))
        self.assertIn("color=0xAABBCC", g)
        self.assertNotIn("/m/p.png", g)

    def test_the_audio_filters_come_in_order_before_the_gain(self):
        t = rs.AudioTrack("/a.wav", 4.0, gain_db=-3.0, fade_in_s=0.5, speed=2.0, denoise=True, loudnorm=True)
        self.assertEqual(
            rs.audio_track_filter(t, 1, "a0"),
            "[1:a]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,atempo=2.000,"
            "afftdn=nr=12:nf=-40:tn=1:tr=1,loudnorm=I=-16:TP=-1.5:LRA=11,"
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=-3.000dB,"
            "afade=t=in:st=0:d=0.500[a0]")
        only = rs.audio_track_filter(rs.AudioTrack("/a.wav", 4.0, loudnorm=True), 1, "a0")
        self.assertNotIn("afftdn", only)
        self.assertIn("loudnorm=I=-16:TP=-1.5:LRA=11,aformat=", only)
        off = rs.audio_track_filter(rs.AudioTrack("/a.wav", 4.0), 1, "a0")
        self.assertNotIn("afftdn", off)
        self.assertNotIn("loudnorm", off)

    def test_ducking_and_the_mix_are_unchanged(self):
        music = rs.AudioTrack("/a.wav", 4.0, denoise=True, duck_db=12.0, duck_attack_s=0.3, duck_release_s=0.8,
                              duck_spans=((1.0, 2.0),))
        spec = rs.RenderSpec("/o.mp4", 640, 360, 30, segments=[rs.Segment(4, "/m/b.mp4")], frame_exact=True,
                             audio_tracks=[music])
        cmd = rs.build_ffmpeg_command(spec, "/w/c.txt", "/w/o.ass")
        g = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("afftdn=nr=12", g)
        self.assertIn("volume=volume='", g)
        self.assertIn("amix=inputs=1:duration=longest:normalize=0", g)


class NeutralTestCase(unittest.TestCase):
    def test_every_older_document_renders_the_commands_it_always_did(self):
        for name, doc in trt.neutral_docs().items():
            with self.subTest(name):
                self.assertEqual(trt.digest(doc), trt.LEGACY[name])

    def test_flags_switched_off_change_nothing(self):
        for name, doc in trt.neutral_docs().items():
            doc2 = copy.deepcopy(doc)
            for t in doc2["tracks"]:
                if t["kind"] in ("V", "A"):
                    for c in t["clips"]:
                        c.update(denoise=False, loudnorm=False)
            with self.subTest(name):
                self.assertEqual(trt.digest(doc2), trt.LEGACY[name])


# ── real ffmpeg ─────────────────────────────────────────────────────────────

def png_with_square(w, h, bg, sq, edge=0):
    """A w x h PNG: ``bg`` everywhere but a centred ``sq`` square of the ``edge``-wide band."""
    x0, x1, y0, y1 = w // 4, 3 * w // 4, h // 4, 3 * h // 4

    def row(y):
        out = bytearray()
        for x in range(w):
            inside = x0 <= x < x1 and y0 <= y < y1
            out += bytes((*(sq if inside else bg), 255))
        return bytes(out)
    return ovt.png_rgba(w, h, row)


class _Real(fxt._Real):
    def table(self):
        return {BASE: self.source("g", "color=c=0x808080")}


class ChromaRenderTestCase(_Real):
    def keyed(self, **chroma):
        return self.export(odoc((self.W, self.H), chroma=chroma, w=0.5), self.tables)

    def setUp(self):
        super().setUp()
        self.tables = self.table()
        # a green-screen video with a red square in the middle (video overlay)
        path = self.dir / "gs.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", "color=c=0x00C800:s=160x90:r=30:d=2",
                        "-f", "lavfi", "-i", "color=c=0xE02020:s=80x45:r=30:d=2",
                        "-filter_complex", "[0][1]overlay=40:22", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-crf", "10", str(path))
        self.tables[VID] = tl.ResolvedAsset(VID, "video", str(path), 2.0, False)
        self.tables[PIC] = self.png("gs", png_with_square(160, 90, (0, 200, 0), (224, 32, 32)))

    def render(self, asset=VID, size=None, **kw):
        ov = {"asset_id": asset, "w": 0.5}
        ov.update(kw)
        return self.export(odoc((self.W, self.H), **ov), self.tables)

    def probe(self, out, n=10):
        raw = self.frames(out, (self.W, self.H), [n], "bt601")[n]
        # overlay 160 wide in a 320 frame, centred: x 80..240, y 45..135 (90 px tall)
        return {"corner": self.px(raw, self.W, 90, 55), "square": self.px(raw, self.W, 160, 90),
                "outside": self.px(raw, self.W, 20, 20)}

    def test_without_a_key_the_green_stays(self):
        p = self.probe(self.render())
        self.assertGreater(p["corner"][1], 150, p)
        self.assertLess(p["corner"][0], 60, p)

    def test_the_green_goes_and_the_square_stays_for_video_and_picture(self):
        for asset in (VID, PIC):
            with self.subTest(asset):
                p = self.probe(self.render(asset=asset, chroma={"color": "#00C800", "similarity": 0.2, "blend": 0.05}))
                for k in ("corner", "outside"):
                    self.assertLess(max(abs(c - 128) for c in p[k]), 24, (k, p))   # the grey base shows
                self.assertGreater(p["square"][0], 190, p)
                self.assertLess(p["square"][1], 90, p)

    def test_a_pictures_own_transparency_survives_the_key(self):
        # left half fully transparent red, right half opaque red; green key matches nothing in it.
        # chromakey alone made the left half opaque (it writes the alpha): the base must show there.
        path = self.dir / "half.png"
        self.run_ffmpeg("-f", "lavfi", "-i", "color=c=0xE02020:s=160x90,format=rgba", "-vf",
                        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),0,255)'", "-frames:v", "1", str(path))
        self.tables[PIC] = tl.ResolvedAsset(PIC, "image", str(path))
        for chroma in (None, {"color": "#00C800", "similarity": 0.2, "blend": 0.05}):
            with self.subTest(chroma=chroma):
                kw = {"asset_id": PIC, "w": 0.5}
                if chroma:
                    kw["chroma"] = chroma
                raw = self.frames(self.export(odoc((self.W, self.H), **kw), self.tables),
                                  (self.W, self.H), [10], "bt601")[10]
                left, right = self.px(raw, self.W, 100, 90), self.px(raw, self.W, 220, 90)
                self.assertLess(max(abs(c - 128) for c in left), 24, left)    # transparent: the grey base
                self.assertGreater(right[0], 190, right)                         # opaque: the red stays

    def test_a_key_of_another_colour_takes_nothing_and_a_wide_one_takes_more(self):
        p = self.probe(self.render(chroma={"color": "#0000FF", "similarity": 0.1, "blend": 0}))
        self.assertGreater(p["corner"][1], 150, "blue is not near green")
        far = self.probe(self.render(chroma={"color": "#00FF00", "similarity": 0.01, "blend": 0}))
        wide = self.probe(self.render(chroma={"color": "#00FF00", "similarity": 0.4, "blend": 0}))
        self.assertGreater(far["corner"][1], 150, "0xC8 green is not within 0.01 of 0xFF green")
        self.assertLess(max(abs(c - 128) for c in wide["corner"]), 24, "but is within 0.4")

    def test_the_opacity_and_an_animation_apply_to_what_is_left(self):
        p = self.probe(self.render(chroma={"color": "#00C800", "similarity": 0.2, "blend": 0.05}, opacity=0.5))
        self.assertAlmostEqual(p["square"][0], 128 + 0.5 * (224 - 128), delta=14)
        self.assertLess(max(abs(c - 128) for c in p["corner"]), 24)
        out = self.render(chroma={"color": "#00C800", "similarity": 0.2, "blend": 0.05}, anim_in="fade", anim_in_s=1.0)
        early = self.probe(out, 5)
        late = self.probe(out, 50)
        self.assertLess(early["square"][0], late["square"][0] - 20)


class AudioRenderTestCase(_Real):
    def audio_asset(self, name, expr, seconds=6):
        path = self.dir / f"{name}.wav"
        self.run_ffmpeg("-f", "lavfi", "-i", expr, str(path))
        return tl.ResolvedAsset(SND, "audio", str(path), float(seconds))

    def render_sound(self, asset, **flags):
        doc = adoc(out_s=6, **flags)
        doc["tracks"][0]["clips"][0]["out_s"] = 6
        out = self.export(doc, {BASE: self.source("g", "color=c=0x808080", seconds=6), SND: asset})
        raw = self.run_ffmpeg("-i", str(out), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "-")
        return [int.from_bytes(raw[i:i + 2], "little", signed=True) / 32768 for i in range(0, len(raw) - 1, 2)]

    @staticmethod
    def db(xs):
        return 20 * math.log10(math.sqrt(sum(x * x for x in xs) / len(xs)) + 1e-9)

    def test_a_quiet_hiss_drops_and_the_tone_beside_it_stays(self):
        path = self.dir / "mix.wav"
        self.run_ffmpeg("-f", "lavfi", "-i", "sine=frequency=1000:duration=3:sample_rate=48000,volume=-6dB,apad=whole_dur=6",
                        "-f", "lavfi", "-i", "anoisesrc=d=6:c=white:a=0.02:r=48000",
                        "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-ac", "1", str(path))
        asset = tl.ResolvedAsset(SND, "audio", str(path), 6.0)
        plain = self.render_sound(asset)
        clean = self.render_sound(asset, denoise=True)
        n = len(plain)
        hiss = lambda xs: self.db(xs[int(n * 0.65):int(n * 0.95)])
        tone = lambda xs: self.db(xs[int(n * 0.1):int(n * 0.4)])
        self.assertLess(hiss(clean), hiss(plain) - 10, (hiss(plain), hiss(clean)))
        self.assertLess(abs(tone(clean) - tone(plain)), 1.5, (tone(plain), tone(clean)))
        self.assertAlmostEqual(len(clean) / 16000, 6.0, delta=0.1)

    def test_loudnorm_brings_a_quiet_and_a_loud_clip_to_the_same_level(self):
        quiet = self.audio_asset("quiet", "sine=frequency=440:duration=6:sample_rate=48000,volume=-30dB")
        loud = self.audio_asset("loud", "sine=frequency=440:duration=6:sample_rate=48000,volume=-3dB")
        levels = {}
        for name, asset in (("quiet", quiet), ("loud", loud)):
            raw, norm = self.render_sound(asset), self.render_sound(asset, loudnorm=True)
            levels[name] = (self.db(raw), self.db(norm))
            self.assertAlmostEqual(len(norm) / 16000, 6.0, delta=0.1)
        self.assertGreater(abs(levels["quiet"][0] - levels["loud"][0]), 20)
        self.assertLess(abs(levels["quiet"][1] - levels["loud"][1]), 2.0, levels)
        self.assertLess(max(levels["quiet"][1], levels["loud"][1]), -10)

    def test_both_together_and_with_gain_and_a_fade(self):
        asset = self.audio_asset("tone", "sine=frequency=440:duration=6:sample_rate=48000,volume=-20dB")
        out = self.render_sound(asset, denoise=True, loudnorm=True, gain_db=-6, fade_out_s=1.0)
        n = len(out)
        self.assertLess(abs(self.db(out[n // 3: n // 2]) - (-18.3 - 6)), 3.0)
        self.assertLess(self.db(out[-1500:]), self.db(out[n // 3: n // 2]) - 10, "the fade-out is still there")

    def test_a_video_clips_own_sound_takes_the_flags(self):
        path = self.dir / "talk.mp4"
        self.run_ffmpeg("-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=4", "-f", "lavfi", "-i",
                        "sine=frequency=440:duration=4:sample_rate=48000,volume=-30dB", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", str(path))
        asset = tl.ResolvedAsset(BASE, "video", str(path), 4.0, True)
        out = {}
        for flag in (False, True):
            doc = fxt.vdoc(width=320, height=180, out_s=4, audio=True, **({"loudnorm": True} if flag else {}))
            f = self.export(doc, {BASE: asset})
            raw = self.run_ffmpeg("-i", str(f), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "-")
            xs = [int.from_bytes(raw[i:i + 2], "little", signed=True) / 32768 for i in range(0, len(raw) - 1, 2)]
            out[flag] = self.db(xs[8000:-8000])
        self.assertGreater(out[True], out[False] + 15, out)


if __name__ == "__main__":
    unittest.main()
