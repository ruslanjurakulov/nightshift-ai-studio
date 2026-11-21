"""Tests for asset provenance + rights (roadmap PR 1.2, Y2/Y9).

What is pinned here:
  * MediaFetcher records, at fetch time, the Pexels facts the API returned
    (page URL, author, licence) with rights ``ok``, instead of discarding them;
  * a generated clip/still records its provider, model, the prompt actually
    sent, its task id, and a price only when one is configured (null otherwise,
    never 0) — its rights stay ``unknown``;
  * the IR builder carries those records onto ``assets[]``, hashes files that
    exist, leaves every unknown null, and the project still validates.
"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules import video_ir
from modules.media_fetcher import PEXELS_LICENSE, MediaFetcher
from modules.script_engine import Script, ScriptSection

PEXELS_VIDEO = {
    "id": 2499611,
    "url": "https://www.pexels.com/video/waves-crashing-2499611/",
    "user": {"id": 1, "name": "Jane Doe", "url": "https://www.pexels.com/@jane"},
    "video_files": [{"quality": "hd", "width": 1920, "link": "https://videos.pexels.com/f/2499611.mp4"}],
}
PEXELS_PHOTO = {
    "id": 777,
    "url": "https://www.pexels.com/photo/old-lighthouse-777/",
    "photographer": "John Roe",
    "src": {"original": "https://images.pexels.com/photos/777/original.jpg"},
}


def _fetcher(tmp: Path) -> MediaFetcher:
    # Bypass __init__: no real OUTPUT_DIR, no Pexels session, no key.
    f = MediaFetcher.__new__(MediaFetcher)
    f.slug = "topic"
    f.video_dir = tmp / "videos"
    f.image_dir = tmp / "images"
    f.video_dir.mkdir(parents=True, exist_ok=True)
    f.image_dir.mkdir(parents=True, exist_ok=True)
    f.video_terms = {}
    f.searches_made = 0
    return f


def _fake_download(url, dest):
    Path(dest).write_bytes(b"bytes of " + url.encode())
    return True


class PexelsProvenanceTestCase(unittest.TestCase):
    def test_video_records_page_url_author_licence_and_ok_rights(self):
        with tempfile.TemporaryDirectory() as d:
            f = _fetcher(Path(d))
            with patch.object(f, "_pexels_video_search", return_value=[PEXELS_VIDEO]), \
                    patch.object(f, "_download", side_effect=_fake_download), \
                    patch("modules.media_fetcher.time.sleep"):
                paths = f.fetch_videos(["waves"], count=1)
            self.assertEqual(len(paths), 1)
            rec = f.provenance[str(paths[0])]
        self.assertEqual(rec, {
            "provider": "pexels",
            "url": "https://www.pexels.com/video/waves-crashing-2499611/",
            "author": "Jane Doe",
            "license": PEXELS_LICENSE,
            "rights": "ok",
        })

    def test_photo_records_photographer(self):
        with tempfile.TemporaryDirectory() as d:
            f = _fetcher(Path(d))
            with patch.object(f, "_pexels_photo_search", return_value=[PEXELS_PHOTO]), \
                    patch.object(f, "_download", side_effect=_fake_download), \
                    patch("modules.media_fetcher.time.sleep"):
                paths = f.fetch_images(["lighthouse"], count=1)
            rec = f.provenance[str(paths[0])]
        self.assertEqual(rec["url"], "https://www.pexels.com/photo/old-lighthouse-777/")
        self.assertEqual(rec["author"], "John Roe")
        self.assertEqual((rec["license"], rec["rights"]), (PEXELS_LICENSE, "ok"))

    def test_missing_api_fields_are_absent_not_invented(self):
        bare = {"id": 5, "video_files": [{"quality": "hd", "width": 1920, "link": "https://v/5.mp4"}]}
        with tempfile.TemporaryDirectory() as d:
            f = _fetcher(Path(d))
            with patch.object(f, "_pexels_video_search", return_value=[bare]), \
                    patch.object(f, "_download", side_effect=_fake_download), \
                    patch("modules.media_fetcher.time.sleep"):
                paths = f.fetch_videos(["x"], count=1)
            rec = f.provenance[str(paths[0])]
        self.assertNotIn("author", rec)
        # No page URL came back, so the file link the clip was downloaded from is used.
        self.assertEqual(rec["url"], "https://v/5.mp4")

    def test_failed_download_records_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            f = _fetcher(Path(d))
            with patch.object(f, "_pexels_video_search", return_value=[PEXELS_VIDEO]), \
                    patch.object(f, "_download", return_value=False), \
                    patch("modules.media_fetcher.time.sleep"):
                f.fetch_videos(["waves"], count=1)
        self.assertEqual(getattr(f, "provenance", {}), {})


class GeneratedProvenanceTestCase(unittest.TestCase):
    def _broll(self, d, env=None):
        f = _fetcher(Path(d))
        sections = [{"keywords": ["ruined temple"], "duration": 6}]
        client = MagicMock(spec=["generate"])   # no submit/resume → untracked path
        client.generate.side_effect = lambda spec, dest: dest
        with patch("config.MINIMAX_BROLL_ENABLED", True), \
                patch("config.MINIMAX_BROLL_MAX_CLIPS", 1), \
                patch.dict("os.environ", env or {}, clear=False):
            result = f.generate_broll(sections, "Angkor", client=client)
        sent = client.generate.call_args[0][0].prompt
        return f, result, sent

    def test_generated_clip_records_prompt_sent_and_unknown_rights(self):
        with tempfile.TemporaryDirectory() as d, \
                patch.dict("os.environ", {}, clear=False) as env:
            env.pop("CHRONOS_PRICE_VIDEO_GEN_CLIPS", None)
            f, result, sent = self._broll(d)
            rec = f.provenance[result.by_section[0]]
        self.assertEqual(rec["prompt"], sent)
        self.assertEqual(rec["rights"], "unknown")
        self.assertEqual(rec["model"], result.model)
        self.assertIn("provider", rec)
        # No price configured → no cost at all (null in the IR), never 0.
        self.assertNotIn("cost_usd", rec)

    def test_configured_price_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            f, result, _ = self._broll(d, env={"CHRONOS_PRICE_VIDEO_GEN_CLIPS": "0.25"})
            rec = f.provenance[result.by_section[0]]
        self.assertEqual(rec["cost_usd"], 0.25)

    def test_generated_image_records_prompt_and_model(self):
        with tempfile.TemporaryDirectory() as d:
            f = _fetcher(Path(d))
            client = MagicMock()
            client.generate.side_effect = lambda prompt, dest, **kw: dest
            with patch("modules.image_providers.is_enabled", return_value=True), \
                    patch("modules.image_providers.active_provider", return_value="leonardo"), \
                    patch("modules.image_providers.active_model", return_value="model-x"):
                paths = f.generate_images([{"keywords": ["lighthouse"]}], "The Keeper",
                                          client=client, max_images=1)
            rec = f.provenance[str(paths[0])]
            sent = client.generate.call_args[0][0]
        self.assertEqual((rec["provider"], rec["model"], rec["rights"]),
                         ("leonardo", "model-x", "unknown"))
        self.assertEqual(rec["prompt"], sent.strip())


def _script(*names):
    return Script(
        topic="t", title="T", title_ab="", description="", tags=[], hook_sentence="",
        sections=[ScriptSection(name=n, narration=f"{n} text.", duration_hint=10,
                                section_type="story", cut_interval=5.0, keywords=[n])
                  for n in names],
        thumbnail_prompt_a="", thumbnail_prompt_b="", thumbnail_overlay_text="", open_loops=[],
    )


class BuilderProvenanceTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.stock = root / "2499611.mp4"
        self.stock.write_bytes(b"stock clip bytes")
        self.gen = root / "gen_1.mp4"
        self.gen.write_bytes(b"generated clip bytes")
        self.missing = root / "gone.jpg"   # never written
        self.provenance = {
            str(self.stock): {"provider": "pexels", "url": PEXELS_VIDEO["url"],
                              "author": "Jane Doe", "license": PEXELS_LICENSE, "rights": "ok"},
            str(self.gen): {"provider": "minimax", "model": "MiniMax-H3",
                            "prompt": "ruined temple — Angkor", "task_id": "task-42",
                            "cost_usd": 0.25, "rights": "unknown"},
        }
        self.project = video_ir.build_project(
            slug="p", script=_script("a", "b"),
            timeline=[{"start_ms": 0, "end_ms": 6000}, {"start_ms": 6000, "end_ms": 12000}],
            video_paths=[self.stock], image_paths=[self.missing],
            generated_videos={1: str(self.gen)}, generated_task_ids={1: "task-42"},
            video_provider="minimax", video_model="MiniMax-H3",
            provenance=self.provenance,
        )
        self.by_path = {a.path: a for a in self.project.assets}

    def tearDown(self):
        self.tmp.cleanup()

    def test_stock_asset_carries_pexels_facts(self):
        a = self.by_path[str(self.stock)]
        self.assertEqual((a.source, a.provider, a.url, a.author, a.license, a.rights.status),
                         ("stock", "pexels", PEXELS_VIDEO["url"], "Jane Doe", PEXELS_LICENSE, "ok"))
        self.assertIsNone(a.cost_usd)   # no per-asset price known — null, not 0
        self.assertEqual(a.sha256, hashlib.sha256(b"stock clip bytes").hexdigest())

    def test_generated_asset_carries_prompt_task_and_price(self):
        a = self.by_path[str(self.gen)]
        self.assertEqual((a.source, a.provider, a.model, a.prompt, a.task_id, a.cost_usd),
                         ("generated", "minimax", "MiniMax-H3", "ruined temple — Angkor",
                          "task-42", 0.25))
        self.assertEqual(a.rights.status, "unknown")
        self.assertEqual(a.sha256, hashlib.sha256(b"generated clip bytes").hexdigest())

    def test_missing_metadata_and_missing_file_stay_null(self):
        a = self.by_path[str(self.missing)]
        for f in ("url", "license", "author", "prompt", "task_id", "cost_usd", "sha256"):
            self.assertIsNone(getattr(a, f), f)
        self.assertEqual(a.rights.status, "unknown")

    def test_project_validates_and_round_trips(self):
        self.assertEqual(self.project.validate(), [])
        d = json.loads(self.project.to_json())
        self.assertEqual(video_ir.VideoProject.from_dict(d), self.project)
        try:
            import jsonschema
        except ImportError:
            return
        schema = json.loads(video_ir.SCHEMA_PATH.read_text(encoding="utf-8"))
        jsonschema.validate(d, schema)

    def test_bad_records_are_ignored_not_fatal(self):
        project = video_ir.build_project(
            slug="p", script=_script("a"), timeline=[{"start_ms": 0, "end_ms": 5000}],
            video_paths=[self.stock],
            provenance={str(self.stock): {"rights": "maybe", "cost_usd": -3, "url": "",
                                          "author": None}},
        )
        a = project.assets[0]
        self.assertEqual(a.rights.status, "unknown")
        self.assertIsNone(a.cost_usd)
        self.assertIsNone(a.url)
        self.assertIsNone(a.author)
        self.assertEqual(project.validate(), [])

    def test_hash_files_can_be_turned_off(self):
        project = video_ir.build_project(slug="p", script=_script("a"), timeline=[],
                                         video_paths=[self.stock], hash_files=False)
        self.assertIsNone(project.assets[0].sha256)

    def test_rights_summary(self):
        self.assertEqual(video_ir.rights_summary(self.project),
                         {"ok": 1, "unknown": 2, "blocked": 0})

    def test_write_for_run_passes_provenance_through(self):
        with tempfile.TemporaryDirectory() as out:
            project = video_ir.write_for_run(
                slug="p", script=_script("a"), timeline=[{"start_ms": 0, "end_ms": 5000}],
                video_paths=[self.stock], provenance=self.provenance, root=Path(out))
            self.assertIsNotNone(project)
            saved = json.loads((Path(out) / "p" / "project.json").read_text(encoding="utf-8"))
        asset = saved["assets"][0]
        self.assertEqual((asset["author"], asset["rights"]["status"]), ("Jane Doe", "ok"))


class RightsGateIntegrationTestCase(unittest.TestCase):
    """The rights values provenance sets are the ones publish_gate reads."""

    def _gate(self, provenance, block_on_unknown=False):
        from types import SimpleNamespace

        from modules import publish_gate

        with tempfile.TemporaryDirectory() as d:
            clip = Path(d) / "1.mp4"
            clip.write_bytes(b"clip")
            video = Path(d) / "final_video.mp4"
            video.write_bytes(b"0" * 200_000)
            project = video_ir.build_project(
                slug="p", script=_script("a"), timeline=[{"start_ms": 0, "end_ms": 5000}],
                video_paths=[clip], provenance={str(clip): provenance} if provenance else None)
            self.assertTrue(project.scenes[0].asset_ids)   # the clip is USED
            gate = {"block_on_unknown_rights": True} if block_on_unknown else {}
            return publish_gate.evaluate(
                script=SimpleNamespace(topic="A Real Topic", title="An Ordinary Title",
                                       description="d",
                                       sections=[SimpleNamespace(narration="x y z.")]),
                video_path=video, fact_results=[],
                channel=SimpleNamespace(agent=SimpleNamespace(publish_gate=gate)),
                originality=SimpleNamespace(check=lambda t: SimpleNamespace(
                    is_duplicate=False, needs_review=False)),
                qc_report=SimpleNamespace(blocks=[], warnings=[]),
                ir_project=project,
            )

    def test_pexels_asset_passes_even_when_unknown_blocks(self):
        d = self._gate({"provider": "pexels", "license": PEXELS_LICENSE, "rights": "ok"},
                       block_on_unknown=True)
        self.assertEqual(d.rights["ok"], 1)
        self.assertFalse([r for r in d.blocks + d.warnings if r.startswith("rights")])

    def test_generated_or_unrecorded_asset_is_unknown(self):
        for record in ({"provider": "minimax", "prompt": "p", "rights": "unknown"}, None):
            d = self._gate(record)
            self.assertEqual(d.rights["unknown"], 1)
            self.assertTrue([w for w in d.warnings if w.startswith("rights_unknown")])


if __name__ == "__main__":
    unittest.main()
