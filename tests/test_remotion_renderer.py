"""Tests for modules.remotion_renderer — subprocess is always mocked; nothing
here needs Node, Chromium or network."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import remotion_renderer as rr


def _scene(**over):
    s = {
        "id": "s002", "index": 2, "name": "the_log_book", "type": "story",
        "narration": "Revenue grew 40% that year.", "start_s": 10.0, "end_s": 14.0,
        "shot": {"recipe": "stat_counter", "camera": "", "lighting": "", "mood": ""},
        "element_ids": [], "asset_ids": ["a1"], "claim_ids": [],
    }
    s.update(over)
    return s


class _Env:
    """Patch env vars for a block (restoring afterwards)."""

    def __init__(self, **values):
        self.values = values
        self._patch = None

    def __enter__(self):
        clean = {k: v for k, v in os.environ.items() if not k.startswith("CHRONOS_REMOTION")}
        clean.update(self.values)
        self._patch = mock.patch.dict(os.environ, clean, clear=True)
        self._patch.__enter__()
        return self

    def __exit__(self, *exc):
        self._patch.__exit__(*exc)


class FlagTestCase(unittest.TestCase):
    def test_off_by_default(self):
        with _Env():
            self.assertFalse(rr.enabled())
        with _Env(CHRONOS_REMOTION="0"):
            self.assertFalse(rr.enabled())
        with _Env(CHRONOS_REMOTION="1"):
            self.assertTrue(rr.enabled())

    def test_disabled_never_runs_subprocess(self):
        with _Env(), mock.patch.object(rr.subprocess, "run") as run:
            self.assertIsNone(rr.render_scene(_scene(), {}, "/tmp/x.mp4"))
            run.assert_not_called()

    def test_timeout_env(self):
        with _Env():
            self.assertEqual(rr._timeout_s(), rr.DEFAULT_TIMEOUT_S)
        with _Env(CHRONOS_REMOTION_TIMEOUT="30"):
            self.assertEqual(rr._timeout_s(), 30.0)
        for bad in ("abc", "-5", "0"):
            with _Env(CHRONOS_REMOTION_TIMEOUT=bad):
                self.assertEqual(rr._timeout_s(), rr.DEFAULT_TIMEOUT_S)


class PropsTestCase(unittest.TestCase):
    def test_duration_null_is_unknown(self):
        self.assertEqual(rr.scene_duration_s(_scene()), 4.0)
        self.assertIsNone(rr.scene_duration_s(_scene(end_s=None)))
        self.assertIsNone(rr.scene_duration_s(_scene(start_s=None)))
        self.assertIsNone(rr.scene_duration_s(_scene(start_s=5.0, end_s=5.0)))

    def test_build_props_shape_and_trimming(self):
        with tempfile.TemporaryDirectory() as base:
            img = Path(base) / "images" / "a1.jpg"
            ctx = {
                "width": 1280, "height": 720, "fps": 25, "assets_base_dir": base,
                "style": {"caption_style": "sentence"},
                "words": [
                    {"text": "Revenue", "start_s": 10.1, "end_s": 10.5},
                    {"text": "before", "start_s": 1.0, "end_s": 2.0},     # outside scene
                    {"text": "", "start_s": 11.0, "end_s": 11.2},          # empty
                    {"text": "bad", "start_s": None, "end_s": 11.2},       # unknown time
                ],
                "assets": [
                    {"id": "a1", "kind": "image", "path": str(img)},
                    {"id": "a2", "kind": "image", "path": "/elsewhere/x.jpg"},
                    {"id": "a3", "kind": "video", "path": "clips/c.mp4"},
                    {"id": "a4", "kind": "video", "path": "../escape.mp4"},
                ],
                "transition": "crossfade",
            }
            props = rr.build_props(_scene(), ctx)
        json.dumps(props)
        self.assertEqual(set(props), {"scene", "width", "height", "fps", "assetsBaseDir",
                                      "style", "words", "assets", "transition"})
        self.assertEqual((props["width"], props["height"], props["fps"]), (1280, 720, 25.0))
        self.assertEqual([w["text"] for w in props["words"]], ["Revenue"])
        self.assertEqual([a["id"] for a in props["assets"]], ["a1", "a3"])
        self.assertEqual(props["assets"][0]["path"], "images/a1.jpg")
        self.assertEqual(props["scene"]["shot"]["recipe"], "stat_counter")
        self.assertEqual(props["transition"], "crossfade")

    def test_style_object_with_to_dict(self):
        class Bible:
            def to_dict(self):
                return {"caption_style": "none"}
        props = rr.build_props(_scene(), {"style": Bible()})
        self.assertEqual(props["style"], {"caption_style": "none"})
        self.assertIsNone(rr.build_props(_scene(), {})["style"])

    def test_defaults_when_context_is_sparse(self):
        props = rr.build_props(_scene(), {})
        self.assertEqual((props["width"], props["height"], props["fps"]), (1920, 1080, 30))
        self.assertEqual(props["assetsBaseDir"], "")
        self.assertEqual(props["assets"], [])

    def test_build_command(self):
        cmd = rr.build_command("npx", Path("/t/p.json"), Path("/o/s.mp4"),
                               public_dir=Path("/assets"), browser="/bin/chrome")
        self.assertEqual(cmd[:7], ["npx", "--no-install", "remotion", "render",
                                   "src/index.ts", "Scene", "/o/s.mp4"])
        self.assertIn("--props=/t/p.json", cmd)
        self.assertIn("--concurrency=1", cmd)
        self.assertIn("--public-dir=/assets", cmd)
        self.assertIn("--browser-executable=/bin/chrome", cmd)
        bare = rr.build_command("npx", Path("/t/p.json"), Path("/o/s.mp4"))
        self.assertFalse(any(a.startswith(("--public-dir", "--browser-executable")) for a in bare))


class RenderSceneTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "out" / "s002.mp4"
        # Pretend node + the engine's dependencies are installed.
        p1 = mock.patch.object(rr.shutil, "which", return_value="/usr/bin/npx")
        p2 = mock.patch.object(rr, "_engine_installed", return_value=True)
        self.which = p1.start()
        p2.start()
        self.addCleanup(mock.patch.stopall)

    def _fake_run(self, returncode=0, write=True, captured=None):
        def run(cmd, **kw):
            if captured is not None:
                captured["cmd"] = cmd
                captured["kw"] = kw
                props_arg = next(a for a in cmd if a.startswith("--props="))
                captured["props"] = json.loads(Path(props_arg.split("=", 1)[1]).read_text())
            if write:
                self.out.write_bytes(b"\x00" * 16)
            return subprocess.CompletedProcess(cmd, returncode, stdout="", stderr="boom" if returncode else "")
        return run

    def test_success_returns_path_and_passes_props(self):
        seen = {}
        with _Env(CHRONOS_REMOTION="1", CHRONOS_REMOTION_TIMEOUT="42"), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(captured=seen)):
            got = rr.render_scene(_scene(), {"width": 640, "height": 360, "fps": 30}, self.out)
        self.assertEqual(got, self.out.resolve())
        self.assertEqual(seen["props"]["scene"]["id"], "s002")
        self.assertEqual(seen["kw"]["timeout"], 42.0)
        self.assertEqual(seen["kw"]["cwd"], str(rr.ENGINE_DIR))
        self.assertIn("--concurrency=1", seen["cmd"])
        self.assertFalse(any(a.startswith("--browser-executable") for a in seen["cmd"]))

    def test_browser_env_is_passed_when_it_exists(self):
        seen = {}
        browser = Path(self.tmp.name) / "headless_shell"
        browser.write_text("")
        with _Env(CHRONOS_REMOTION="1", CHRONOS_REMOTION_BROWSER=str(browser)), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(captured=seen)):
            rr.render_scene(_scene(), {}, self.out)
        self.assertIn(f"--browser-executable={browser}", seen["cmd"])

    def test_missing_browser_path_is_ignored(self):
        seen = {}
        with _Env(CHRONOS_REMOTION="1", CHRONOS_REMOTION_BROWSER="/no/such/chrome"), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(captured=seen)):
            self.assertIsNotNone(rr.render_scene(_scene(), {}, self.out))
        self.assertFalse(any(a.startswith("--browser-executable") for a in seen["cmd"]))

    def test_nonzero_exit_returns_none(self):
        with _Env(CHRONOS_REMOTION="1"), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(returncode=1, write=False)):
            with self.assertLogs(rr.logger, level="WARNING"):
                self.assertIsNone(rr.render_scene(_scene(), {}, self.out))

    def test_missing_output_returns_none(self):
        with _Env(CHRONOS_REMOTION="1"), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(write=False)):
            self.assertIsNone(rr.render_scene(_scene(), {}, self.out))

    def test_timeout_returns_none(self):
        boom = subprocess.TimeoutExpired(cmd=["npx"], timeout=1)
        with _Env(CHRONOS_REMOTION="1"), mock.patch.object(rr.subprocess, "run", side_effect=boom):
            self.assertIsNone(rr.render_scene(_scene(), {}, self.out))

    def test_oserror_and_unexpected_errors_return_none(self):
        for exc in (OSError("no exec"), RuntimeError("weird")):
            with _Env(CHRONOS_REMOTION="1"), mock.patch.object(rr.subprocess, "run", side_effect=exc):
                self.assertIsNone(rr.render_scene(_scene(), {}, self.out))

    def test_unknown_timing_skips_without_running(self):
        with _Env(CHRONOS_REMOTION="1"), mock.patch.object(rr.subprocess, "run") as run:
            self.assertIsNone(rr.render_scene(_scene(end_s=None), {}, self.out))
            self.assertIsNone(rr.render_scene("not a scene", {}, self.out))
            run.assert_not_called()

    def test_no_npx_skips(self):
        self.which.return_value = None
        with _Env(CHRONOS_REMOTION="1"), mock.patch.object(rr.subprocess, "run") as run:
            self.assertIsNone(rr.render_scene(_scene(), {}, self.out))
            run.assert_not_called()

    def test_missing_assets_dir_skips(self):
        with _Env(CHRONOS_REMOTION="1"), mock.patch.object(rr.subprocess, "run") as run:
            self.assertIsNone(rr.render_scene(_scene(), {"assets_base_dir": "/no/such/dir"}, self.out))
            run.assert_not_called()

    def test_props_file_is_cleaned_up(self):
        seen = {}
        with _Env(CHRONOS_REMOTION="1"), \
                mock.patch.object(rr.subprocess, "run", side_effect=self._fake_run(captured=seen)):
            rr.render_scene(_scene(), {}, self.out)
        props_arg = next(a for a in seen["cmd"] if a.startswith("--props="))
        self.assertFalse(Path(props_arg.split("=", 1)[1]).exists())


class EngineNotInstalledTestCase(unittest.TestCase):
    def test_missing_node_modules_skips(self):
        with _Env(CHRONOS_REMOTION="1"), \
                mock.patch.object(rr.shutil, "which", return_value="/usr/bin/npx"), \
                mock.patch.object(rr, "ENGINE_DIR", Path("/no/such/engine")), \
                mock.patch.object(rr.subprocess, "run") as run:
            self.assertIsNone(rr.render_scene(_scene(), {}, "/tmp/never.mp4"))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
