"""The opt-in repair kit (tools/repair_kit_cache.py).

Pinned: only the files a run's Video IR references inside output/<slug>/ are
carried (plus project.json / fact_check.json); never a credential file, a
symlink or anything outside the run directory; only the newest UNFINISHED run
(a published run leaves no kit); bounded in size; import only fills in a run
whose checkpoint was restored and never overwrites; nothing raises.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from modules import run_checkpoint, video_ir
from modules.video_ir import AssetRef, AudioRef, Scene, VideoProject
from tools import repair_kit_cache as rk


class KitBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.output = base / "output"
        self.kit = base / ".repair_kit"
        self.output.mkdir()
        self.outside = base / "secret.bin"
        self.outside.write_bytes(b"not part of any run")

    def make_run(self, slug="lost-city", *, extra_asset=None):
        run_dir = self.output / slug
        (run_dir / "media" / "videos").mkdir(parents=True)
        clip = run_dir / "media" / "videos" / "1.mp4"
        clip.write_bytes(b"clip")
        unused = run_dir / "media" / "videos" / "2.mp4"
        unused.write_bytes(b"unreferenced")
        (run_dir / "audio").mkdir()
        audio = run_dir / "audio" / "mix.mp3"
        audio.write_bytes(b"audio")
        (run_dir / "final_video.mp4").write_bytes(b"x" * 100)
        (run_dir / "youtube_token.json").write_text("{}")
        assets = [AssetRef(id="a_1", kind="video", path=str(clip))]
        if extra_asset is not None:
            assets.append(AssetRef(id="a_x", kind="video", path=str(extra_asset)))
        project = VideoProject(slug=slug, channel_id="news", audio=AudioRef(path=str(audio)),
                               scenes=(Scene(id="s000", index=0, start_s=0, end_s=1,
                                             asset_ids=("a_1",)),),
                               assets=tuple(assets))
        video_ir.save(project, run_dir / "project.json")
        run_checkpoint.record_stage(slug, run_checkpoint.STAGE_PROJECT, channel_id="news",
                                    root=self.output,
                                    artifacts={"project_json": str(run_dir / "project.json")})
        return run_dir


class Export(KitBase):
    def test_carries_only_what_the_ir_references_inside_the_run(self):
        self.make_run(extra_asset=self.outside)
        self.assertEqual(rk.export_kit(self.output, self.kit), "lost-city")
        manifest = json.loads((self.kit / "manifest.json").read_text())
        self.assertEqual(sorted(manifest["files"]),
                         ["audio/mix.mp3", "media/videos/1.mp4", "project.json"])
        carried = {str(p.relative_to(self.kit)) for p in self.kit.rglob("*") if p.is_file()}
        self.assertNotIn("lost-city/youtube_token.json", carried)
        self.assertNotIn("lost-city/final_video.mp4", carried)
        self.assertNotIn("lost-city/media/videos/2.mp4", carried)

    def test_a_symlinked_asset_is_not_followed(self):
        run_dir = self.make_run()
        link = run_dir / "media" / "videos" / "1.mp4"
        link.unlink()
        os.symlink(self.outside, link)
        rk.export_kit(self.output, self.kit)
        manifest = json.loads((self.kit / "manifest.json").read_text())
        self.assertNotIn("media/videos/1.mp4", manifest["files"])

    def test_a_published_run_leaves_no_kit(self):
        self.make_run()
        run_checkpoint.clear("lost-city", self.output)
        self.assertIsNone(rk.export_kit(self.output, self.kit))
        self.assertFalse(self.kit.exists())

    def test_over_the_cap_keeps_nothing(self):
        self.make_run()
        self.assertIsNone(rk.export_kit(self.output, self.kit, max_bytes=5))
        self.assertFalse(self.kit.exists())


class Import(KitBase):
    def exported_then_fresh_runner(self):
        self.make_run()
        rk.export_kit(self.output, self.kit)
        # A fresh runner: the run-state cache restored only the checkpoint.
        cp = (self.output / "lost-city" / "checkpoint.json").read_text()
        import shutil

        shutil.rmtree(self.output)
        (self.output / "lost-city").mkdir(parents=True)
        (self.output / "lost-city" / "checkpoint.json").write_text(cp)

    def test_restores_media_for_a_restored_run(self):
        self.exported_then_fresh_runner()
        placed = rk.import_kit(self.kit, self.output)
        self.assertIn("media/videos/1.mp4", placed)
        self.assertEqual((self.output / "lost-city" / "media" / "videos" / "1.mp4").read_bytes(), b"clip")

    def test_without_its_run_the_kit_is_ignored(self):
        self.exported_then_fresh_runner()
        (self.output / "lost-city" / "checkpoint.json").unlink()
        self.assertEqual(rk.import_kit(self.kit, self.output), [])

    def test_never_overwrites_and_refuses_escaping_entries(self):
        self.exported_then_fresh_runner()
        (self.output / "lost-city" / "project.json").write_text("newer")
        manifest = json.loads((self.kit / "manifest.json").read_text())
        manifest["files"] += ["../escape.txt", "/etc/passwd", "youtube_token.json"]
        (self.kit / "manifest.json").write_text(json.dumps(manifest))
        placed = rk.import_kit(self.kit, self.output)
        self.assertEqual((self.output / "lost-city" / "project.json").read_text(), "newer")
        self.assertFalse((self.output / "escape.txt").exists())
        self.assertNotIn("youtube_token.json", placed)

    def test_missing_kit_never_raises(self):
        self.assertEqual(rk.import_kit(self.kit, self.output), [])
        self.assertEqual(rk.main(["import", "--kit", str(self.kit), "--output", str(self.output)]), 0)


if __name__ == "__main__":
    unittest.main()
