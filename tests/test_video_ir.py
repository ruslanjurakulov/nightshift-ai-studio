"""Tests for modules.video_ir — the Video IR v1 contract, builder and hook.

What is pinned here:
  * scene start/end come from the REAL audio timeline (the master clock), and
    the scene durations add up to the narration within 0.5 s;
  * a built project validates, against the hand validator and (when the
    library is installed) the JSON Schema twin, and the two agree on fields;
  * to_dict/from_dict round-trips exactly;
  * unknowns are null / empty — never 0, never invented;
  * the pipeline hook writes project.json + a checkpoint entry and never raises.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from modules import director, run_checkpoint, video_ir
from modules.elements import Element
from modules.minimax_broll import GenerationResult
from modules.script_engine import Script, ScriptEngine, ScriptSection
from modules.video_review import VideoReview

ROOT = Path(__file__).resolve().parent.parent


def _script(*sections):
    return Script(
        topic="The Lighthouse", title="3 Men Vanished", title_ab="", description="", tags=[],
        hook_sentence="", sections=list(sections), thumbnail_prompt_a="", thumbnail_prompt_b="",
        thumbnail_overlay_text="", open_loops=[],
    )


def _sec(name, stype="story", narration="", keywords=(), cut=5.0, hint=30):
    return ScriptSection(name=name, narration=narration or f"[MUSIC:story_low] {name} text.",
                         duration_hint=hint, section_type=stype, cut_interval=cut,
                         keywords=list(keywords))


def _timeline(*durations_ms):
    out, t = [], 0
    for i, d in enumerate(durations_ms):
        out.append({"section": f"s{i}", "start_ms": t, "end_ms": t + d})
        t += d
    return out


class FakeScriptTestCase(unittest.TestCase):
    def setUp(self):
        self.script = _script(
            _sec("hook", "hook", "[SFX:boom] The keeper vanished. [PAUSE:1.0] Gone.",
                 keywords=["storm lighthouse"], cut=2.0, hint=15),
            _sec("the_log", narration="The log book mentioned the keeper and the storm.",
                 keywords=["old journal"], hint=45),
            _sec("resolution", narration="In the end the sea took them.", keywords=["calm sea"]),
        )
        # Deliberately NOT the duration hints (15/45/30): the audio decides.
        self.timeline = _timeline(12_437, 51_020, 27_300)
        self.plans = director.plan_video(self.script.sections, "dark cinematic")
        self.elements = [Element(kind="character", name="the keeper", description="bearded man"),
                         Element(kind="location", name="lighthouse")]
        self.videos = [Path("/m/videos/1.mp4"), Path("/m/videos/2.mp4"),
                       Path("/m/videos/gen_1.mp4")]
        self.images = [Path("/m/images/gen_img.png"), Path("/m/images/p1.jpg")]
        self.terms = {"/m/videos/1.mp4": "storm lighthouse", "/m/videos/2.mp4": "calm sea",
                      "/m/videos/gen_1.mp4": "old journal"}
        self.project = video_ir.build_project(
            slug="the-lighthouse", script=self.script, timeline=self.timeline,
            channel_id="default", audio_path="/o/audio/final_audio.mp3",
            subtitles_path="/o/subtitles.srt", shot_plans=self.plans, elements=self.elements,
            video_paths=self.videos, image_paths=self.images, clip_terms=self.terms,
            generated_videos={1: "/m/videos/gen_1.mp4"}, generated_task_ids={1: "task-42"},
            video_provider="minimax", video_model="MiniMax-H3",
            generated_images=["/m/images/gen_img.png"], image_provider="leonardo",
            image_model="model-x",
        )

    def test_scene_ids_and_order(self):
        self.assertEqual([s.id for s in self.project.scenes], ["s000", "s001", "s002"])
        self.assertEqual([s.index for s in self.project.scenes], [0, 1, 2])
        self.assertEqual(self.project.scenes[0].type, "hook")

    def test_times_come_from_the_audio_timeline_not_hints(self):
        s0, s1, s2 = self.project.scenes
        self.assertEqual((s0.start_s, s0.end_s), (0.0, 12.437))
        self.assertEqual((s1.start_s, s1.end_s), (12.437, 63.457))
        self.assertEqual((s2.start_s, s2.end_s), (63.457, 90.757))
        self.assertEqual(self.project.audio.duration_s, 90.757)

    def test_scene_durations_sum_to_narration_within_half_a_second(self):
        total = sum(s.duration_s for s in self.project.scenes)
        self.assertLessEqual(abs(total - self.project.audio.duration_s), 0.5)

    def test_narration_is_cue_stripped(self):
        self.assertEqual(self.project.scenes[0].narration, "The keeper vanished. Gone.")

    def test_shot_comes_from_the_director(self):
        for scene, plan in zip(self.project.scenes, self.plans):
            self.assertEqual(scene.shot.recipe, plan.recipe)
            self.assertEqual(scene.shot.camera, plan.camera_move)
            self.assertEqual(scene.shot.lighting, plan.lighting)
            self.assertEqual(scene.shot.mood, plan.mood)

    def test_elements_are_linked_by_mention(self):
        self.assertEqual(self.project.scenes[0].element_ids, ("el_character_the-keeper",))
        self.assertEqual(self.project.scenes[1].element_ids, ("el_character_the-keeper",))
        self.assertEqual(self.project.scenes[2].element_ids, ())

    def test_assets_provenance_is_known_or_null(self):
        by_path = {a.path: a for a in self.project.assets}
        self.assertEqual(len(by_path), 5)
        gen = by_path["/m/videos/gen_1.mp4"]
        self.assertEqual((gen.kind, gen.source, gen.provider, gen.model, gen.task_id),
                         ("video", "generated", "minimax", "MiniMax-H3", "task-42"))
        img = by_path["/m/images/gen_img.png"]
        self.assertEqual((img.kind, img.source, img.provider, img.model),
                         ("image", "generated", "leonardo", "model-x"))
        stock = by_path["/m/videos/1.mp4"]
        self.assertEqual((stock.source, stock.provider, stock.task_id), ("stock", "pexels", None))
        for a in self.project.assets:
            # Not established by this PR — null, never a made-up value or 0.
            for f in ("url", "license", "author", "prompt", "cost_usd", "sha256"):
                self.assertIsNone(getattr(a, f), f)
            self.assertEqual(a.rights.status, "unknown")

    def test_generated_clip_is_tied_to_its_scene(self):
        gen_id = video_ir.asset_id("/m/videos/gen_1.mp4")
        self.assertIn(gen_id, self.project.scenes[1].asset_ids)

    def test_placement_follows_keyword_relevance(self):
        # The hook's best match is the lighthouse clip; stills never go under the hook.
        hook = self.project.scenes[0]
        self.assertEqual(hook.asset_ids[0], video_ir.asset_id("/m/videos/1.mp4"))
        still_ids = {video_ir.asset_id(str(p)) for p in self.images}
        self.assertFalse(still_ids & set(hook.asset_ids))
        self.assertEqual(self.project.scenes[2].asset_ids[0], video_ir.asset_id("/m/videos/2.mp4"))

    def test_claims_are_empty_when_unknown(self):
        self.assertTrue(all(s.claim_ids == () for s in self.project.scenes))

    def test_claim_ids_come_from_the_claim_scene_linkage(self):
        project = video_ir.build_project(slug="x", script=self.script, timeline=self.timeline,
                                         claim_ids={1: ["c001-01", "c001-01u"]})
        self.assertEqual(project.scenes[1].claim_ids, ("c001-01", "c001-01u"))
        self.assertEqual(project.scenes[0].claim_ids, ())

    def test_built_project_validates(self):
        self.assertEqual(self.project.validate(), [])

    def test_round_trip(self):
        d = self.project.to_dict()
        again = video_ir.VideoProject.from_dict(json.loads(json.dumps(d)))
        self.assertEqual(again, self.project)
        self.assertEqual(again.to_dict(), d)

    def test_top_level_contract_keys(self):
        d = self.project.to_dict()
        self.assertEqual(list(d), ["version", "slug", "channel_id", "title", "width", "height",
                                   "fps", "audio", "subtitles_path", "scenes", "assets"])
        self.assertEqual(d["version"], 1)
        self.assertEqual(list(d["scenes"][0]), ["id", "index", "name", "type", "narration",
                                                "start_s", "end_s", "shot", "element_ids",
                                                "asset_ids", "claim_ids"])
        self.assertEqual(list(d["scenes"][0]["shot"]), ["recipe", "camera", "lighting", "mood"])
        self.assertEqual(list(d["assets"][0]), ["id", "kind", "path", "source", "provider", "url",
                                                "license", "author", "model", "prompt", "task_id",
                                                "cost_usd", "sha256", "rights"])


class DemoScriptTestCase(unittest.TestCase):
    """The committed demo script with a realistic (non-hint) timeline."""

    def test_demo_script_builds_and_validates(self):
        script = ScriptEngine.load(ROOT / "samples" / "demo_script.json")
        durations = [13_900, 26_100, 38_800, 34_250, 41_700, 35_050, 29_600][: len(script.sections)]
        timeline = _timeline(*durations)
        project = video_ir.build_project(slug="demo", script=script, timeline=timeline,
                                         shot_plans=director.plan_video(script.sections))
        self.assertEqual(project.validate(), [])
        total = sum(s.duration_s for s in project.scenes)
        self.assertAlmostEqual(total, sum(durations) / 1000.0, delta=0.5)
        self.assertEqual(len(project.scenes), len(script.sections))


class NullIsNotZeroTestCase(unittest.TestCase):
    def test_missing_timeline_leaves_times_null(self):
        script = _script(_sec("a"), _sec("b"))
        project = video_ir.build_project(slug="x", script=script, timeline=_timeline(5000))
        self.assertEqual((project.scenes[0].start_s, project.scenes[0].end_s), (0.0, 5.0))
        self.assertIsNone(project.scenes[1].start_s)
        self.assertIsNone(project.scenes[1].end_s)
        self.assertIsNone(project.scenes[1].duration_s)
        self.assertEqual(project.validate(), [])

    def test_no_timeline_no_audio_duration(self):
        project = video_ir.build_project(slug="x", script=_script(_sec("a")), timeline=[])
        self.assertIsNone(project.audio.duration_s)
        self.assertIsNone(project.audio.path)
        self.assertEqual(project.scenes[0].shot, video_ir.Shot())  # no plan -> all null
        self.assertEqual(project.scenes[0].asset_ids, ())
        self.assertEqual(project.validate(), [])


class ValidateTestCase(unittest.TestCase):
    def base(self):
        return video_ir.build_project(
            slug="x", script=_script(_sec("a", keywords=["k"])), timeline=_timeline(4000),
            video_paths=[Path("/v.mp4")],
        ).to_dict()

    def test_rejects_non_object(self):
        self.assertTrue(video_ir.validate([]))

    def test_catches_contract_violations(self):
        cases = [
            (lambda d: d.update(version=2), "version"),
            (lambda d: d.pop("audio"), "audio is missing"),
            (lambda d: d.update(extra=1), "not a known field"),
            (lambda d: d["scenes"][0].update(id="scene-1"), "look like"),
            (lambda d: d["scenes"][0].update(id="s001"), "does not match index"),
            (lambda d: d["scenes"][0].update(start_s=5.0, end_s=1.0), "before start_s"),
            (lambda d: d["scenes"][0].update(start_s=-1), "non-negative"),
            (lambda d: d["scenes"][0].update(asset_ids=["a_missing"]), "unknown asset"),
            (lambda d: d["scenes"][0]["shot"].pop("mood"), "mood is missing"),
            (lambda d: d["assets"][0]["rights"].update(status="fine"), "rights.status"),
            (lambda d: d["assets"][0].update(kind="gif"), "kind"),
            (lambda d: d["assets"][0].update(cost_usd="free"), "cost_usd"),
            (lambda d: d.update(width=0), "width"),
            (lambda d: d["assets"].append(dict(d["assets"][0])), "duplicated"),
        ]
        for mutate, needle in cases:
            d = self.base()
            self.assertEqual(video_ir.validate(d), [])
            mutate(d)
            problems = video_ir.validate(d)
            self.assertTrue(any(needle in p for p in problems), (needle, problems))


class SchemaTwinTestCase(unittest.TestCase):
    def setUp(self):
        self.schema = json.loads(video_ir.SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_schema_and_validator_agree_on_fields(self):
        s = self.schema
        self.assertEqual(tuple(s["required"]), video_ir._PROJECT_KEYS)
        self.assertEqual(tuple(s["$defs"]["scene"]["required"]), video_ir._SCENE_KEYS)
        self.assertEqual(tuple(s["$defs"]["scene"]["properties"]["shot"]["required"]),
                         video_ir._SHOT_KEYS)
        self.assertEqual(tuple(s["$defs"]["asset"]["required"]), video_ir._ASSET_KEYS)
        self.assertEqual(tuple(s["properties"]["audio"]["required"]), video_ir._AUDIO_KEYS)
        self.assertEqual(
            s["$defs"]["asset"]["properties"]["rights"]["properties"]["status"]["enum"],
            list(video_ir.RIGHTS_STATUSES))
        self.assertEqual(s["$defs"]["asset"]["properties"]["kind"]["enum"],
                         list(video_ir.ASSET_KINDS))
        self.assertEqual(s["properties"]["version"]["const"], video_ir.VERSION)

    def test_built_project_matches_json_schema_when_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed (not a project dependency)")
        project = FakeScriptTestCase("test_round_trip")
        project.setUp()
        jsonschema.validate(project.project.to_dict(), self.schema)


class WriteForRunTestCase(unittest.TestCase):
    def test_writes_project_json_and_checkpoint(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            broll = GenerationResult(attempted=1, generated=1, model="MiniMax-H3",
                                     by_section={0: str(root / "gen_0.mp4")},
                                     task_ids={0: "t-1"})
            project = video_ir.write_for_run(
                slug="slug-x", script=_script(_sec("a", "hook"), _sec("b")),
                timeline=_timeline(3000, 4000), channel_id="default",
                audio_path=root / "a.mp3", subtitles_path=root / "s.srt",
                shot_plans=[], elements=[], video_paths=[root / "gen_0.mp4"], image_paths=[],
                clip_terms={}, broll=broll, generated_images=[], root=root,
                scene_plan=[{"name": "a", "claim_ids": []}, {"name": "b", "claim_ids": ["c1"]}],
            )
            self.assertIsNotNone(project)
            path = root / "slug-x" / "project.json"
            self.assertTrue(path.exists())
            loaded = video_ir.load(path)
            self.assertEqual(loaded, project)
            self.assertEqual(loaded.validate(), [])
            self.assertEqual(loaded.assets[0].task_id, "t-1")
            self.assertEqual([sc.claim_ids for sc in loaded.scenes], [(), ("c1",)])
            cp = run_checkpoint.load("slug-x", root)
            self.assertEqual(cp.artifact(run_checkpoint.STAGE_PROJECT, "project_json"), str(path))

    def test_never_raises(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertLogs("modules.video_ir", level="WARNING"):
                out = video_ir.write_for_run(slug="s", script=_script(_sec("a")),
                                             timeline=_timeline(1000), shot_plans=object(),
                                             root=Path(d))
            self.assertIsNone(out)

    def test_mocked_pipeline_objects_do_not_break_it(self):
        with tempfile.TemporaryDirectory() as d:
            out = video_ir.write_for_run(slug="s", script=MagicMock(), timeline=MagicMock(),
                                         broll=MagicMock(), root=Path(d))
            # Either a project or None — but no exception.
            self.assertTrue(out is None or isinstance(out, video_ir.VideoProject))

    def test_load_of_missing_file_is_none(self):
        self.assertIsNone(video_ir.load(Path("/no/such/project.json")))


class AnnotateScenesTestCase(unittest.TestCase):
    def test_adds_real_times_by_position(self):
        scenes = [{"name": "hook", "duration_hint": 15}, {"name": "b", "duration_hint": 40}]
        manifest = {"scenes": [{"id": "s000", "start_s": 0.0, "end_s": 12.4},
                               {"id": "s001", "start_s": 12.4, "end_s": None}]}
        out = video_ir.annotate_scenes(scenes, manifest)
        self.assertEqual(out[0], {"name": "hook", "duration_hint": 15, "id": "s000",
                                  "start_s": 0.0, "end_s": 12.4})
        self.assertIsNone(out[1]["end_s"])
        self.assertNotIn("id", scenes[0])  # input untouched

    def test_passthrough_without_manifest(self):
        scenes = [{"name": "a"}]
        self.assertIs(video_ir.annotate_scenes(scenes, None), scenes)
        self.assertIsNone(video_ir.annotate_scenes(None, {"scenes": []}))


class VideoReviewManifestTestCase(unittest.TestCase):
    def setUp(self):
        self.r = VideoReview(url="https://x.supabase.co", service_key="k")
        self.r.upload_preview = MagicMock(return_value=None)
        self.r.prune = MagicMock()
        self.r._upsert_video = MagicMock(return_value=True)
        self.manifest = {"version": 1, "scenes": [{"id": "s000", "start_s": 0.0, "end_s": 9.5}]}

    def test_manifest_and_timed_scenes_ride_the_patch(self):
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"), script_text="x",
                      auto_publish=False, scenes=[{"name": "hook", "duration_hint": 15}],
                      manifest=self.manifest)
        patch = self.r._upsert_video.call_args[0][0]
        self.assertEqual(patch["manifest"], self.manifest)
        self.assertEqual(patch["scenes"][0]["start_s"], 0.0)
        self.assertEqual(patch["scenes"][0]["end_s"], 9.5)
        self.assertEqual(patch["scenes"][0]["id"], "s000")

    def test_unmigrated_database_retries_without_manifest(self):
        self.r._upsert_video = MagicMock(side_effect=[False, True])
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"), script_text="x",
                      auto_publish=False, scenes=[{"name": "hook"}], manifest=self.manifest)
        self.assertEqual(self.r._upsert_video.call_count, 2)
        second = self.r._upsert_video.call_args_list[1][0][0]
        self.assertNotIn("manifest", second)
        self.assertEqual(second["scenes"][0]["end_s"], 9.5)

    def test_no_manifest_is_exactly_as_before(self):
        self.r.record(video_id="v", channel_id="c", video_path=Path("/x.mp4"), script_text="x",
                      auto_publish=False, scenes=[{"name": "hook"}])
        patch = self.r._upsert_video.call_args[0][0]
        self.assertNotIn("manifest", patch)
        self.assertEqual(patch["scenes"], [{"name": "hook"}])


class MigrationTestCase(unittest.TestCase):
    def test_0013_is_additive_and_idempotent(self):
        sql = (ROOT / "supabase" / "migrations" / "0013_video_manifest.sql").read_text()
        self.assertIn("add column if not exists manifest jsonb", sql)
        lowered = sql.lower()
        for bad in ("drop ", "delete ", "truncate ", "alter column"):
            self.assertNotIn(bad, lowered)


if __name__ == "__main__":
    unittest.main()
