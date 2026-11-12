"""The editor's "Lift" (command-center/lib/editorRange.ts ``liftRange``) leaves black and silence in place of the
marked range, so nothing after it moves. The picture lane has no gaps, so the gap is held by one clip made of
fields the renderer already has: the lifted part's file frozen on a frame (a still for a picture), no sound, and
a mask over the whole frame turned inside out. Nothing in the render changed for it; this holds the renderer to
what the editor promises, through the real export path:

* the hold is black over the whole frame, for a frozen video and for a still;
* the clips after it start exactly where they did (the frame count is the timeline's), and they are seen;
* both validators accept the hold (the shared case is in samples/timeline_doc_cases.json).
"""

import subprocess
import tempfile
import unittest
from pathlib import Path

from modules import render_backend as rb
from modules import timeline as tl
from modules import timeline_render as tr

B = "11111111-1111-4111-8111-111111111111"
P = "22222222-2222-4222-8222-222222222222"
# lib/editorRange.ts LIFT_MASK
LIFT_MASK = {"shape": "rect", "x": 0.5, "y": 0.5, "w": 1, "h": 1, "feather": 0, "invert": True}


def lifted(hold):
    """1 s of the grey video, the 1 s hold, 1 s more of the video: what a lift of 1..2 s of a 3 s clip leaves."""
    clips = [
        {"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": 1, "speed": 1, "audio": False},
        dict({"id": "c3", "start_s": 1, "speed": 1, "audio": False, "mask": dict(LIFT_MASK)}, **hold),
        {"id": "c2", "asset_id": B, "start_s": 2, "in_s": 2, "out_s": 3, "speed": 1, "audio": False},
    ]
    return {"version": 1, "width": 320, "height": 180, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}


def _ffmpeg():
    try:
        exe = rb.resolve_ffmpeg()
        subprocess.run([exe, "-version"], capture_output=True, check=True)
        return exe
    except Exception:
        return None


class LiftHoldRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = _ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("ffmpeg not available")
        try:
            from PIL import Image
        except ImportError:
            raise unittest.SkipTest("Pillow not installed")
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.grey = d / "grey.mp4"
        subprocess.run([cls.ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=30:d=4",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.grey)], check=True)
        cls.pic = d / "pic.png"
        Image.new("RGB", (640, 360), (220, 220, 220)).save(cls.pic)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def render(self, doc, name):
        res = lambda a: (tl.ResolvedAsset(a, "video", str(self.grey), 4.0, False) if a == B
                         else tl.ResolvedAsset(a, "image", str(self.pic), None, False))
        tl.resolve_assets(doc, res)
        out = Path(self.tmp.name) / f"{name}.mp4"
        tr.render(doc, res, str(out))
        return out

    def rgb(self, path, t, pts):
        raw = subprocess.run([self.ffmpeg, "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f",
                              "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        return [tuple(raw[(y * 320 + x) * 3:(y * 320 + x) * 3 + 3]) for x, y in pts]

    def frames(self, path):
        from modules import scene_remotion
        return int(scene_remotion.count_frames(self.ffmpeg, path))

    def check(self, doc, name):
        self.assertEqual(tl.validate(doc), [])
        out = self.render(doc, name)
        # nothing after the hold moved: three seconds at 30 fps
        self.assertEqual(self.frames(out), 90)
        corners = [(1, 1), (318, 1), (1, 178), (318, 178), (160, 90)]
        before = self.rgb(out, 0.5, corners)
        hold = self.rgb(out, 1.5, corners)
        after = self.rgb(out, 2.5, corners)
        self.assertTrue(all(abs(v - 128) <= 4 for px in before + after for v in px), (before, after))
        self.assertTrue(all(v <= 4 for px in hold for v in px), hold)

    def test_a_frozen_video_behind_the_inverted_mask_is_black_and_keeps_the_timing(self):
        self.check(lifted({"asset_id": B, "in_s": 1, "out_s": 2, "freeze": True}), "frozen")

    def test_a_still_behind_the_inverted_mask_is_black_and_keeps_the_timing(self):
        self.check(lifted({"asset_id": P, "in_s": 0, "out_s": 1}), "still")

    def test_a_hold_longer_than_its_file_is_fine_because_it_is_frozen(self):
        # A lift of more than the file's length still holds one frame (the frame must exist, the hold need not).
        doc = lifted({"asset_id": B, "in_s": 1, "out_s": 9, "freeze": True})
        doc["tracks"][0]["clips"][2]["start_s"] = 9
        self.assertEqual(tl.validate(doc), [])
        res = lambda a: tl.ResolvedAsset(a, "video", str(self.grey), 4.0, False)
        tl.resolve_assets(doc, res)


if __name__ == "__main__":
    unittest.main()
