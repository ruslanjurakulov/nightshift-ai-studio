"""Every path that writes a pipeline MASTER puts the index (moov) in front of the media data, and the flag that does it
changes nothing else.

Instagram's Reels page requires "moov atom at the front"; ``social_probe`` refuses a master without it as
``not_faststart`` (docs/AI_DISCLOSURE.md). The writers of ``final_video.mp4``:

* ``modules/compositor.py``  (moviepy, the default)  ``ffmpeg_params=["-movflags", "+faststart"]`` since #555;
  tests/test_master_faststart.py pins it.
* ``render_backend.render`` via ``render_dispatch._render_ffmpeg``  (``CHRONOS_RENDER_BACKEND=ffmpeg``)
  asks for ``faststart=True``: this file.
* ``scene_render.assemble``  (``CHRONOS_SCENE_RENDER``, and every scene repair / regeneration re-assembly): this file.

An editor export shares ``render_backend.render`` but not the flag: its command stays exactly what its pinned
goldens say (tests/test_render_spec_legacy.py and the editor tests), and ``render`` adds nothing unless asked.

The real-ffmpeg tests need the ffmpeg that ships with imageio-ffmpeg (CI has it; they skip without it). They compare
the encoded packets of the same render with and without the flag by checksum: the flag moves the index, it does not
touch a frame."""

import ast
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from modules import render_backend, render_dispatch, scene_render, social_probe
from modules.render_spec import FASTSTART_MOVFLAGS
from modules.video_ir import AssetRef
from tests.test_master_faststart import _top_level_boxes
from tests.test_scene_render import _project

try:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # pragma: no cover
    FFMPEG = None

ROOT = Path(__file__).resolve().parent.parent
FLAGS = ["-movflags", "+faststart"]


def _ffmpeg(*args):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True, capture_output=True)


def _packets_md5(path, selector):
    """Checksum of the encoded packets of one stream, copied out untouched (no decode, no re-encode)."""
    out = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-map", selector, "-c", "copy", "-f", "md5", "-"],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out.startswith("MD5="), out
    return out


def _stream_lines(path):
    err = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    return [line.split(" (default)")[0].strip() for line in err.splitlines() if "Stream #" in line]


def _front(path):
    boxes = _top_level_boxes(path)
    return boxes.index("moov") < boxes.index("mdat")


class FlagTests(unittest.TestCase):
    def test_the_flag_is_the_standard_mux_flag(self):
        self.assertEqual(list(FASTSTART_MOVFLAGS), FLAGS)


class CommandLineTests(unittest.TestCase):
    """The commands, with nothing executed."""

    def spec(self, out="/o/final_video.mp4"):
        return render_backend.simple_spec(out, [("/t/a.mp4", 2.0)], audio_path="/t/a.mp3", width=320, height=180)

    def run_render(self, **kw):
        seen = []
        spec = self.spec()
        with mock.patch.object(render_backend, "_normalize_all", lambda ffmpeg, s, d, j, t, *a: s.segments), \
                mock.patch.object(render_backend, "_run", lambda cmd, deadline=None: seen.append(list(cmd))), \
                mock.patch.object(Path, "mkdir"):
            render_backend.render(spec, ffmpeg="ffmpeg", **kw)
        return seen[-1], spec

    def test_the_pipelines_ffmpeg_render_asks_for_faststart(self):
        seen = {}

        def fake(spec, **kw):
            seen.update(kw)
            return spec.output_path

        with tempfile.TemporaryDirectory() as t:
            out = Path(t) / "final_video.mp4"
            out.write_bytes(b"x")
            with mock.patch.object(render_backend, "render", fake):
                render_dispatch._render_ffmpeg(self.spec(str(out)))
        self.assertEqual(seen, {"faststart": True})

    def test_render_puts_the_flag_right_before_the_output_and_changes_nothing_else(self):
        plain, spec = self.run_render()
        fast, _ = self.run_render(faststart=True)
        self.assertNotIn("-movflags", plain)          # the default command is the one it always was
        self.assertEqual(plain[-1], spec.output_path)
        # (each render writes its concat list in its own temp directory: same name, different directory)
        same_list = [fast[i] if "concat.txt" in a else a for i, a in enumerate(plain)]
        self.assertEqual(fast, same_list[:-1] + FLAGS + [spec.output_path])

    def test_render_refuses_a_command_that_does_not_end_with_the_output(self):
        real = render_backend.build_ffmpeg_command
        with mock.patch.object(render_backend, "build_ffmpeg_command", lambda *a, **k: real(*a, **k) + ["-x"]):
            with self.assertRaises(render_backend.RenderBackendError):
                self.run_render(faststart=True)

    def test_an_editor_export_never_asks(self):
        calls = [n for n in ast.walk(ast.parse((ROOT / "modules" / "timeline_render.py").read_text()))
                 if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "render"]
        self.assertTrue(calls)
        for call in calls:
            self.assertNotIn("faststart", [k.arg for k in call.keywords])

    def test_scene_assembly_puts_the_flag_right_before_its_output(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root / "audio.mp3").write_bytes(b"a")
            jobs = [SimpleNamespace(path=root / "s0.mp4")]
            project = SimpleNamespace(audio=SimpleNamespace(path=str(root / "audio.mp3")), fps=30)
            seen = []

            def fake_run(cmd, deadline=None):
                seen.append(list(cmd))
                Path(cmd[-1]).write_bytes(b"out")

            with mock.patch.object(render_backend, "_run", fake_run):
                scene_render.assemble(project, jobs, root / "final_video.mp4", ffmpeg="ffmpeg")
        cmd = seen[0]
        self.assertEqual(cmd[-4:-1], ["-shortest"] + FLAGS)
        self.assertTrue(Path(cmd[-1]).name.endswith("final_video.mp4"))


@unittest.skipIf(FFMPEG is None, "no ffmpeg binary")
class RealFfmpegTests(unittest.TestCase):
    """Small real renders, 320x180 @ 30 fps."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=7.3", str(self.root / "audio.mp3"))
        _ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x240:d=1.5:r=25", str(self.root / "clip.mp4"))
        _ffmpeg("-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", "1", str(self.root / "still.png"))

    def tearDown(self):
        self.tmp.cleanup()

    def same_streams(self, a, b):
        for sel in ("0:v:0", "0:a:0"):
            self.assertEqual(_packets_md5(a, sel), _packets_md5(b, sel), sel)
        self.assertEqual(_stream_lines(a), _stream_lines(b))
        self.assertEqual(Path(a).stat().st_size, Path(b).stat().st_size)  # the same bytes, the index moved

    def test_ffmpeg_backend_master_is_moov_first_and_only_the_index_moved(self):
        def spec(name):
            return render_backend.simple_spec(str(self.root / name), [(str(self.root / "clip.mp4"), 1.5)],
                                              audio_path=str(self.root / "audio.mp3"), width=320, height=180, fps=30)

        render_backend.render(spec("plain.mp4"))
        render_backend.render(spec("fast.mp4"), faststart=True)
        self.assertFalse(_front(self.root / "plain.mp4"), "the default must stay what it was (editor exports)")
        self.assertTrue(_front(self.root / "fast.mp4"))
        self.same_streams(self.root / "plain.mp4", self.root / "fast.mp4")

    def test_the_pipelines_dispatch_makes_a_master_instagram_accepts(self):
        out = self.root / "m" / "final_video.mp4"
        render_dispatch._render_ffmpeg(render_backend.simple_spec(
            str(out), [(str(self.root / "clip.mp4"), 1.5)], audio_path=str(self.root / "audio.mp3"),
            width=320, height=180, fps=30))
        self.assertTrue(_front(out))
        self.assertTrue(social_probe.faststart(out))
        social_probe.check_media("instagram", social_probe.read_facts(out))  # raises on not_faststart (and the rest)

    def test_scene_assembly_master_is_moov_first_and_only_the_index_moved(self):
        assets = [AssetRef(id="a_clip", kind="video", path=str(self.root / "clip.mp4")),
                  AssetRef(id="a_still", kind="image", path=str(self.root / "still.png"))]
        project = _project(self.root, narrations=("one", "two", "three"),
                           times=((0.0, 2.437), (2.437, 5.1), (5.1, 7.3)), audio_s=7.3, assets=assets,
                           scene_assets={0: ("a_clip",), 1: ("a_still", "a_clip"), 2: ()})
        out = self.root / "scenes_out" / "final_video.mp4"
        scene_render.render_project(project, out)
        self.assertTrue(_front(out))
        social_probe.check_media("instagram", social_probe.read_facts(out))
        # The same assembly of the same cached scenes without the flag: same packets, index at the end.
        plain = self.root / "plain_out" / "final_video.mp4"
        with mock.patch.object(scene_render, "FASTSTART_MOVFLAGS", ()):
            scene_render.render_project(project, plain)
        self.assertFalse(_front(plain))
        self.same_streams(plain, out)


if __name__ == "__main__":
    unittest.main()
