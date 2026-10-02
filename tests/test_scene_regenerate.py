"""Scene regeneration v2 (modules/scene_regenerate.py, migration 0076).

What is pinned here, and what would break without it:
  * a generated scene is made again by the SAME provider and model, through a
    fake adapter — never by another generator, never silently from stock;
  * the provider being unavailable (no key, another model configured, a
    refusal) stops the run before anything is spent, with the remedy, no stock
    search made, the old scene and cut untouched;
  * stock is used for a generated scene only when the person chose it, and
    the choice is recorded on the new assets;
  * a failure part-way leaves the run's Video IR and cut exactly as they were;
    the previous take (IR, cut, old asset files) is kept after a success;
  * a re-queued attempt polls the clip it already paid for instead of paying
    again, and never reuses the ORIGINAL clip of the same prompt;
  * the old repair path refuses a generated scene instead of giving it stock;
  * the worker claims and settles a regeneration through the database, by
    its result, and never through the per-minute settle of a video run.
"""

import json
import os
import sys
import tempfile
import textwrap
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from modules import provider_tasks, run_request, scene_render, scene_regenerate, scene_repair, video_ir
from modules.minimax_broll import VideoModelUnavailable
from modules.video_ir import AssetRef, Scene, VideoProject
from tests.test_scene_repair import Base, FakeFetcher, FakeSync, fake_assemble

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import queue_worker as qw  # noqa: E402

RID = "0b8f3c2e-5d4a-4e1f-9a7b-2c6d8e0f1a3b"
PROVIDER, MODEL = "kling", "kling-v2-6"


class FakeGenerator:
    """A provider adapter with the split submit/resume API. Writes a clip per
    task; counts every billable submit."""

    supports_task_resume = True

    def __init__(self, model=MODEL, *, fail_with=None, outcome=provider_tasks.OUTCOME_SUCCEEDED, refuse=False):
        self.cfg = mock.Mock(model=model)
        self.submits = []
        self.resumes = []
        self.fail_with = fail_with
        self.outcome = outcome
        self.refuse = refuse

    def submit(self, spec):
        if self.refuse:
            raise VideoModelUnavailable(PROVIDER, self.cfg.model, "refused the credentials", "check the key")
        self.submits.append(spec)
        return f"task-{len(self.submits)}"

    def resume(self, task_id, out_path):
        self.resumes.append(task_id)
        if self.outcome != provider_tasks.OUTCOME_SUCCEEDED:
            return provider_tasks.TaskOutcome(self.outcome, reason="the provider said no")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_bytes(f"generated {task_id}".encode())
        return provider_tasks.TaskOutcome(provider_tasks.OUTCOME_SUCCEEDED, Path(out_path))


#: Stands for "the ids the database priced" until a test on a real run fills
#: them in from the scene on disk (RunWithGeneratedScene.cli).
PRICED = "a_priced"


def env(**kw):
    out = {"SCENE_REGEN_ID": RID, "SCENE_REGEN_SOURCE": "generated", "SCENE_REGEN_PROVIDER": PROVIDER,
           "SCENE_REGEN_MODEL": MODEL, "SCENE_REGEN_PREVIOUS_ASSETS": PRICED,
           "SCENE_REGEN_GENERATED_CLIPS": "1", "SCENE_REGEN_STOCK_ASSETS": "0"}
    out.update({k: v for k, v in kw.items() if v is not None})
    return {k: v for k, v in out.items() if v != ""}


class RunWithGeneratedScene(Base):
    """A run of three scenes; s001 was made by a generator."""

    def setUp(self):
        super().setUp()
        project = self.make_run(n=3)
        gen_path = self.run_dir / "media" / "generated" / "s001_0.mp4"
        gen_path.parent.mkdir(parents=True)
        gen_path.write_bytes(b"original generated clip")
        gen = AssetRef(id=video_ir.asset_id(str(gen_path)), kind="video", path=str(gen_path),
                       source="generated", provider=PROVIDER, model=MODEL, prompt="harbour at dawn",
                       sha256=video_ir.file_sha256(gen_path))
        scenes = tuple(Scene(**{**s.__dict__, "asset_ids": (gen.id,)}) if s.id == "s001" else s
                       for s in project.scenes)
        self.original = VideoProject(**{**project.__dict__, "scenes": scenes,
                                        "assets": project.assets + (gen,)})
        self.gen_path = gen_path
        video_ir.save(self.original, self.run_dir / "project.json")
        scene_render.render_project(self.original, self.run_dir / "final_video.mp4",
                                    renderers={"ffmpeg": self.renderer}, assemble_fn=fake_assemble)
        self.renderer.calls.clear()
        self.fetcher = FakeFetcher(self.run_dir)
        self.sync = FakeSync()
        for target in ("_record_costs", "_record_repaired_row"):
            p = mock.patch.object(scene_repair, target)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(scene_regenerate, "_record_costs")
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch("modules.event_log.emit")
        e.start()
        self.addCleanup(e.stop)

    def priced(self, environ, scene):
        """The terms the database would hand over for ``scene`` of the run
        as it is on disk now (unless the test set them on purpose)."""
        environ = dict(environ)
        if environ.get("SCENE_REGEN_PREVIOUS_ASSETS") == PRICED:
            p = video_ir.load(self.run_dir / "project.json")
            ids = p.scene(scene).asset_ids
            assets = [p.asset(a) for a in ids]
            gen = sum(1 for a in assets if a.source == "generated")
            stock = sum(1 for a in assets if a.source == "stock")
            explicit = environ.get("SCENE_REGEN_EXPLICIT_STOCK") == "true"
            environ["SCENE_REGEN_PREVIOUS_ASSETS"] = ",".join(ids)
            if environ.get("SCENE_REGEN_SOURCE") == "generated":
                environ["SCENE_REGEN_GENERATED_CLIPS"], environ["SCENE_REGEN_STOCK_ASSETS"] = str(gen), str(stock)
            else:
                environ["SCENE_REGEN_GENERATED_CLIPS"] = "0"
                environ["SCENE_REGEN_STOCK_ASSETS"] = str(len(ids) if explicit else stock)
        return environ

    def cli(self, environ, client=None, get_client=None, scene="s001", **extra):
        environ = self.priced(environ, scene)
        inject = {"check_tools": False, "fetcher": self.fetcher, "render_fn": self.render_fn,
                  "qc_fn": self.qc_fn, "sync": self.sync, **extra}
        if client is not None:
            inject["client"] = client
        if get_client is not None:
            inject["get_client"] = get_client
        return scene_regenerate.cli(channel=self.CHANNEL, raw_scene=scene, topic=self.slug, env=environ,
                                    root=self.root, **inject)

    def result(self):
        return scene_regenerate.read_result(self.root, self.slug, RID)

    def current(self):
        return video_ir.load(self.run_dir / "project.json")


class TheRequest(unittest.TestCase):
    def test_a_generated_request_names_its_generator(self):
        r = scene_regenerate.RegenRequest.from_env("s001", env(SCENE_REGEN_PROMPT="wider"))
        self.assertEqual((r.source_kind, r.provider, r.model, r.prompt, r.explicit_stock),
                         ("generated", PROVIDER, MODEL, "wider", False))

    def test_malformed_terms_are_refused_not_guessed(self):
        bad = [env(SCENE_REGEN_ID="not-a-uuid"), env(SCENE_REGEN_SOURCE="best"),
               env(SCENE_REGEN_PROVIDER="other"), env(SCENE_REGEN_MODEL="bad model"),
               env(SCENE_REGEN_SOURCE="stock"),  # stock naming a generator
               env(SCENE_REGEN_PROMPT="x" * 1001), env(SCENE_REGEN_PROMPT="a\nb"),
               env(SCENE_REGEN_EXPLICIT_STOCK="true")]  # an explicit stock choice that is not stock
        # BR-L-033: what was priced must be handed over, well-formed.
        bad += [env(SCENE_REGEN_PREVIOUS_ASSETS=""), env(SCENE_REGEN_PREVIOUS_ASSETS="a,a"),
                env(SCENE_REGEN_PREVIOUS_ASSETS="a b"), env(SCENE_REGEN_PREVIOUS_ASSETS=",".join("a%d" % i for i in range(9))),
                env(SCENE_REGEN_GENERATED_CLIPS=""), env(SCENE_REGEN_GENERATED_CLIPS="x"),
                env(SCENE_REGEN_GENERATED_CLIPS="0"),  # a generated scene priced with no clip
                env(SCENE_REGEN_GENERATED_CLIPS="2")]  # more clips than assets
        for e in bad:
            with self.subTest(e=e), self.assertRaises(scene_regenerate.RegenRequestError):
                scene_regenerate.RegenRequest.from_env("s001", e)

    def test_exactly_one_scene(self):
        self.assertEqual(scene_regenerate.parse_scene("1"), "s001")
        for raw in ("1,2", "", "1;x"):
            with self.subTest(raw=raw), self.assertRaises(scene_regenerate.RegenRequestError):
                scene_regenerate.parse_scene(raw)


class SameGenerator(RunWithGeneratedScene):
    def test_the_scene_is_made_again_by_the_same_provider_and_model(self):
        gen = FakeGenerator()
        code = self.cli(env(), get_client=lambda name: gen if name == PROVIDER else None)
        self.assertEqual(code, scene_regenerate.EXIT_OK)
        self.assertEqual(len(gen.submits), 1)
        self.assertEqual(gen.submits[0].prompt, "harbour at dawn")  # the clip's own prompt
        self.assertEqual(self.fetcher.searches_made, 0, "a generated scene was searched on stock")
        new = self.current()
        a = new.asset(new.scene("s001").asset_ids[0])
        self.assertEqual((a.source, a.provider, a.model, a.task_id), ("generated", PROVIDER, MODEL, "task-1"))
        # Only this scene changed; the others keep their assets byte for byte.
        for sid in ("s000", "s002"):
            self.assertEqual(new.scene(sid).asset_ids, self.original.scene(sid).asset_ids)
        self.assertEqual(self.renderer.calls, ["s001"])
        r = self.result()
        self.assertTrue(r["ok"])
        self.assertEqual(r["gate"], "not_evaluated")
        self.assertIs(r["published"], False)
        self.assertEqual(r["previous_asset_ids"], [self.original.scene("s001").asset_ids[0]])

    def test_a_prompt_edit_replaces_the_clip_prompt(self):
        gen = FakeGenerator()
        self.cli(env(SCENE_REGEN_PROMPT="the harbour at night, rain"), client=gen)
        self.assertEqual(gen.submits[0].prompt, "the harbour at night, rain")

    def test_the_previous_take_is_kept(self):
        before_ir = (self.run_dir / "project.json").read_bytes()
        before_cut = (self.run_dir / "final_video.mp4").read_bytes()
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        kept = scene_regenerate.regen_dir(self.run_dir, RID)
        self.assertEqual((kept / scene_regenerate.PREVIOUS_PROJECT).read_bytes(), before_ir)
        self.assertEqual((kept / scene_regenerate.PREVIOUS_VIDEO).read_bytes(), before_cut)
        self.assertTrue(self.gen_path.is_file(), "the old clip was deleted")
        self.assertNotEqual((self.run_dir / "final_video.mp4").read_bytes(), before_cut)
        # The old asset is still listed in the IR: the previous take is recoverable.
        self.assertIsNotNone(self.current().asset(self.original.scene("s001").asset_ids[0]))

    def test_the_approval_of_the_previous_cut_is_voided(self):
        self.cli(env(), client=FakeGenerator())
        self.assertIn(("videos", {"channel_id": f"eq.{self.CHANNEL}", "slug": f"eq.{self.slug}",
                                  "review_state": "eq.approved"}, {"review_state": "pending"}),
                      self.sync.updates)
        self.assertIsNotNone(scene_repair.repaired_at(self.slug, self.root))


class ProviderUnavailable(RunWithGeneratedScene):
    def assertNothingChanged(self, before_ir, before_cut):
        self.assertEqual((self.run_dir / "project.json").read_bytes(), before_ir)
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), before_cut)
        self.assertEqual(self.fetcher.searches_made, 0, "stock was used in place of the generator")
        self.assertEqual(self.renderer.calls, [])

    def snapshot(self):
        return (self.run_dir / "project.json").read_bytes(), (self.run_dir / "final_video.mp4").read_bytes()

    def test_no_key_for_the_generator_stops_with_the_remedy_and_no_stock(self):
        snap = self.snapshot()
        code = self.cli(env(), get_client=lambda name: None)
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertNothingChanged(*snap)
        r = self.result()
        self.assertEqual(r["error_code"], "provider_unavailable")
        self.assertIn("nothing was charged", r["error"])

    def test_another_model_configured_is_not_a_silent_switch(self):
        snap = self.snapshot()
        gen = FakeGenerator(model="kling-v3")
        code = self.cli(env(), get_client=lambda name: gen)
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertEqual(gen.submits, [])
        self.assertNothingChanged(*snap)
        self.assertEqual(self.result()["error_code"], "model_changed")

    def test_a_refused_first_submit_is_unavailable_and_nothing_changes(self):
        snap = self.snapshot()
        code = self.cli(env(), client=FakeGenerator(refuse=True))
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertNothingChanged(*snap)

    def test_a_failed_clip_keeps_the_old_scene_and_cut(self):
        snap = self.snapshot()
        code = self.cli(env(), client=FakeGenerator(outcome=provider_tasks.OUTCOME_FAILED))
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertNothingChanged(*snap)
        self.assertEqual(self.result()["error_code"], "provider_failed")

    def test_a_scene_made_by_another_generator_than_priced_is_refused(self):
        snap = self.snapshot()
        code = self.cli(env(SCENE_REGEN_PROVIDER="veo", SCENE_REGEN_MODEL="veo-3.1-generate-preview"),
                        client=FakeGenerator())
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertNothingChanged(*snap)
        self.assertEqual(self.result()["error_code"], "scene_changed")


class TheSceneAsPriced(RunWithGeneratedScene):
    """BR-L-033 / BR-L-038: the scene on disk must be exactly the priced one."""

    def snapshot(self):
        return (self.run_dir / "project.json").read_bytes(), (self.run_dir / "final_video.mp4").read_bytes()

    def assertRefused(self, code, snap, gen=None):
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertEqual(self.result()["error_code"], "scene_changed")
        self.assertEqual(self.snapshot(), snap)
        self.assertEqual(self.fetcher.searches_made, 0, "stock was searched for a scene that was not priced")
        self.assertEqual(self.renderer.calls, [])
        if gen is not None:
            self.assertEqual(gen.submits, [], "a clip was paid for a scene that was not priced")

    def rewrite_s001(self, *, model=MODEL, extra_generated=False):
        p = video_ir.load(self.run_dir / "project.json")
        assets = [a for a in p.assets]
        old = p.asset(p.scene("s001").asset_ids[0])
        assets = [replace(a, model=model) if a.id == old.id else a for a in assets]
        ids = [old.id]
        if extra_generated:
            extra = self.run_dir / "media" / "generated" / "s001_1.mp4"
            extra.write_bytes(b"second generated clip")
            ref = AssetRef(id=video_ir.asset_id(str(extra)), kind="video", path=str(extra), source="generated",
                           provider=PROVIDER, model=model, prompt="harbour at dawn",
                           sha256=video_ir.file_sha256(extra))
            assets.append(ref)
            ids.append(ref.id)
        scenes = tuple(replace(sc, asset_ids=tuple(ids)) if sc.id == "s001" else sc for sc in p.scenes)
        video_ir.save(replace(p, scenes=scenes, assets=tuple(assets)), self.run_dir / "project.json")
        return ids

    def test_other_asset_ids_than_priced_are_refused(self):
        snap, gen = self.snapshot(), FakeGenerator()
        self.assertRefused(self.cli(env(SCENE_REGEN_PREVIOUS_ASSETS="a_somethingelse"), client=gen), snap, gen)

    def test_more_generated_clips_on_disk_than_were_priced_are_refused(self):
        ids = self.rewrite_s001(extra_generated=True)
        snap, gen = self.snapshot(), FakeGenerator()
        # The database saw both ids but priced one generated clip.
        code = self.cli(env(SCENE_REGEN_PREVIOUS_ASSETS=",".join(ids), SCENE_REGEN_GENERATED_CLIPS="1",
                            SCENE_REGEN_STOCK_ASSETS="0"), client=gen)
        self.assertRefused(code, snap, gen)

    def test_a_scene_priced_as_stock_that_is_generated_on_disk_never_gets_stock(self):
        snap = self.snapshot()
        gen_id = self.original.scene("s001").asset_ids[0]
        code = self.cli(env(SCENE_REGEN_SOURCE="stock", SCENE_REGEN_PROVIDER="", SCENE_REGEN_MODEL="",
                            SCENE_REGEN_PREVIOUS_ASSETS=gen_id, SCENE_REGEN_GENERATED_CLIPS="0",
                            SCENE_REGEN_STOCK_ASSETS="1"))
        self.assertRefused(code, snap)

    def test_the_same_provider_with_another_model_on_disk_is_refused(self):
        self.rewrite_s001(model="kling-v1-6")
        snap, gen = self.snapshot(), FakeGenerator()
        self.assertRefused(self.cli(env(), client=gen), snap, gen)

    def test_verify_compares_the_model_not_only_the_provider(self):
        project = self.original
        gid = project.scene("s001").asset_ids[0]
        req = scene_regenerate.RegenRequest.from_env("s001", env(SCENE_REGEN_PREVIOUS_ASSETS=gid))
        scene_regenerate.verify_same_scene(project, req)  # as priced: passes
        other = replace(project, assets=tuple(replace(a, model="kling-v1-6") if a.id == gid else a
                                              for a in project.assets))
        with self.assertRaises(scene_regenerate.RegenUnavailable) as cm:
            scene_regenerate.verify_same_scene(other, req)
        self.assertEqual(cm.exception.code, "scene_changed")
        provider = replace(project, assets=tuple(replace(a, provider="veo") if a.id == gid else a
                                                 for a in project.assets))
        with self.assertRaises(scene_regenerate.RegenUnavailable):
            scene_regenerate.verify_same_scene(provider, req)


class CrashPoints(RunWithGeneratedScene):
    """BR-L-034: the cut and IR change only in the final swap, after the
    approval is void and the result naming them is written; whatever point a
    run stops at, a failure leaves (or puts back) the previous take."""

    def setUp(self):
        super().setUp()
        self.before = self.snapshot()

    def snapshot(self):
        return (self.run_dir / "project.json").read_bytes(), (self.run_dir / "final_video.mp4").read_bytes()

    def assertUnchanged(self):
        self.assertEqual(self.snapshot(), self.before)
        self.assertEqual(sorted(p.name for p in self.run_dir.glob(".regen-*")), [], "temp files left behind")

    def settle(self, exited_ok):
        return scene_regenerate.settle_outcome(self.root, self.slug, RID, exited_ok=exited_ok)

    def test_success_is_confirmed_by_the_files_on_disk(self):
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        self.assertNotEqual(self.snapshot(), self.before)
        verdict = self.settle(True)
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(sorted(p.name for p in self.run_dir.glob(".regen-*")), [])

    def test_the_approval_is_void_before_the_cut_changes(self):
        seen = []
        sync = self.sync
        real = sync.update

        def update(table, filters, values):
            seen.append(self.snapshot())
            return real(table, filters, values)

        sync.update = update
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        self.assertTrue(seen)
        self.assertTrue(all(snap == self.before for snap in seen), "the cut changed before its approval was void")

    def test_a_scene_that_did_not_re_render_changes_nothing(self):
        def render(project, output_path, *, cut_intervals=None):
            self.render_fn(project, output_path, cut_intervals=cut_intervals)
            return SimpleNamespace(cache_misses=[])

        code = self.cli(env(), client=FakeGenerator(), render_fn=render)
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "render_failed")
        self.assertUnchanged()

    def test_an_approval_that_cannot_be_voided_stops_before_the_swap(self):
        self.sync.update = lambda *a, **k: False
        code = self.cli(env(), client=FakeGenerator())
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "approval_not_voided")
        self.assertUnchanged()
        self.assertFalse(self.settle(False)["ok"])

    def test_a_result_that_cannot_be_written_stops_before_the_swap(self):
        real = scene_regenerate.write_result

        def write(out_dir, body, *, strict=False):
            if strict:
                raise OSError("disk full")
            return real(out_dir, body, strict=strict)

        with mock.patch.object(scene_regenerate, "write_result", side_effect=write):
            code = self.cli(env(), client=FakeGenerator())
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "result_unwritable")
        self.assertUnchanged()

    def swap_fails(self, exc):
        real = os.replace
        cut = self.run_dir / "final_video.mp4"

        def fake(src, dst):
            if Path(dst) == cut and Path(src).name.startswith(".regen-"):
                raise exc
            return real(src, dst)

        return mock.patch("modules.scene_regenerate.os.replace", side_effect=fake)

    def test_a_swap_that_fails_half_way_puts_the_previous_take_back(self):
        with self.swap_fails(OSError("EIO")):
            code = self.cli(env(), client=FakeGenerator())
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "swap_failed")
        self.assertUnchanged()
        self.assertFalse(self.settle(False)["ok"])

    def test_a_run_killed_half_way_through_the_swap_is_put_back_by_the_worker(self):
        with self.swap_fails(SystemExit(9)), self.assertRaises(SystemExit):
            self.cli(env(), client=FakeGenerator())
        self.assertNotEqual(self.snapshot(), self.before)   # the IR was swapped, the cut was not
        self.assertTrue(self.result()["ok"])                 # and the result already said ok
        verdict = self.settle(False)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "not_confirmed")
        self.assertUnchanged()

    def test_a_run_killed_after_the_swap_is_put_back_by_the_worker(self):
        with mock.patch.object(scene_regenerate, "prune_takes", side_effect=SystemExit(9)), \
                self.assertRaises(SystemExit):
            self.cli(env(), client=FakeGenerator())
        self.assertNotEqual(self.snapshot(), self.before)
        self.assertFalse(self.settle(False)["ok"])
        self.assertUnchanged()

    def test_a_cut_changed_after_the_result_is_not_charged(self):
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")
        verdict = self.settle(True)
        self.assertEqual((verdict["ok"], verdict["code"]), (False, "not_confirmed"))
        self.assertUnchanged()


class DiskGrowth(RunWithGeneratedScene):
    """BR-L-035: bounded per run, for every org, and checked before spending."""

    def make_take(self, n, *, ok=True, clip=False):
        rid = "%08d-0000-4000-8000-000000000000" % (n + 100)
        d = scene_regenerate.regen_dir(self.run_dir, rid)
        d.mkdir(parents=True)
        (d / scene_regenerate.PREVIOUS_VIDEO).write_bytes(b"master %d" % n)
        (d / scene_regenerate.PREVIOUS_PROJECT).write_text("{}")
        if clip:
            (d / "s001_take_0.mp4").write_bytes(b"clip %d" % n)
        (d / scene_regenerate.RESULT_FILENAME).write_text(json.dumps({"ok": ok, "previous_asset_ids": ["a"]}))
        os.utime(d / scene_regenerate.RESULT_FILENAME, (1_000_000 + n, 1_000_000 + n))
        return d

    def test_only_the_last_takes_keep_their_master(self):
        takes = [self.make_take(n) for n in range(8)]
        failed_old = self.make_take(-1, ok=False, clip=True)
        in_use = self.make_take(-2, ok=False, clip=True)
        project = replace(self.original, assets=self.original.assets + (
            AssetRef(id="a_inuse", kind="video", path=str(in_use / "s001_take_0.mp4"), source="generated",
                     provider=PROVIDER, model=MODEL),))
        scene_regenerate.prune_takes(self.run_dir, keep=5, project=project)
        kept = [d for d in takes if (d / scene_regenerate.PREVIOUS_VIDEO).exists()]
        self.assertEqual(kept, takes[3:])
        for d in takes + [failed_old]:
            self.assertTrue((d / scene_regenerate.RESULT_FILENAME).exists(), "the asset ids were removed")
            self.assertTrue((d / scene_regenerate.PREVIOUS_PROJECT).exists())
        self.assertFalse((failed_old / "s001_take_0.mp4").exists())
        self.assertTrue((in_use / "s001_take_0.mp4").exists(), "a clip the cut uses was removed")

    def test_a_success_prunes_older_takes(self):
        takes = [self.make_take(n) for n in range(6)]
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        kept = [d for d in takes if (d / scene_regenerate.PREVIOUS_VIDEO).exists()]
        self.assertEqual(len(kept), scene_regenerate.KEEP_TAKES - 1)  # the new take is one of the five
        self.assertTrue((scene_regenerate.regen_dir(self.run_dir, RID) / scene_regenerate.PREVIOUS_VIDEO).exists())

    def test_a_failure_prunes_older_takes_but_keeps_its_own_master(self):
        takes = [self.make_take(n) for n in range(6)]
        code = self.cli(env(), client=FakeGenerator(outcome=provider_tasks.OUTCOME_FAILED))
        self.assertEqual(code, scene_regenerate.EXIT_FAILED)
        self.assertEqual(sum((d / scene_regenerate.PREVIOUS_VIDEO).exists() for d in takes),
                         scene_regenerate.KEEP_TAKES - 1)

    def test_too_little_free_space_stops_before_anything_is_spent(self):
        gen = FakeGenerator()
        code = self.cli(env(), client=gen, disk_free=lambda p: 1024)
        self.assertEqual(code, scene_regenerate.EXIT_UNAVAILABLE)
        self.assertEqual(self.result()["error_code"], "disk_full")
        self.assertEqual(gen.submits, [])
        self.assertEqual(self.renderer.calls, [])


class ExplicitStock(RunWithGeneratedScene):
    def test_stock_only_when_chosen_and_recorded_as_stock(self):
        gen = FakeGenerator()
        code = self.cli(env(SCENE_REGEN_SOURCE="stock", SCENE_REGEN_PROVIDER="", SCENE_REGEN_MODEL="",
                            SCENE_REGEN_EXPLICIT_STOCK="true"), get_client=lambda name: gen)
        self.assertEqual(code, scene_regenerate.EXIT_OK)
        self.assertEqual(gen.submits, [])
        self.assertGreater(self.fetcher.searches_made, 0)
        new = self.current()
        for aid in new.scene("s001").asset_ids:
            self.assertEqual(new.asset(aid).source, "stock")
        self.assertIs(self.result()["explicit_stock"], True)

    def test_a_stock_scene_is_searched_again_with_the_prompt_leading(self):
        code = self.cli(env(SCENE_REGEN_SOURCE="stock", SCENE_REGEN_PROVIDER="", SCENE_REGEN_MODEL="",
                            SCENE_REGEN_PROMPT="old map close-up"), scene="s000")
        self.assertEqual(code, scene_regenerate.EXIT_OK)
        self.assertIs(self.result()["explicit_stock"], False)


class TheProviderLedger(RunWithGeneratedScene):
    def plan(self, ids=("s001",), **kw):
        return scene_repair.preflight(self.CHANNEL, ids, root=self.root, check_tools=False, **kw)

    def test_a_requeued_attempt_polls_the_task_it_paid_for(self):
        req = scene_regenerate.RegenRequest.from_env("s001", env())
        out_dir = scene_regenerate.regen_dir(self.run_dir, RID)
        pending = FakeGenerator(outcome=provider_tasks.OUTCOME_PENDING)
        with self.assertRaises(scene_regenerate.RegenFailed):
            scene_regenerate.generate_clips(self.plan(), req, pending, out_dir=out_dir)
        self.assertEqual(len(pending.submits), 1)
        again = FakeGenerator()
        clips = scene_regenerate.generate_clips(self.plan(), req, again, out_dir=out_dir)
        self.assertEqual(again.submits, [], "the clip was paid for twice")
        self.assertEqual(again.resumes, ["task-1"])
        self.assertEqual(len(clips), 1)

    def test_the_original_clip_of_the_same_prompt_is_never_reused(self):
        req = scene_regenerate.RegenRequest.from_env("s001", env())
        plan = self.plan()
        ledger = provider_tasks.TaskLedger.open(self.slug, root=self.root)
        from modules.minimax_broll import GenerationSpec, clamp_duration

        spec = GenerationSpec(prompt="harbour at dawn", duration_seconds=clamp_duration(4.0, MODEL),
                              section_index=1)
        task = ledger.record_submitted(provider=PROVIDER, model=MODEL, task_id="original-task", section_index=1,
                                       phash=provider_tasks.prompt_hash(PROVIDER, MODEL, spec))
        ledger.record_outcome(task, provider_tasks.TaskOutcome(provider_tasks.OUTCOME_SUCCEEDED, self.gen_path))
        gen = FakeGenerator()
        clips = scene_regenerate.generate_clips(plan, req, gen, out_dir=scene_regenerate.regen_dir(self.run_dir, RID))
        self.assertEqual(len(gen.submits), 1)
        self.assertNotEqual(clips[0].path, self.gen_path)


class RepairRefusesGeneratedScenes(RunWithGeneratedScene):
    def test_the_old_repair_never_gives_a_generated_scene_stock(self):
        before = (self.run_dir / "project.json").read_bytes()
        code = scene_repair.cli(channel=self.CHANNEL, raw_scenes="1", root=self.root, check_tools=False,
                                fetcher=self.fetcher, render_fn=self.render_fn, qc_fn=self.qc_fn, sync=self.sync)
        self.assertEqual(code, scene_repair.EXIT_UNAVAILABLE)
        self.assertEqual(self.fetcher.searches_made, 0)
        self.assertEqual((self.run_dir / "project.json").read_bytes(), before)

    def test_repair_itself_refuses_too(self):
        plan = scene_repair.preflight(self.CHANNEL, ("s001",), root=self.root, check_tools=False)
        with self.assertRaises(scene_repair.RepairUnavailable):
            scene_repair.repair(plan, fetcher=self.fetcher, render_fn=self.render_fn, qc_fn=self.qc_fn)
        self.assertEqual(self.fetcher.searches_made, 0)

    def test_a_stock_scene_still_repairs(self):
        code = scene_repair.cli(channel=self.CHANNEL, raw_scenes="2", root=self.root, check_tools=False,
                                fetcher=self.fetcher, render_fn=self.render_fn, qc_fn=self.qc_fn, sync=self.sync)
        self.assertEqual(code, scene_repair.EXIT_OK)


class RunRequest(unittest.TestCase):
    TERMS = {"id": RID, "scene_id": "s001", "slug": "the-lost-city", "source_kind": "generated",
             "provider": PROVIDER, "model": MODEL, "prompt": "--privacy public", "explicit_stock": False,
             "previous_asset_ids": ["a_old"], "generated_clips": 1, "stock_assets": 0}
    PARAMS = {"topic": "the-lost-city", "repair_scenes": "s001"}

    def test_always_private_one_scene_never_resume(self):
        self.assertEqual(run_request.build_regenerate_args("news", self.PARAMS),
                         ["--channel", "news", "--privacy", "private", "--topic", "the-lost-city",
                          "--regenerate-scene", "s001"])
        for bad in ({**self.PARAMS, "resume": True}, {**self.PARAMS, "repair_scenes": "s001,s002"},
                    {**self.PARAMS, "topic": "Not A Slug"}):
            with self.subTest(bad=bad), self.assertRaises(run_request.InvalidRunRequest):
                run_request.build_regenerate_args("news", bad)

    def test_the_prompt_rides_the_env_never_argv(self):
        e = run_request.build_regenerate_env(self.TERMS, self.PARAMS,
                                             {"SCENE_REGEN_PROVIDER": "veo", "PATH": "/bin"})
        self.assertEqual(e["SCENE_REGEN_PROMPT"], "--privacy public")
        self.assertEqual((e["SCENE_REGEN_PROVIDER"], e["SCENE_REGEN_MODEL"]), (PROVIDER, MODEL))
        self.assertEqual(e["YOUTUBE_PRIVACY"], "private")
        self.assertNotIn("CHRONOS_VIDEO_PROVIDER", e)

    def test_what_was_priced_is_handed_to_the_run(self):
        e = run_request.build_regenerate_env({**self.TERMS, "previous_asset_ids": ["a_1", "a_2"],
                                              "generated_clips": 1, "stock_assets": 1}, self.PARAMS, {})
        self.assertEqual((e["SCENE_REGEN_PREVIOUS_ASSETS"], e["SCENE_REGEN_GENERATED_CLIPS"],
                          e["SCENE_REGEN_STOCK_ASSETS"]), ("a_1,a_2", "1", "1"))
        for bad in ({"previous_asset_ids": []}, {"previous_asset_ids": ["a,b"]}, {"previous_asset_ids": None},
                    {"generated_clips": None}, {"stock_assets": "1"}, {"generated_clips": True}):
            with self.subTest(bad=bad), self.assertRaises(run_request.InvalidRunRequest):
                run_request.build_regenerate_env({**self.TERMS, **bad}, self.PARAMS, {})

    def test_terms_of_another_job_are_refused(self):
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.build_regenerate_env({**self.TERMS, "scene_id": "s002"}, self.PARAMS, {})
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.build_regenerate_env({**self.TERMS, "id": "x"}, self.PARAMS, {})


# ── the worker ──────────────────────────────────────────────────────────────

FAKE_MAIN = textwrap.dedent("""
    # Behaves like main.py --regenerate-scene as far as the worker can see:
    # keeps the previous take, writes the result naming the new files, swaps.
    import hashlib, json, os, shutil, sys
    from pathlib import Path
    argv = sys.argv[1:]
    E = os.environ
    Path("argv.out").write_text(json.dumps({"argv": argv, "id": E.get("SCENE_REGEN_ID"),
                                            "source": E.get("SCENE_REGEN_SOURCE"),
                                            "provider": E.get("SCENE_REGEN_PROVIDER"),
                                            "previous": E.get("SCENE_REGEN_PREVIOUS_ASSETS"),
                                            "generated": E.get("SCENE_REGEN_GENERATED_CLIPS")}))
    rc = int(E.get("FAKE_RC", "0"))
    mode = E.get("FAKE_MODE", "")
    slug = argv[argv.index("--topic") + 1]
    run = Path("output") / slug
    d = run / "regenerations" / E["SCENE_REGEN_ID"]
    d.mkdir(parents=True, exist_ok=True)
    sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    if rc:
        (d / "result.json").write_text(json.dumps(
            {"ok": False, "error_code": "provider_unavailable", "error": "no key; nothing was charged"}))
        sys.exit(rc)
    shutil.copy2(run / "project.json", d / "previous_project.json")
    shutil.copy2(run / "final_video.mp4", d / "previous_final_video.mp4")
    if mode != "no_previous_hashes":
        (d / "previous_take.json").write_text(json.dumps({"version": 1, "sha256": {
            "project": sha(run / "project.json"), "video": sha(run / "final_video.mp4")}}))
    tv, ti = run / ".new.mp4", run / ".new.json"
    tv.write_bytes(b"NEW CUT"); ti.write_text('{"new": true}')
    body = {"ok": True, "new_asset_ids": ["a_new"], "previous_asset_ids": ["a_old"], "source_kind": "generated",
            "previous_take": {"project": "previous_project.json", "video": "previous_final_video.mp4"},
            "qc": {"blocks": []}, "new_video_sha256": sha(tv), "new_project_sha256": sha(ti)}
    if mode != "no_result":
        (d / "result.json").write_text(json.dumps(body))
    if mode == "no_swap":
        sys.exit(0)
    os.replace(ti, run / "project.json")
    if mode == "die_mid_swap":
        os._exit(9)
    os.replace(tv, run / "final_video.mp4")
    if mode == "die_after_swap":
        os._exit(9)
    sys.exit(0)
""")


class RegenCredits:
    """The service-key client for a customer's regeneration."""

    def __init__(self, terms=True):
        self.calls = []
        self.terms = terms

    def channel_org(self, channel_id):
        return "11111111-1111-4111-8111-111111111111"

    def expire(self):
        return 0

    def scene_regen_start(self, regen_id, job_id):
        self.calls.append(("start", regen_id, job_id))
        if not self.terms:
            return None
        return dict(RunRequest.TERMS)

    def scene_regen_finish(self, regen_id, job_id, *, ok, error_code=None, error=None, result=None):
        self.calls.append(("finish", regen_id, job_id, ok, error_code, error, result))
        return {"status": "succeeded" if ok else "failed"}

    def start(self, *a):  # the per-minute video settle must never be used
        raise AssertionError("a regeneration was settled as a video run")

    capture = release = prices = start


class Worker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {"PATH": os.environ.get("PATH", "")}
        self.run_dir = self.repo / "output" / "the-lost-city"
        self.run_dir.mkdir(parents=True)
        (self.run_dir / "project.json").write_text('{"old": true}')
        (self.run_dir / "final_video.mp4").write_bytes(b"OLD CUT")
        self.sink = open(os.devnull, "w")
        self.addCleanup(self.sink.close)

    def run_job(self, credits, **env):
        from tests.test_queue_worker import FakeQueue, job

        self.env.update(env)
        q = FakeQueue([job(kind="repair", params=dict(RunRequest.PARAMS), scene_regeneration_id=RID,
                           credit_ref="rj-sr-" + RID.replace("-", ""))])
        w = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False},
                      heartbeat_seconds=0.05, poll_seconds=0.01, grace_seconds=60, kill_after_seconds=2,
                      out=self.sink, credits=credits)
        w.run_forever(once=True)
        return q

    def argv(self):
        return json.loads((self.repo / "argv.out").read_text())

    def test_success_is_settled_by_the_database_with_the_result(self):
        c = RegenCredits()
        q = self.run_job(c)
        self.assertEqual(q.ends(), [("finish", 7, "succeeded", None)])
        a = self.argv()
        self.assertEqual(a["argv"][-2:], ["--regenerate-scene", "s001"])
        self.assertEqual((a["id"], a["source"], a["provider"]), (RID, "generated", PROVIDER))
        (_, rid, jid, ok, code, _, result), = [x for x in c.calls if x[0] == "finish"]
        self.assertEqual((rid, jid, ok, code), (RID, 7, True, None))
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"NEW CUT")
        self.assertEqual(result["new_asset_ids"], ["a_new"])
        self.assertTrue(result["previous_take_kept"])

    def test_a_failure_releases_with_the_runs_own_reason(self):
        c = RegenCredits()
        q = self.run_job(c, FAKE_RC="3")
        self.assertEqual(q.ends()[0][2], "failed")
        (_, _, _, ok, code, error, _), = [x for x in c.calls if x[0] == "finish"]
        self.assertEqual((ok, code), (False, "provider_unavailable"))
        self.assertIn("nothing was charged", error)

    def unchanged(self):
        self.assertEqual((self.run_dir / "project.json").read_text(), '{"old": true}')
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"OLD CUT")

    def finish(self, c):
        (_, _, _, ok, code, _, _), = [x for x in c.calls if x[0] == "finish"]
        return ok, code

    def test_a_clean_exit_without_a_result_is_not_charged(self):
        c = RegenCredits()
        self.run_job(c, FAKE_MODE="no_result")
        self.assertEqual(self.finish(c), (False, "not_confirmed"))
        self.unchanged()

    # BR-L-034: every point the run can stop at after the result is written.
    def test_a_result_whose_cut_is_not_on_disk_is_not_charged(self):
        c = RegenCredits()
        self.run_job(c, FAKE_MODE="no_swap")
        self.assertEqual(self.finish(c), (False, "not_confirmed"))
        self.unchanged()

    def test_a_run_that_died_half_way_through_the_swap_is_put_back_and_released(self):
        c = RegenCredits()
        self.run_job(c, FAKE_MODE="die_mid_swap")
        self.assertEqual(self.finish(c)[0], False)
        self.unchanged()

    def test_a_run_that_died_after_the_swap_is_put_back_and_released(self):
        c = RegenCredits()
        self.run_job(c, FAKE_MODE="die_after_swap")
        self.assertEqual(self.finish(c)[0], False)
        self.unchanged()

    def test_the_priced_scene_is_handed_to_the_run(self):
        self.run_job(RegenCredits())
        a = self.argv()
        self.assertEqual((a["previous"], a["generated"]), ("a_old", "1"))

    def test_a_hold_that_is_not_open_runs_nothing(self):
        c = RegenCredits(terms=False)
        q = self.run_job(c)
        self.assertEqual(q.ends()[0][2], "failed")
        self.assertIn("nothing was run", q.ends()[0][3])
        self.assertFalse((self.repo / "argv.out").exists())
        self.assertEqual([x[0] for x in c.calls], ["start"])


if __name__ == "__main__":
    unittest.main()
