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


GROUP = re.compile(
    r"^\$\{\{ github\.event_name == 'schedule' && format\('(?P<slot>[^']+)', matrix\.channel_id, matrix\.slot_date\) "
    r"\|\| format\('(?P<manual>[^']+)', matrix\.channel_id, github\.run_id\) \}\}$")


def group_for(expr: str, *, event: str, channel: str, slot_date: str, run_id: int) -> str:
    """The group name the workflow's expression gives a job: `cond && a || b` with GitHub's semantics (a non-empty
    string is truthy), evaluated for the pinned shape of the expression only."""
    m = GROUP.match(expr)
    assert m, f"the group expression changed shape: {expr}"
    fmt = m["slot"] if event == "schedule" else m["manual"]
    return fmt.format(*((channel, slot_date) if event == "schedule" else (channel, run_id)))


class ConcurrencyGroup(unittest.TestCase):
    def setUp(self):
        self.doc = load()
        self.job = self.doc["jobs"]["make-video"]
        self.expr = self.job["concurrency"]["group"]

    def g(self, **kw):
        base = dict(event="schedule", channel="default", slot_date="2026-10-20", run_id=1)
        return group_for(self.expr, **{**base, **kw})

    def test_a_running_run_is_never_cancelled(self):
        self.assertIs(self.job["concurrency"]["cancel-in-progress"], False)

    def test_scheduled_runs_share_a_group_per_channel_and_slot(self):
        self.assertEqual(self.g(run_id=1), self.g(run_id=2))                       # a late cron and a catch-up queue
        self.assertNotEqual(self.g(channel="a"), self.g(channel="b"))              # channels never wait for each other
        self.assertNotEqual(self.g(slot_date="2026-10-20"), self.g(slot_date="2026-10-21"))
        self.assertTrue(self.g().startswith("nightshift-slot-"))

    def test_every_manual_dispatch_has_a_group_of_its_own(self):
        # A pending dispatch is replaced by the next job in its group, and a paid "Run now" replaced before the
        # step that claims its credit hold would leave the hold unclaimed until it expires.
        for event in ("workflow_dispatch", "workflow_call", "repository_dispatch", "push"):
            self.assertNotEqual(self.g(event=event, run_id=1), self.g(event=event, run_id=2), event)
            self.assertNotEqual(self.g(event=event, run_id=1), self.g(event="schedule", run_id=1), event)
            self.assertTrue(self.g(event=event).startswith("nightshift-manual-"), event)

    def test_a_dispatch_carrying_a_credit_ref_can_never_be_in_a_shared_group(self):
        # credit_ref is only an input of workflow_dispatch; the shared group is selected by the event alone.
        self.assertIn("credit_ref", (self.doc.get(True) or self.doc["on"])["workflow_dispatch"]["inputs"])
        shared = {self.g(event="schedule", channel=c, slot_date=d, run_id=r)
                  for c in ("default", "shop") for d in ("2026-10-20", "2026-10-21") for r in range(1, 6)}
        for run_id in range(1, 6):
            for channel in ("default", "shop"):
                self.assertNotIn(self.g(event="workflow_dispatch", channel=channel, run_id=run_id), shared)

    def test_the_shared_group_is_built_only_behind_the_schedule_condition(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(text.count("format('nightshift-slot-"), 1)
        self.assertLess(self.expr.index("github.event_name == 'schedule'"), self.expr.index("nightshift-slot-"))

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

    def test_the_run_step_hands_the_guard_the_pause_variable(self):
        env = step("make-video", "Run Chronos bot")["env"]
        self.assertEqual(env["NIGHTSHIFT_PIPELINE_PAUSED"], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")
        self.assertEqual(env["EVENT_NAME"], "${{ github.event_name }}")

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

    def test_the_original_hourly_cron_is_kept_first_and_backups_are_added(self):
        # GitHub's cron is best effort (about one tick in four was delivered over seven weeks), so the hour has
        # several ticks. The ORIGINAL entry stays exactly as it was: the resolver treats it, and only it, as the
        # tick that may start the exact hour on an unreadable source (schedule_catchup.PRIMARY_CRON).
        from modules import schedule_catchup

        crons = [e["cron"] for e in (load().get(True) or load().get("on"))["schedule"]]
        self.assertEqual(crons[0], "0 * * * *")
        self.assertEqual(crons[0], schedule_catchup.PRIMARY_CRON)
        self.assertEqual(crons[1:], ["15,30,45 * * * *"])
        minutes = sorted(int(m) for c in crons for m in c.split()[0].split(","))
        self.assertEqual(minutes, [0, 15, 30, 45])
        for c in crons:
            self.assertEqual(c.split()[1:], ["*", "*", "*", "*"], c)               # every hour, every day

    def test_the_resolver_is_told_which_cron_fired_only_on_a_schedule_event(self):
        env = step("resolve", "Pick due channels")["env"]
        self.assertEqual(env["TICK_CRON"], "${{ github.event.schedule }}")
        script = step("resolve", "Pick due channels")["run"]
        self.assertIn('--due-hour "$(date -u +%-H)" --tick "$TICK_CRON"', script)
        self.assertEqual(script.count("--tick"), 1)                                # a manual run is never a "tick"

    def test_the_resolver_gets_the_window_from_a_repo_variable_and_the_pause_is_still_passed(self):
        env = step("resolve", "Pick due channels")["env"]
        self.assertEqual(env["NIGHTSHIFT_CATCHUP_HOURS"], "${{ vars.NIGHTSHIFT_CATCHUP_HOURS }}")
        self.assertEqual(env["NIGHTSHIFT_PIPELINE_PAUSED"], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")

    def test_the_scheduled_resolver_still_filters_by_the_current_hour(self):
        script = step("resolve", "Pick due channels")["run"]
        self.assertIn('python tools/list_channels.py --due-hour "$(date -u +%-H)"', script)
        self.assertNotIn("--due-hour", script.split("elif")[0])                    # a named channel ignores the hour


@unittest.skipUnless(BASH, "needs bash")
class TheResolverStep(unittest.TestCase):
    """The 'Pick due channels' script, run for real under bash with a stand-in python that records its argv."""

    def go(self, *, event, channel="", tick=""):
        script = step("resolve", "Pick due channels")["run"]
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            calls, out = d / "calls", d / "out"
            fake = d / "bin"
            fake.mkdir()
            py = fake / "python"
            py.write_text('#!/bin/sh\ncase "$1" in\n  tools/list_channels.py) echo "$@" >> "$CALLS"; echo \'{"include": []}\';;\n'
                          '  *) cat >/dev/null; echo 0;;\nesac\n')
            py.chmod(py.stat().st_mode | stat.S_IEXEC)
            env = {"PATH": f"{fake}:{os.environ['PATH']}", "CALLS": str(calls), "GITHUB_OUTPUT": str(out),
                   "EVENT_NAME": event, "INPUT_CHANNEL": channel, "TICK_CRON": tick}
            proc = subprocess.run([BASH, "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                                  env=env, capture_output=True, text=True, timeout=60)
            return proc, calls.read_text().splitlines() if calls.exists() else []

    def test_a_scheduled_tick_passes_the_hour_and_the_cron_that_fired(self):
        proc, calls = self.go(event="schedule", tick="15,30,45 * * * *")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(calls[0], r"^tools/list_channels\.py --due-hour \d+ --tick 15,30,45 \* \* \* \*$")

    def test_a_tick_with_no_cron_is_still_passed_so_it_counts_as_a_backup(self):
        proc, calls = self.go(event="schedule", tick="")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(calls[0], r"--due-hour \d+ --tick $")

    def test_manual_runs_never_carry_a_tick(self):
        for event, channel, want in (("workflow_dispatch", "", "tools/list_channels.py"),
                                     ("workflow_dispatch", "default", "tools/list_channels.py --only default")):
            proc, calls = self.go(event=event, channel=channel, tick="")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(calls, [want])


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
