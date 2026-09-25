"""Targeted scene repair (modules/scene_repair.py, roadmap PR 2.3).

What is pinned here, and what would break without it:
  * the ``repair_scenes`` input is parsed strictly — only indexes / sNNN ids,
    capped — so a dispatch cannot smuggle anything else in;
  * a repair needs an existing, unfinished run of THIS channel with its IR,
    audio, subtitles, script and every kept scene's footage on disk; anything
    missing stops it BEFORE a single search is made (nothing spent);
  * only the named scenes get new footage (never a clip the run already has);
    every other scene keeps its assets byte for byte and is a render-cache hit;
  * the repaired scene is actually re-rendered and the video reassembled;
  * the previous approval is void: the checkpoint records the repair, Supabase
    rows go approved → pending, approve intents are consumed as superseded,
    and a two-person approval decided before the repair no longer counts;
  * a repair never uploads and never claims a gate verdict.
"""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from modules import publish_approval, run_checkpoint, scene_render, scene_repair, video_ir
from modules.video_ir import AssetRef, AudioRef, Scene, Shot, VideoProject


class FakeFetcher:
    """Stands in for MediaFetcher: 'downloads' new numbered clips, records
    every search and what it was told to exclude."""

    def __init__(self, run_dir: Path, *, start_id=9000, videos_per_search=10, images=True):
        self.video_dir = run_dir / "media" / "videos"
        self.image_dir = run_dir / "media" / "images"
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.searches_made = 0
        self.provenance = {}
        self.video_terms = {}
        self.excluded_seen = []
        self._next = start_id
        self.videos_per_search = videos_per_search
        self.images = images

    def _make(self, d, ext, kw, exclude):
        self._next += 1
        while str(self._next) in exclude:
            self._next += 1
        p = d / f"{self._next}.{ext}"
        p.write_bytes(f"new {self._next}".encode())
        self.provenance[str(p)] = {"provider": "pexels", "url": f"https://pexels/{self._next}",
                                   "license": "Pexels License", "rights": "ok"}
        return p

    def fetch_videos(self, keywords, count=10, exclude_ids=None):
        self.excluded_seen.append(set(exclude_ids or ()))
        out = []
        for kw in keywords:
            if len(out) >= count:
                break
            self.searches_made += 1
            for _ in range(min(self.videos_per_search, count - len(out))):
                out.append(self._make(self.video_dir, "mp4", kw, exclude_ids or ()))
        return out

    def fetch_images(self, keywords, count=8, exclude_ids=None):
        if not self.images:
            self.searches_made += len(keywords)
            return []
        self.searches_made += 1
        return [self._make(self.image_dir, "jpg", keywords[0], exclude_ids or ()) for _ in range(count)]


class FakeSync:
    enabled = True

    def __init__(self, rows=None):
        self.rows = rows if rows is not None else [{"video_id": "yt_abc-1", "review_state": "approved"}]
        self.updates = []
        self.selects = []

    def select(self, table, params=None):
        self.selects.append((table, params))
        return list(self.rows) if table == "videos" else []

    def update(self, table, filters, values):
        self.updates.append((table, dict(filters), dict(values)))
        return True


class CountingRenderer:
    def __init__(self):
        self.calls = []

    def __call__(self, job, project, out_path):
        self.calls.append(job.scene_id)
        Path(out_path).write_bytes(f"scene {job.scene_id} {job.key}".encode())
        return out_path


def fake_assemble(project, jobs, output_path, *, subtitles_path=None):
    Path(output_path).write_bytes(b"|".join(Path(j.path).read_bytes() for j in jobs))
    return output_path


class Base(unittest.TestCase):
    CHANNEL = "news"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "output"
        self.slug = "the-lost-city"
        self.run_dir = self.root / self.slug
        self.run_dir.mkdir(parents=True)
        self.renderer = CountingRenderer()

    def make_run(self, *, n=3, channel=CHANNEL, completed=False, subtitles=True):
        vids = self.run_dir / "media" / "videos"
        vids.mkdir(parents=True, exist_ok=True)
        assets, scenes = [], []
        for i in range(n):
            p = vids / f"{100 + i}.mp4"
            p.write_bytes(f"original {i}".encode())
            a = AssetRef(id=video_ir.asset_id(str(p)), kind="video", path=str(p), source="stock",
                         provider="pexels", sha256=video_ir.file_sha256(p))
            assets.append(a)
            scenes.append(Scene(id=video_ir.scene_id(i), index=i, name=f"Part {i}",
                                narration=f"narration {i}", start_s=4.0 * i, end_s=4.0 * (i + 1),
                                shot=Shot(recipe="slow_push"), asset_ids=(a.id,)))
        audio = self.run_dir / "audio" / "final_mix.mp3"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"audio")
        srt = None
        if subtitles:
            srt = self.run_dir / "subtitles" / "subtitles.srt"
            srt.parent.mkdir(parents=True)
            srt.write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n")
        project = VideoProject(slug=self.slug, channel_id=channel, title="T", width=320,
                               height=180, fps=30,
                               audio=AudioRef(path=str(audio), duration_s=4.0 * n),
                               subtitles_path=str(srt) if srt else None,
                               scenes=tuple(scenes), assets=tuple(assets))
        video_ir.save(project, self.run_dir / "project.json")
        script = {"topic": "The Lost City", "title": "T",
                  "sections": [{"name": f"Part {i}", "type": "hook" if i == 0 else "story",
                                "narration": f"narration {i}", "cut_interval": 5,
                                "keywords": [f"kw{i}a", f"kw{i}b"]} for i in range(n)]}
        (self.run_dir / "script.json").write_text(json.dumps(script))
        run_checkpoint.record_stage(self.slug, run_checkpoint.STAGE_SCRIPT, topic="The Lost City",
                                    channel_id=channel, root=self.root,
                                    artifacts={"script_json": str(self.run_dir / "script.json")})
        run_checkpoint.record_stage(self.slug, run_checkpoint.STAGE_PROJECT, root=self.root,
                                    artifacts={"project_json": str(self.run_dir / "project.json")})
        if completed:
            run_checkpoint.mark_complete(self.slug, self.root)
        return project

    def render_fn(self, project, output_path, *, cut_intervals=None):
        return scene_render.render_project(project, output_path, cut_intervals=cut_intervals,
                                           renderers={"ffmpeg": self.renderer},
                                           assemble_fn=fake_assemble)

    def qc_fn(self, video_path, *, audio_path=None, timeline=None):
        self.qc_timeline = timeline
        return SimpleNamespace(to_metadata=lambda: {"blocks": [], "warnings": []})

    def plan(self, ids=("s001",), **kw):
        return scene_repair.preflight(self.CHANNEL, ids, root=self.root, check_tools=False, **kw)


# ── input ───────────────────────────────────────────────────────────────────

class ParseRepairScenes(unittest.TestCase):
    def test_indexes_and_ids_normalise_to_ir_ids(self):
        self.assertEqual(scene_repair.parse_repair_scenes("3,17"), ("s003", "s017"))
        self.assertEqual(scene_repair.parse_repair_scenes(" s003 , S017 "), ("s003", "s017"))
        self.assertEqual(scene_repair.parse_repair_scenes("3,s003"), ("s003",))

    def test_empty_means_no_repair(self):
        self.assertEqual(scene_repair.parse_repair_scenes(""), ())
        self.assertEqual(scene_repair.parse_repair_scenes(None), ())
        self.assertEqual(scene_repair.parse_repair_scenes("   "), ())

    def test_anything_but_indexes_and_ids_is_refused(self):
        for bad in ("3-5", "3;rm -rf ~", "$(id)", "s3", "-1", "3.0", "3,,4", "3,", "a",
                    "s003/../x", "3 4", "12345", "s12345", "`x`"):
            with self.subTest(bad=bad), self.assertRaises(scene_repair.RepairRequestError):
                scene_repair.parse_repair_scenes(bad)

    def test_count_is_capped(self):
        ok = ",".join(str(i) for i in range(scene_repair.MAX_REPAIR_SCENES))
        self.assertEqual(len(scene_repair.parse_repair_scenes(ok)), scene_repair.MAX_REPAIR_SCENES)
        with self.assertRaises(scene_repair.RepairRequestError):
            scene_repair.parse_repair_scenes(ok + ",99")

    def test_overlong_input_is_refused_before_splitting(self):
        with self.assertRaises(scene_repair.RepairRequestError):
            scene_repair.parse_repair_scenes("1," * 200)


# ── preflight: nothing spent when it cannot work ────────────────────────────

class Preflight(Base):
    def assertUnavailable(self, ids=("s001",), **kw):
        with self.assertRaises(scene_repair.RepairUnavailable) as cm:
            self.plan(ids, **kw)
        return str(cm.exception)

    def test_needs_an_existing_run(self):
        msg = self.assertUnavailable()
        self.assertIn("no unfinished run", msg)
        self.assertIn("CHRONOS_REPAIR_KIT", msg)   # names the remedy

    def test_a_completed_run_is_not_repaired(self):
        self.make_run(completed=True)
        self.assertUnavailable()

    def test_another_channels_run_is_never_picked(self):
        self.make_run(channel="other")
        self.assertUnavailable()

    def test_missing_ir_audio_or_subtitles_stop_it(self):
        self.make_run()
        (self.run_dir / "subtitles" / "subtitles.srt").unlink()
        self.assertIn("subtitles", self.assertUnavailable())
        (self.run_dir / "audio" / "final_mix.mp3").unlink()
        self.assertIn("narration audio", self.assertUnavailable())
        (self.run_dir / "project.json").unlink()
        self.assertIn("project.json", self.assertUnavailable())

    def test_a_kept_scene_without_its_footage_stops_it(self):
        self.make_run()
        (self.run_dir / "media" / "videos" / "102.mp4").unlink()   # s002's clip
        msg = self.assertUnavailable(("s001",))
        self.assertIn("s002", msg)
        # Repairing the scene whose footage is gone is fine: it gets new footage.
        self.assertEqual(self.plan(("s002",)).scene_ids, ("s002",))

    def test_unknown_scene_is_a_bad_request(self):
        self.make_run(n=3)
        with self.assertRaises(scene_repair.RepairRequestError):
            self.plan(("s007",))

    def test_scene_without_measured_times_stops_it(self):
        project = self.make_run()
        scenes = list(project.scenes)
        scenes[2] = Scene(**{**scenes[2].__dict__, "start_s": None, "end_s": None})
        video_ir.save(VideoProject(**{**project.__dict__, "scenes": tuple(scenes)}),
                      self.run_dir / "project.json")
        self.assertIn("scene by scene", self.assertUnavailable())

    def test_paths_are_relocated_onto_this_runner(self):
        project = self.make_run()
        moved = VideoProject(**{**project.__dict__,
                                "audio": AudioRef(path=f"/elsewhere/output/{self.slug}/audio/final_mix.mp3",
                                                  duration_s=12.0)})
        video_ir.save(moved, self.run_dir / "project.json")
        plan = self.plan()
        self.assertEqual(Path(plan.project.audio.path), self.run_dir / "audio" / "final_mix.mp3")

    def test_topic_picks_that_run(self):
        self.make_run()
        self.assertEqual(self.plan(topic="The Lost City").slug, self.slug)
        with self.assertRaises(scene_repair.RepairUnavailable):
            self.plan(topic="Some Other Topic")

    def test_cli_unavailable_exits_3_and_makes_no_search(self):
        fetcher = FakeFetcher(self.run_dir)
        with mock.patch("modules.event_log.emit"):
            code = scene_repair.cli(channel=self.CHANNEL, raw_scenes="1", root=self.root,
                                    check_tools=False, fetcher=fetcher)
        self.assertEqual(code, scene_repair.EXIT_UNAVAILABLE)
        self.assertEqual(fetcher.searches_made, 0)

    def test_cli_bad_request_exits_2(self):
        with mock.patch("modules.event_log.emit"):
            self.assertEqual(scene_repair.cli(channel=self.CHANNEL, raw_scenes="1;x", root=self.root),
                             scene_repair.EXIT_BAD_REQUEST)


# ── the repair ──────────────────────────────────────────────────────────────

class Repair(Base):
    def setUp(self):
        super().setUp()
        self.original = self.make_run(n=3)
        # The original run rendered every scene once: the cache is warm.
        scene_render.render_project(self.original, self.run_dir / "final_video.mp4",
                                    renderers={"ffmpeg": self.renderer}, assemble_fn=fake_assemble)
        self.renderer.calls.clear()
        self.fetcher = FakeFetcher(self.run_dir)
        self.sync = FakeSync()
        patcher = mock.patch.object(scene_repair, "_record_costs")
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_repair(self, ids=("s001",)):
        return scene_repair.repair(self.plan(ids), fetcher=self.fetcher, render_fn=self.render_fn,
                                   qc_fn=self.qc_fn, sync=self.sync, root=self.root)

    def test_only_the_named_scene_is_refetched_and_rerendered(self):
        result = self.run_repair(("s001",))
        self.assertEqual(self.renderer.calls, ["s001"])
        self.assertEqual(result.rendered, ["s001"])
        self.assertEqual(sorted(result.cache_hits), ["s000", "s002"])
        after = video_ir.load(self.run_dir / "project.json")
        for sid in ("s000", "s002"):
            self.assertEqual(after.scene(sid).asset_ids, self.original.scene(sid).asset_ids)
        self.assertNotEqual(after.scene("s001").asset_ids, self.original.scene("s001").asset_ids)
        new = after.asset(after.scene("s001").asset_ids[0])
        self.assertEqual(new.rights.status, "ok")
        self.assertIsNotNone(new.sha256)
        self.assertEqual(self.fetcher.searches_made, 1)

    def test_replacement_never_reuses_a_clip_the_run_has(self):
        self.run_repair(("s001",))
        self.assertTrue({"100", "101", "102"} <= self.fetcher.excluded_seen[0])

    def test_kept_scene_is_rerendered_from_its_same_assets_when_cache_is_gone(self):
        for f in (self.run_dir / "scenes").glob("s000-*.mp4"):
            f.unlink()
        result = self.run_repair(("s001",))
        self.assertEqual(sorted(self.renderer.calls), ["s000", "s001"])
        self.assertEqual(result.cache_hits, ["s002"])

    def test_no_footage_found_fails_without_touching_the_ir_or_video(self):
        self.fetcher.videos_per_search = 0
        self.fetcher.images = False
        before_ir = (self.run_dir / "project.json").read_text()
        before_video = (self.run_dir / "final_video.mp4").read_bytes()
        with self.assertRaises(scene_repair.RepairFailed):
            self.run_repair(("s001",))
        self.assertEqual((self.run_dir / "project.json").read_text(), before_ir)
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), before_video)
        self.assertEqual(self.renderer.calls, [])

    def test_previous_approval_is_invalidated(self):
        result = self.run_repair(("s001", "s002"))
        at = scene_repair.repaired_at(self.slug, self.root)
        self.assertIsNotNone(at)
        tables = [(t, v) for t, _, v in self.sync.updates]
        self.assertIn(("videos", {"review_state": "pending"}), tables)
        filters = {t + ":" + f.get("action", ""): f for t, f, _ in self.sync.updates}
        self.assertEqual(filters["videos:"]["review_state"], "eq.approved")
        self.assertEqual(filters["review_intents:eq.approve"]["consumed_at"], "is.null")
        self.assertEqual(filters["review_intents:eq.regenerate_scene"]["scene_id"], "in.(s001,s002)")
        self.assertTrue(result.approvals["videos_reset"])

    def test_report_says_held_not_published_and_gate_not_evaluated(self):
        result = self.run_repair(("s001",))
        meta = result.to_metadata()
        self.assertFalse(meta["published"])
        self.assertEqual(meta["gate"], "not_evaluated")
        report = json.loads((self.run_dir / "repair.json").read_text())
        self.assertEqual(report["scene_ids"], ["s001"])
        self.assertNotIn(str(self.root), json.dumps(meta))   # ids and counts, no paths
        self.assertEqual([e["start_ms"] for e in self.qc_timeline], [0, 4000, 8000])

    def test_cli_repairs_holds_and_never_uploads(self):
        emitted = []
        with mock.patch("modules.event_log.emit", side_effect=lambda ev, **kw: emitted.append((ev, kw))), \
                mock.patch("modules.youtube_uploader.YouTubeUploader") as uploader:
            code = scene_repair.cli(channel=self.CHANNEL, raw_scenes="1", root=self.root,
                                    check_tools=False, fetcher=self.fetcher,
                                    render_fn=self.render_fn, qc_fn=self.qc_fn, sync=self.sync)
        self.assertEqual(code, scene_repair.EXIT_OK)
        uploader.assert_not_called()
        names = [e for e, _ in emitted]
        self.assertIn("repair.completed", names)
        held = [kw for e, kw in emitted if e == "publish.held"]
        self.assertEqual(held[0]["metadata"]["reason"], "repaired_awaiting_review")
        self.assertNotIn("publish.allowed", names)


# ── two-person approvals decided before a repair no longer count ────────────

class ApprovalNotBefore(unittest.TestCase):
    def sync(self, decided_at):
        return SimpleNamespace(enabled=True, select=lambda table, params: [
            {"video_ref": "the-lost-city", "decided_by": "b", "requested_by": "a",
             "decided_at": decided_at}])

    def test_approval_before_repair_is_void(self):
        self.assertFalse(publish_approval.has_approved(
            "news", slug="the-lost-city", sync=self.sync("2026-09-01T10:00:00+00:00"),
            not_before="2026-09-02T00:00:00+00:00"))

    def test_approval_after_repair_counts(self):
        self.assertTrue(publish_approval.has_approved(
            "news", slug="the-lost-city", sync=self.sync("2026-09-03T10:00:00Z"),
            not_before="2026-09-02T00:00:00+00:00"))

    def test_undated_approval_or_bad_cutoff_does_not_count(self):
        self.assertFalse(publish_approval.has_approved(
            "news", slug="the-lost-city", sync=self.sync(None), not_before="2026-09-02T00:00:00+00:00"))
        self.assertFalse(publish_approval.has_approved(
            "news", slug="the-lost-city", sync=self.sync("2026-09-03T10:00:00Z"), not_before="garbage"))

    def test_without_a_repair_behaviour_is_unchanged(self):
        self.assertTrue(publish_approval.has_approved(
            "news", slug="the-lost-city", sync=self.sync(None)))

    def test_main_passes_the_repair_time(self):
        src = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        self.assertIn("not_before=scene_repair.repaired_at(slug)", src)


# ── the workflow ────────────────────────────────────────────────────────────

class Validate(unittest.TestCase):
    def run_validate(self, **env):
        base = {"REPAIR_SCENES": "", "REPAIR_CHANNEL": "", "REPAIR_RESUME": ""}
        base.update(env)
        with mock.patch.dict("os.environ", base):
            return scene_repair._validate_main([])

    def test_ok(self):
        self.assertEqual(self.run_validate(REPAIR_SCENES="3,17", REPAIR_CHANNEL="news"), 0)

    def test_needs_a_channel_and_no_resume(self):
        self.assertEqual(self.run_validate(REPAIR_SCENES="3"), 2)
        self.assertEqual(self.run_validate(REPAIR_SCENES="3", REPAIR_CHANNEL="n", REPAIR_RESUME="true"), 2)
        self.assertEqual(self.run_validate(REPAIR_SCENES="3;id", REPAIR_CHANNEL="n"), 2)


class Workflow(unittest.TestCase):
    def setUp(self):
        import yaml

        wf = yaml.safe_load((Path(__file__).resolve().parent.parent / ".github" / "workflows"
                             / "daily_video.yml").read_text())
        self.wf = wf
        self.steps = wf["jobs"]["make-video"]["steps"]
        self.names = [s.get("name", "") for s in self.steps]

    def test_input_exists_and_defaults_empty(self):
        inputs = self.wf[True]["workflow_dispatch"]["inputs"]   # yaml reads `on:` as True
        self.assertEqual(inputs["repair_scenes"]["default"], "")

    def test_input_reaches_main_only_through_the_environment(self):
        run = next(s for s in self.steps if s.get("name") == "Run Chronos bot")
        self.assertIn("INPUT_REPAIR_SCENES", run["env"])
        self.assertIn('--repair-scenes "$INPUT_REPAIR_SCENES"', run["run"])
        self.assertNotIn("inputs.repair_scenes", run["run"])

    def test_resolve_validates_before_the_render_job(self):
        steps = self.wf["jobs"]["resolve"]["steps"]
        v = next(s for s in steps if s.get("name") == "Validate repair request")
        self.assertIn("scene_repair validate", v["run"])
        self.assertNotIn("${{", v["run"])

    def test_kit_is_opt_in_and_restored_after_run_state(self):
        self.assertLess(self.names.index("Load run state into output/"),
                        self.names.index("Load repair kit into output/"))
        self.assertLess(self.names.index("Load repair kit into output/"), self.names.index("Run Chronos bot"))
        save = self.steps[self.names.index("Save repair kit (opt-in)")]
        self.assertIn("CHRONOS_REPAIR_KIT", save["if"])
        self.assertIn(".repair_kit", save["with"]["path"])


if __name__ == "__main__":
    unittest.main()
