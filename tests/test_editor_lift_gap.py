"""The editor's "Lift" (command-center/lib/editorRange.ts ``liftRange``) leaves a GAP on the picture lane: the clips
after it keep their ``start_s`` and nothing sits in the range, and every sound is cut out of it. Both validators
accept a gap, and the export renders one as black (timeline_render ``_picture``: a colour segment, nothing decoded,
nothing charged, no frame-size rule) with no sound. Nothing in the render changed for it; this holds the render to
what the editor promises, through the real export path, at real sizes: 1920x1080, a 9:16 1080x1920 (the shape a
multi-ratio export renders) and 3840x2160.

* the gap is black in every corner and the middle, and silent;
* the clips after it start exactly where they did (the frame count is the timeline's), and are seen and heard.
"""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend as rb
from modules import timeline as tl
from modules import timeline_render as tr

V = "11111111-1111-4111-8111-111111111111"
S = "44444444-4444-4444-8444-444444444444"


def lifted(width, height):
    """1 s of the grey video, a 1 s gap, 1 s more, and a tone cut out of the gap: what a lift of 1..2 s leaves. The
    clips fill the frame (cover), so a frame of any shape is grey edge to edge outside the gap."""
    clips = [
        {"id": "c1", "asset_id": V, "start_s": 0, "in_s": 0, "out_s": 1, "speed": 1, "audio": False, "fit": "cover"},
        {"id": "c2", "asset_id": V, "start_s": 2, "in_s": 2, "out_s": 3, "speed": 1, "audio": False, "fit": "cover"},
    ]
    tone = lambda cid, start, a, b: {"id": cid, "asset_id": S, "start_s": start, "in_s": a, "out_s": b,
                                     "gain_db": 0, "fade_in_s": 0, "fade_out_s": 0}
    return {"version": 1, "width": width, "height": height, "fps": 30, "tracks": [
        {"id": "v1", "kind": "V", "clips": clips},
        {"id": "a1", "kind": "A", "clips": [tone("m1", 0, 0, 1)]},
        {"id": "a2", "kind": "A", "clips": [tone("m2", 2, 2, 3)]},
    ]}


def _ffmpeg():
    try:
        exe = rb.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


class LiftGapRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = _ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("ffmpeg not available")
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.grey = d / "grey.mp4"
        subprocess.run([cls.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=640x360:r=30:d=4",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.grey)], check=True)
        cls.tone = d / "tone.wav"
        subprocess.run([cls.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                        str(cls.tone)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def resolver(self, aid):
        if aid == V:
            return tl.ResolvedAsset(aid, "video", str(self.grey), 4.0, False)
        return tl.ResolvedAsset(aid, "audio", str(self.tone), 4.0, True)

    def frame(self, path, t, w, h):
        raw = subprocess.run([self.ffmpeg, "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f",
                              "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        pts = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, h // 2)]
        return [tuple(raw[(y * w + x) * 3:(y * w + x) * 3 + 3]) for x, y in pts]

    def loudest_db(self, path, start, length):
        out = subprocess.run([self.ffmpeg, "-hide_banner", "-ss", str(start), "-t", str(length), "-i", str(path), "-vn",
                              "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
        line = [ln for ln in out.splitlines() if "max_volume" in ln][0]
        return float(line.split("max_volume:")[1].split("dB")[0])

    def check(self, w, h):
        doc = lifted(w, h)
        self.assertEqual(tl.validate(doc), [])
        tl.resolve_assets(doc, self.resolver)
        out = Path(self.tmp.name) / f"gap{w}x{h}.mp4"
        tr.render(doc, self.resolver, str(out))
        from modules import scene_remotion
        self.assertEqual(int(scene_remotion.count_frames(self.ffmpeg, out)), 90)  # nothing after the gap moved
        before, gap, after = (self.frame(out, t, w, h) for t in (0.5, 1.5, 2.5))
        self.assertTrue(all(abs(v - 128) <= 6 for px in before + after for v in px), (before, after))
        self.assertTrue(all(v <= 4 for px in gap for v in px), gap)
        self.assertLess(self.loudest_db(out, 1.15, 0.7), -60)       # the gap is silent
        self.assertGreater(self.loudest_db(out, 2.15, 0.7), -40)    # and the sound after it is there (lavfi's sine peaks near -21)

    def test_1080p(self):
        self.check(1920, 1080)

    def test_vertical_1080x1920(self):
        self.check(1080, 1920)

    def test_4k(self):
        self.check(3840, 2160)


class LiftGapDocumentTests(unittest.TestCase):
    def test_a_gap_is_valid_in_every_frame_and_needs_no_file_beyond_its_neighbours(self):
        for w, h in ((1920, 1080), (2560, 1440), (3840, 2160), (1080, 1920)):
            doc = lifted(w, h)
            self.assertEqual(tl.validate(doc), [], (w, h))
            res = lambda a: tl.ResolvedAsset(a, "video" if a == V else "audio", "/media/x", 4.0, True)
            tl.resolve_assets(doc, res)
            self.assertNotIn("mask", json.dumps(doc))


if __name__ == "__main__":
    unittest.main()
