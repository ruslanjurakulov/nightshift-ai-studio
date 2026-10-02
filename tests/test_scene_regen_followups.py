"""Follow-ups of the independent review of scene regeneration (BR-L-041,
BR-L-042 worker half, BR-L-046 clip salt) and the migration that carries the
database half (0085).

What would break without these:

* a worker killed while it copies the previous take leaves a truncated file; the
  next attempt trusts it, and a later failure "restores" the cut from it;
* a kept copy that is not what was kept is put over the customer's cut;
* a worker that dies between the end of its run and the settle, or a job that
  is lost or failed on its last attempt, has its hold released by the sweep
  while the new cut is in place (a free regeneration and a false status);
* one unsettled row, an unreachable database or a missing function stops the
  sweep for ever, or releases a hold unchecked;
* 0085 drops a check 0076 had, or is not re-runnable.

The database half is attacked in tests/security/test_sec_scene_regen_followups.py.
"""

import hashlib
import logging
import os
import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from modules import credits as credit_rules
from modules import scene_regenerate, video_ir
from tests.test_scene_regenerate import RID, FakeGenerator, RunWithGeneratedScene, env
from tests.test_scene_regenerate_migration import bodies, code, literals

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import queue_worker as qw  # noqa: E402

sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731


class KeptPreviousTake(RunWithGeneratedScene):
    """BR-L-041: the previous take is copied atomically, verified, and only a
    copy that matches its recorded hash is ever put back."""

    def setUp(self):
        super().setUp()
        self.ir_before = (self.run_dir / "project.json").read_bytes()
        self.cut_before = (self.run_dir / "final_video.mp4").read_bytes()
        self.kept = scene_regenerate.regen_dir(self.run_dir, RID)

    def run_ok(self):
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)

    def settle(self, exited_ok=False):
        return scene_regenerate.settle_outcome(self.root, self.slug, RID, exited_ok=exited_ok)

    def test_the_kept_take_is_a_verified_copy_and_its_hashes_are_recorded(self):
        self.run_ok()
        self.assertEqual((self.kept / "previous_final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual((self.kept / "previous_project.json").read_bytes(), self.ir_before)
        want = {"project": sha(self.ir_before), "video": sha(self.cut_before)}
        import json
        self.assertEqual(json.loads((self.kept / "previous_take.json").read_text())["sha256"], want)
        self.assertEqual(self.result()["previous_sha256"], want)
        leftovers = [p.name for p in self.kept.iterdir() if p.suffix in (".partial", ".tmp", ".restore")]
        self.assertEqual(leftovers, [])

    def test_a_truncated_copy_left_by_a_killed_attempt_is_replaced_and_never_restored(self):
        # The Lens repro: a 7-byte previous take from a copy that was killed.
        self.kept.mkdir(parents=True)
        (self.kept / "previous_final_video.mp4").write_bytes(b"7 bytes")
        (self.kept / "previous_project.json").write_bytes(self.ir_before[:5])
        self.run_ok()
        self.assertEqual((self.kept / "previous_final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual((self.kept / "previous_project.json").read_bytes(), self.ir_before)
        # Now a later failure: the cut is not the one the result names.
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")
        verdict = self.settle(exited_ok=True)
        self.assertEqual((verdict["ok"], verdict["code"]), (False, "not_confirmed"))
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)

    def test_a_stale_partial_file_is_ignored(self):
        self.kept.mkdir(parents=True)
        (self.kept / "previous_final_video.mp4.partial").write_bytes(b"half")
        self.run_ok()
        self.assertEqual((self.kept / "previous_final_video.mp4").read_bytes(), self.cut_before)
        self.assertFalse((self.kept / "previous_final_video.mp4.partial").exists())

    def test_a_verified_copy_already_there_is_reused_not_copied_again(self):
        self.kept.mkdir(parents=True)
        (self.kept / "previous_final_video.mp4").write_bytes(self.cut_before)
        real = scene_regenerate.shutil.copyfile
        copied = []

        def spy(src, dst, **kw):
            copied.append(Path(dst).name)
            return real(src, dst, **kw)

        with mock.patch.object(scene_regenerate.shutil, "copyfile", side_effect=spy):
            self.run_ok()
        self.assertNotIn("previous_final_video.mp4.partial", copied)
        self.assertIn("previous_project.json.partial", copied)

    def test_a_copy_that_does_not_verify_stops_before_anything_changes(self):
        renders = []
        real_render = self.render_fn

        def render(*a, **k):
            renders.append(1)
            return real_render(*a, **k)

        def bad_copy(src, dst, **kw):
            Path(dst).write_bytes(Path(src).read_bytes()[:3])

        with mock.patch.object(scene_regenerate.shutil, "copyfile", side_effect=bad_copy):
            code_ = self.cli(env(), client=FakeGenerator(), render_fn=render)
        self.assertEqual(code_, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "previous_take_not_kept")
        self.assertEqual(renders, [], "a render started without a verified previous take")
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.assertFalse((self.kept / "previous_final_video.mp4").exists())
        self.assertFalse((self.kept / "previous_project.json").exists())
        self.assertFalse((self.kept / "previous_take.json").exists())
        self.assertEqual([p.name for p in self.kept.glob("*.partial")], [])

    def test_a_copy_that_cannot_be_written_stops_before_anything_changes(self):
        with mock.patch.object(scene_regenerate.shutil, "copyfile", side_effect=OSError("disk full")):
            code_ = self.cli(env(), client=FakeGenerator())
        self.assertEqual(code_, scene_regenerate.EXIT_FAILED)
        self.assertEqual(self.result()["error_code"], "previous_take_not_kept")
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)

    def test_the_copy_is_flushed_to_disk_before_it_is_renamed_into_place(self):
        events = []
        real_fsync, real_replace = os.fsync, os.replace

        def fsync(fd):
            events.append("fsync")
            return real_fsync(fd)

        def replace(src, dst):
            if str(src).endswith(".partial"):
                events.append("rename " + Path(dst).name)
            return real_replace(src, dst)

        with mock.patch("modules.scene_regenerate.os.fsync", side_effect=fsync), \
                mock.patch("modules.scene_regenerate.os.replace", side_effect=replace):
            self.run_ok()
        for name in ("previous_final_video.mp4", "previous_project.json"):
            at = events.index("rename " + name)
            self.assertIn("fsync", events[:at], f"{name} was renamed before it was flushed")

    def test_restore_refuses_a_kept_file_that_does_not_match_its_recorded_hash(self):
        self.run_ok()
        (self.kept / "previous_final_video.mp4").write_bytes(b"7 bytes")      # damaged afterwards
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")     # and the cut is not confirmed
        with self.assertLogs(scene_regenerate.logger, level=logging.ERROR) as logs:
            verdict = self.settle(exited_ok=True)
        self.assertFalse(verdict["ok"])
        self.assertNotEqual((self.run_dir / "final_video.mp4").read_bytes(), b"7 bytes")
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"something else")
        self.assertTrue(any("does not match its recorded hash" in m for m in logs.output), logs.output)
        # The IR copy was intact, so that one still goes back.
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)

    def test_restore_with_no_recorded_hashes_puts_nothing_back(self):
        self.run_ok()
        (self.kept / "previous_take.json").unlink()
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")
        self.assertEqual(scene_regenerate.restore_previous_take(self.run_dir, RID), [])
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"something else")

    def test_restore_ignores_a_recorded_file_that_is_not_a_hash(self):
        self.run_ok()
        (self.kept / "previous_take.json").write_text('{"sha256": {"video": "../../etc/passwd", "project": 7}}')
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")
        self.assertEqual(scene_regenerate.restore_previous_take(self.run_dir, RID), [])
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"something else")

    def test_only_a_sha256_is_read_back_from_the_record(self):
        self.run_ok()
        good = scene_regenerate._recorded_previous(self.kept)
        self.assertEqual(sorted(good), ["project", "video"])
        (self.kept / "previous_take.json").write_text(
            '{"sha256": {"video": "../../etc/passwd", "project": "%s", "other": "%s"}}' % (good["project"], good["video"]))
        self.assertEqual(scene_regenerate._recorded_previous(self.kept), {"project": good["project"]})
        (self.kept / "previous_take.json").write_text("not json")
        self.assertEqual(scene_regenerate._recorded_previous(self.kept), {})

    def test_a_restore_that_does_not_verify_leaves_the_cut_alone(self):
        self.run_ok()
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")

        def bad_copy(src, dst, **kw):
            Path(dst).write_bytes(b"x")

        with mock.patch.object(scene_regenerate.shutil, "copyfile", side_effect=bad_copy):
            restored = scene_regenerate.restore_previous_take(self.run_dir, RID)
        self.assertNotIn("final_video.mp4", restored)
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), b"something else")
        self.assertEqual([p.name for p in self.run_dir.glob("*.restore")], [])

    def test_a_good_kept_copy_still_goes_back(self):
        self.run_ok()
        restored = scene_regenerate.restore_previous_take(self.run_dir, RID)
        self.assertEqual(sorted(restored), ["final_video.mp4", "project.json"])
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)


class ClipHashIsSalted(unittest.TestCase):
    """BR-L-046 (Y11): a later press of the same prompt must not be handed an
    earlier press's clip, and a re-queued attempt must find its own task."""

    def test_the_hash_depends_on_the_regeneration_and_on_the_clip(self):
        base = "a" * 64
        other = "1b8f3c2e-5d4a-4e1f-9a7b-2c6d8e0f1a3b"
        self.assertEqual(scene_regenerate._clip_hash(base, RID, 0), scene_regenerate._clip_hash(base, RID, 0))
        self.assertNotEqual(scene_regenerate._clip_hash(base, RID, 0), scene_regenerate._clip_hash(base, other, 0))
        self.assertNotEqual(scene_regenerate._clip_hash(base, RID, 0), scene_regenerate._clip_hash(base, RID, 1))
        self.assertNotEqual(scene_regenerate._clip_hash(base, RID, 0), base[:16])


# ── BR-L-042: the worker settles what the sweep is about to release ─────────

class SweepCredits:
    """The service-key client as the sweep uses it."""

    def __init__(self, rows, *, finish_fails=0, list_error=None):
        self.rows = rows
        self.calls = []
        self.finish_fails = finish_fails
        self.list_error = list_error

    def expire(self):
        self.calls.append(("expire_holds",))
        return 0

    def scene_regen_unsettled(self):
        self.calls.append(("unsettled",))
        if self.list_error:
            raise credit_rules.CreditsUnavailable(self.list_error)
        return list(self.rows)

    def scene_regen_finish(self, regen_id, job_id, *, ok, error_code=None, error=None, result=None):
        self.calls.append(("finish", regen_id, job_id, ok, error_code, result))
        if self.finish_fails:
            self.finish_fails -= 1
            raise credit_rules.CreditsUnavailable("finish: HTTP 502")
        return {"status": "succeeded" if ok else "failed"}

    def scene_regen_expire(self):
        self.calls.append(("expire",))
        return len(self.rows)

    def names(self):
        return [c[0] for c in self.calls]


class SweepSettles(RunWithGeneratedScene):
    def setUp(self):
        super().setUp()
        self.ir_before = (self.run_dir / "project.json").read_bytes()
        self.cut_before = (self.run_dir / "final_video.mp4").read_bytes()

    def row(self, *, hours_old=1.0, job=7):
        created = datetime.now(timezone.utc) - timedelta(hours=hours_old)
        return {"id": RID, "render_job_id": job, "slug": self.slug, "status": "running",
                "created_at": created.isoformat()}

    def worker(self, credits):
        from tests.test_queue_worker import FakeQueue

        return qw.Worker(FakeQueue([]), worker_id="w1", env={}, repo_dir=ROOT, prelude=[],
                         resolve_channel=lambda cid: {"channel_id": cid, "is_default": False},
                         poll_seconds=0.01, out=open(os.devnull, "w"), credits=credits,
                         output_dir=self.root)

    def sweep(self, credits, w=None):
        w = w or self.worker(credits)
        w._last_sweep = None
        w._sweep_credit_holds()
        return w

    def swap_dies(self):
        real = os.replace
        cut = self.run_dir / "final_video.mp4"

        def fake(src, dst):
            if Path(dst) == cut and Path(src).name.startswith(".regen-"):
                raise SystemExit(9)
            return real(src, dst)

        return mock.patch("modules.scene_regenerate.os.replace", side_effect=fake)

    def assertOrder(self, credits, *names):
        seen = [n for n in credits.names() if n in names]
        self.assertEqual(seen, list(names), credits.calls)

    def test_a_cut_in_place_when_the_worker_died_is_confirmed_not_released(self):
        # The run finished and swapped; the worker died before the settle.
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        new_cut = (self.run_dir / "final_video.mp4").read_bytes()
        self.assertNotEqual(new_cut, self.cut_before)
        credits = SweepCredits([self.row()])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual(finish[1:5], (RID, 7, True, None))
        self.assertTrue(finish[5]["new_asset_ids"])
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), new_cut)
        self.assertOrder(credits, "unsettled", "finish", "expire")

    def test_a_swap_that_died_half_way_is_put_back_before_the_hold_is_released(self):
        with self.swap_dies(), self.assertRaises(SystemExit):
            self.cli(env(), client=FakeGenerator())
        self.assertNotEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)
        credits = SweepCredits([self.row()])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual(finish[3:5], (False, "not_confirmed"))
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual(sorted(p.name for p in self.run_dir.glob(".regen-*")), [])
        self.assertOrder(credits, "unsettled", "finish", "expire")

    def test_a_cut_changed_after_its_result_is_put_back_not_confirmed(self):
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        (self.run_dir / "final_video.mp4").write_bytes(b"something else")
        credits = SweepCredits([self.row()])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual(finish[3:5], (False, "not_confirmed"))
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)

    def test_a_job_that_never_got_going_is_released_as_ended_and_nothing_is_touched(self):
        credits = SweepCredits([self.row()])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual(finish[3:5], (False, "job_ended"))
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.assertEqual((self.run_dir / "project.json").read_bytes(), self.ir_before)

    def test_a_run_that_failed_keeps_its_own_code(self):
        self.cli(env(SCENE_REGEN_PROVIDER="veo"), client=FakeGenerator())   # refused: not the priced generator
        credits = SweepCredits([self.row()])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertFalse(finish[3])
        self.assertNotEqual(finish[4], "job_ended")

    def test_a_run_directory_that_is_not_on_this_worker_is_released_unchanged(self):
        row = dict(self.row(), slug="a-run-this-worker-never-had")
        credits = SweepCredits([row])
        self.sweep(credits)
        (finish,) = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual(finish[3:5], (False, "job_ended"))
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)

    def test_a_slug_that_is_not_a_slug_never_leaves_the_output_folder(self):
        outside = self.root.parent / "outside"
        outside.mkdir()
        (outside / "final_video.mp4").write_bytes(b"not ours")
        credits = SweepCredits([dict(self.row(), slug="../outside")])
        self.sweep(credits)
        self.assertEqual((outside / "final_video.mp4").read_bytes(), b"not ours")
        self.assertEqual([p.name for p in outside.iterdir()], ["final_video.mp4"])

    def test_a_settle_the_database_did_not_take_blocks_the_release_until_it_does(self):
        with self.swap_dies(), self.assertRaises(SystemExit):
            self.cli(env(), client=FakeGenerator())
        credits = SweepCredits([self.row()], finish_fails=1)
        w = self.sweep(credits)
        self.assertNotIn("expire", credits.names(), "a hold was released that the worker could not settle")
        # The previous take is back on disk already; the next round finishes the row.
        self.assertEqual((self.run_dir / "final_video.mp4").read_bytes(), self.cut_before)
        self.sweep(credits, w)
        self.assertEqual(credits.names().count("expire"), 1)
        self.assertEqual(len([c for c in credits.calls if c[0] == "finish"]), 2)

    def test_an_unreachable_list_releases_nothing(self):
        credits = SweepCredits([self.row()], list_error="scene_regenerations_unsettled: ConnectionError")
        self.sweep(credits)
        self.assertNotIn("expire", credits.names())

    def test_a_database_without_0085_gets_the_old_sweep_and_a_warning(self):
        credits = SweepCredits([self.row()], list_error="scene_regenerations_unsettled: HTTP 404 (is migration 0020 applied?)")
        with self.assertLogs(qw.logger, level=logging.WARNING) as logs:
            self.sweep(credits)
        self.assertIn("expire", credits.names())
        self.assertTrue(any("0085" in m for m in logs.output), logs.output)

    def test_a_client_that_cannot_list_gets_the_old_sweep(self):
        credits = SweepCredits([self.row()])
        credits.scene_regen_unsettled = None
        self.sweep(credits)
        self.assertIn("expire", credits.names())

    def test_a_row_past_every_hold_never_blocks_the_sweep(self):
        credits = SweepCredits([self.row(hours_old=30)], finish_fails=5)
        self.sweep(credits)
        self.assertIn("expire", credits.names())

    def test_one_bad_row_does_not_stop_the_others(self):
        self.assertEqual(self.cli(env(), client=FakeGenerator()), scene_regenerate.EXIT_OK)
        broken = dict(self.row(), id="not-a-uuid", render_job_id=None)
        credits = SweepCredits([broken, self.row()])
        self.sweep(credits)
        finished = [c for c in credits.calls if c[0] == "finish"]
        self.assertEqual([c[1] for c in finished], [RID])
        self.assertTrue(finished[0][3])
        # The broken row could not be settled, so the release waits.
        self.assertNotIn("expire", credits.names())

    def test_a_row_that_blows_up_is_survived_and_blocks_only_the_release(self):
        real = scene_regenerate.reconcile_outcome
        calls = []

        def flaky(output_dir, slug, regen_id):
            calls.append(regen_id)
            if len(calls) == 1:
                raise RuntimeError("the disk went away")
            return real(output_dir, slug, regen_id)

        other = dict(self.row(), id="1b8f3c2e-5d4a-4e1f-9a7b-2c6d8e0f1a3b", render_job_id=8)
        credits = SweepCredits([self.row(), other])
        with mock.patch.object(scene_regenerate, "reconcile_outcome", side_effect=flaky):
            self.sweep(credits)
        self.assertEqual(len(calls), 2, "the rows after a failing one were not tried")
        self.assertEqual([c[1] for c in credits.calls if c[0] == "finish"], [other["id"]])
        self.assertNotIn("expire", credits.names())

    def test_nothing_to_settle_runs_the_sweep_as_before(self):
        credits = SweepCredits([])
        self.sweep(credits)
        self.assertOrder(credits, "unsettled", "expire")

    def test_the_sweep_runs_when_the_worker_starts(self):
        credits = SweepCredits([self.row()])
        w = self.worker(credits)
        self.assertIsNone(w._last_sweep)
        w.run_forever(once=True)
        self.assertOrder(credits, "unsettled", "finish", "expire")

    def test_the_sweep_is_not_repeated_within_ten_minutes(self):
        credits = SweepCredits([])
        w = self.worker(credits)
        w._sweep_credit_holds()
        w._sweep_credit_holds()
        self.assertEqual(credits.names().count("unsettled"), 1)


# ── migration 0085 ──────────────────────────────────────────────────────────

MIGRATIONS = ROOT / "supabase" / "migrations"
FILE = "0085_scene_regen_followups.sql"
SQL = (MIGRATIONS / FILE).read_text()
OLD = (MIGRATIONS / "0076_scene_regenerate.sql").read_text()
REPLACED = ["request_scene_regenerate", "finish_scene_regeneration"]


class Migration0085(unittest.TestCase):
    def test_defines_exactly_these_functions(self):
        self.assertEqual(sorted(bodies(SQL)), sorted(REPLACED + ["scene_regenerations_unsettled"]))

    def test_the_latest_body_of_each_replaced_function_is_0076s(self):
        # No migration between 0076 and 0085 redefines them.
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if not ("0076" < f.name[:4] < "0085"):
                continue
            for name in REPLACED:
                self.assertNotIn(name, bodies(f.read_text()), f"{f.name} redefines {name}")

    def test_every_line_of_each_old_body_is_kept_in_order_but_the_ones_named(self):
        # finish_scene_regeneration: the one UPDATE line that stored the worker's text.
        changed = {"finish_scene_regeneration": {
            "         result = v_result, finished_at = now(), error_code = v_code, error = left(p_error, 500)"}}
        for name in REPLACED:
            old, new = bodies(OLD)[name], bodies(SQL)[name]
            gone = [l for l in old.splitlines() if l not in new.splitlines()]
            self.assertEqual(set(gone), changed.get(name, set()), f"{name}: lines were removed or changed")
            it = iter(new.splitlines())
            for line in old.splitlines():
                if line in changed.get(name, set()):
                    continue
                self.assertTrue(any(line == n for n in it), f"{name}: line moved: {line!r}")

    def test_every_literal_of_each_old_body_is_still_there(self):
        for name in REPLACED:
            lost = literals(bodies(OLD)[name]) - literals(bodies(SQL)[name])
            self.assertEqual(lost, set(), f"{name} dropped {lost}")

    def test_the_press_gains_only_the_ceiling_check(self):
        old, new = code(bodies(OLD)["request_scene_regenerate"]), code(bodies(SQL)["request_scene_regenerate"])
        import difflib
        ops = difflib.SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False).get_opcodes()
        self.assertEqual([op for op, *_ in ops if op != "equal"], ["insert"], "something else changed")
        (_, _, _, j1, j2), = [o for o in ops if o[0] == "insert"]
        added = new.splitlines()[j1:j2]
        self.assertEqual([l.strip() for l in added if l.strip()],
                         ["if p_max_credits = 'NaN'::numeric or p_max_credits = 'Infinity'::numeric",
                          "or p_max_credits = '-Infinity'::numeric then",
                          "raise exception 'price_required' using errcode = '22023', detail = format('credits=%s', v_price);",
                          "end if;"])

    def test_the_worker_text_never_reaches_the_member_readable_column(self):
        finish = code(bodies(SQL)["finish_scene_regeneration"])
        self.assertNotIn("error = left(p_error", finish)
        self.assertIn("insert into public.scene_regeneration_details", finish)
        # The signature, the blank check and the details insert: nowhere else.
        self.assertEqual(len(re.findall(r"\bp_error\b", finish)), 3)

    def test_it_is_additive_and_can_be_run_twice(self):
        stripped = code(SQL).lower()
        for bad in ("drop table", "drop column", "drop function", "drop policy", "truncate", "delete from"):
            self.assertNotIn(bad, stripped)
        self.assertIn("create table if not exists public.scene_regeneration_details", stripped)
        self.assertEqual(len(re.findall(r"^create or replace function", stripped, re.M)), 3)
        self.assertNotIn("create function", stripped)

    def test_privileges_are_explicit_and_search_path_pinned(self):
        for name in ("request_scene_regenerate", "finish_scene_regeneration", "scene_regenerations_unsettled"):
            self.assertIn("set search_path = public, pg_temp", bodies(SQL)[name].split("$$")[0], name)
        self.assertIn("revoke all on function public.scene_regenerations_unsettled() from public, anon, authenticated;", SQL)
        self.assertIn("grant execute on function public.scene_regenerations_unsettled() to service_role;", SQL)
        self.assertIn("revoke all on public.scene_regeneration_details from public, anon, authenticated, service_role;", SQL)
        self.assertIn("grant select on public.scene_regeneration_details to service_role;", SQL)
        self.assertIn("alter table public.scene_regeneration_details enable row level security;", SQL)
        self.assertIn("revoke select on public.scene_regenerations from authenticated;", SQL)

    def test_the_member_columns_are_every_column_but_error(self):
        block = re.search(r"create table if not exists public\.scene_regenerations \((.*?)\n\);", OLD, re.S).group(1)
        columns = set(re.findall(r"^  (\w+)\s+[a-z]", block, re.M))
        self.assertIn("error", columns)
        granted = set(re.findall(r"\w+", re.search(r"grant select \((.*?)\)\s+on public\.scene_regenerations to authenticated;",
                                                   SQL, re.S).group(1)))
        self.assertEqual(granted, columns - {"error"})

    def test_the_unsettled_list_is_the_sweeps_own_predicate(self):
        old = code(bodies(OLD)["expire_scene_regenerations"])
        new = code(bodies(SQL)["scene_regenerations_unsettled"])
        squash = lambda t: re.sub(r"\s+", " ", t)  # noqa: E731
        for piece in ("s.status in ('queued', 'running')", "s.created_at < now() - interval '26 hours'",
                      "not exists (select 1 from public.render_jobs j where j.id = s.render_job_id and "
                      "(j.status in ('queued', 'running') or j.finished_at > now() - interval '15 minutes'))"):
            self.assertIn(piece, squash(old))
            self.assertIn(piece, squash(new))
        self.assertIn("credits_trusted_caller()", new)


if __name__ == "__main__":
    unittest.main()
