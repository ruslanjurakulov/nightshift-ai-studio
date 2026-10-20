"""daily_video.yml's scheduling safety net (H5b): one run per channel and slot, a guard inside the run, and the
settings that must NOT have moved (privacy, permissions, pinned actions).

The workflow is parsed, never run: nothing here starts an Actions run, a provider call or a render. The guard's
shell is executed under bash with a stand-in ``python`` that records what it was asked and answers with a chosen
exit code, so the decision table of the real script is tested without Supabase.

What it does NOT prove (no real Actions run): that GitHub accepts ``matrix`` in a job-level ``concurrency``
group, and how a pending matrix job counts against ``max-parallel``. Both are said in the PR as not verified.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"
BASH = shutil.which("bash")


def load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def step(job: str, name: str) -> dict:
    return next(s for s in load()["jobs"][job]["steps"] if s.get("name") == name)


class ConcurrencyGroup(unittest.TestCase):
    def setUp(self):
        self.doc = load()
        self.job = self.doc["jobs"]["make-video"]

    def test_make_video_queues_per_channel_and_slot_and_never_cancels_a_running_run(self):
        c = self.job["concurrency"]
        self.assertIs(c["cancel-in-progress"], False)
        group = c["group"]
        self.assertIn("matrix.channel_id", group)     # one channel's runs queue behind each other ...
        self.assertIn("matrix.slot_date", group)      # ... for one slot, not for ever
        self.assertTrue(group.startswith("nightshift-slot-"))

    def test_there_is_no_workflow_wide_group(self):
        # A workflow-level group would queue the cheap hourly resolver behind a long render and cancel its
        # pending hourly runs, which is the opposite of a catch-up.
        self.assertNotIn("concurrency", self.doc)
        self.assertNotIn("concurrency", self.doc["jobs"]["resolve"])

    def test_max_parallel_stays_one_and_fail_fast_stays_off(self):
        s = self.job["strategy"]
        self.assertEqual(s["max-parallel"], 1)
        self.assertIs(s["fail-fast"], False)

    def test_the_matrix_rows_carry_what_the_group_and_the_guard_read(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        for key in ("matrix.slot_date", "matrix.slot_start", "matrix.catchup"):
            self.assertIn(key, text)

    def test_an_empty_matrix_still_skips_the_job(self):
        self.assertEqual(self.job["if"], "needs.resolve.outputs.count > 0")


class NothingElseMoved(unittest.TestCase):
    def test_permissions_are_read_only_and_not_widened_anywhere(self):
        doc = load()
        self.assertEqual(doc["permissions"], {"contents": "read"})
        for name, job in doc["jobs"].items():
            self.assertNotIn("permissions", job, name)

    def test_the_schedule_still_forces_private(self):
        env = step("make-video", "Run Chronos bot")["env"]
        self.assertEqual(env["YOUTUBE_PRIVACY"], "${{ github.event.inputs.privacy || 'private' }}")
        script = step("make-video", "Run Chronos bot")["run"]
        self.assertIn('--privacy "${YOUTUBE_PRIVACY:-private}"', script)

    def test_the_cron_is_still_hourly(self):
        doc = load()
        self.assertEqual((doc.get(True) or doc.get("on"))["schedule"], [{"cron": "0 * * * *"}])

    def test_the_resolver_gets_the_window_from_a_repo_variable_and_the_pause_is_still_passed(self):
        env = step("resolve", "Pick due channels")["env"]
        self.assertEqual(env["NIGHTSHIFT_CATCHUP_HOURS"], "${{ vars.NIGHTSHIFT_CATCHUP_HOURS }}")
        self.assertEqual(env["NIGHTSHIFT_PIPELINE_PAUSED"], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")

    def test_the_scheduled_resolver_still_filters_by_the_current_hour(self):
        script = step("resolve", "Pick due channels")["run"]
        self.assertIn('python tools/list_channels.py --due-hour "$(date -u +%-H)"', script)


@unittest.skipUnless(BASH, "needs bash")
class TheGuardInTheRunStep(unittest.TestCase):
    """The prefix of the 'Run Chronos bot' script, run for real under bash with a stand-in python."""

    @classmethod
    def setUpClass(cls):
        script = step("make-video", "Run Chronos bot")["run"]
        # Everything up to and including the guard; the rest of the script only builds argv for main.py.
        cls.script = script

    def go(self, *, event="schedule", guard_rc=0, catchup="false"):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            calls, out = d / "calls", d / "out"
            fake = d / "bin"
            fake.mkdir()
            py = fake / "python"
            py.write_text('#!/bin/sh\necho "$@" >> "$CALLS"\ncase "$1" in\n'
                          '  tools/slot_guard.py) exit "$FAKE_GUARD_RC";;\nesac\nexit 0\n')
            py.chmod(py.stat().st_mode | stat.S_IEXEC)
            env = {
                "PATH": f"{fake}:{os.environ['PATH']}", "CALLS": str(calls), "FAKE_GUARD_RC": str(guard_rc),
                "GITHUB_OUTPUT": str(out), "EVENT_NAME": event, "CHANNEL_ID": "default",
                "SLOT_START": "2026-10-20T15:00:00Z", "SLOT_CATCHUP": catchup,
                "INPUT_TOPIC": "", "INPUT_NICHE": "", "YOUTUBE_PRIVACY": "",
            }
            proc = subprocess.run([BASH, "--noprofile", "--norc", "-eo", "pipefail", "-c", self.script],
                                  env=env, capture_output=True, text=True, timeout=60)
            lines = calls.read_text().splitlines() if calls.exists() else []
            return proc, lines, (out.read_text() if out.exists() else "")

    def test_a_slot_that_was_already_worked_stops_before_main_and_is_a_green_step(self):
        proc, calls, out = self.go(guard_rc=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([c for c in calls if c.startswith("main.py")], [])
        self.assertIn("skipped=true", out)

    def test_a_free_slot_runs_main_with_the_channel_and_private(self):
        proc, calls, _ = self.go(guard_rc=0)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        main = [c for c in calls if c.startswith("main.py")]
        self.assertEqual(main, ["main.py --channel default --privacy private"])

    def test_the_guard_is_given_the_channel_and_the_slot_and_the_catch_up_flag(self):
        _, calls, _ = self.go(catchup="true")
        self.assertIn("tools/slot_guard.py --channel default --slot-start 2026-10-20T15:00:00Z --catchup", calls)
        _, calls, _ = self.go(catchup="false")
        self.assertIn("tools/slot_guard.py --channel default --slot-start 2026-10-20T15:00:00Z", calls)

    def test_a_guard_that_crashes_cannot_block_the_exact_hour_run(self):
        _, calls, _ = self.go(guard_rc=1, catchup="false")
        self.assertTrue([c for c in calls if c.startswith("main.py")])

    def test_a_guard_that_crashes_never_starts_a_catch_up(self):
        proc, calls, _ = self.go(guard_rc=1, catchup="true")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual([c for c in calls if c.startswith("main.py")], [])

    def test_a_manual_dispatch_is_not_asked_and_always_runs(self):
        proc, calls, _ = self.go(event="workflow_dispatch", guard_rc=3)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse([c for c in calls if "slot_guard" in c])
        self.assertTrue([c for c in calls if c.startswith("main.py")])

    def test_the_guard_comes_before_anything_is_spent(self):
        script = step("make-video", "Run Chronos bot")["run"]
        self.assertLess(script.index("tools/slot_guard.py"), script.index("python main.py"))


if __name__ == "__main__":
    unittest.main()
