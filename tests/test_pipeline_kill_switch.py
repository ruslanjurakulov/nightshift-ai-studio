"""Pausing really pauses: the registry-loaded-but-all-paused case and the global switch.

Before this, tools/list_channels.py re-added the legacy `default` channel
(Chronos, the operator's test channel) whenever no operator channel was active.
Pausing Chronos in the Command Center therefore never stopped a scheduled run:
with every operator channel paused the fallback still scheduled `default` at the
15:00 UTC slot, and a `--due-hour` filter was applied after the fallback. There
was no way to pause the whole pipeline either.

What these tests pin:

* registry LOADED, no operator channel active  -> empty matrix on purpose, said out loud;
* registry UNREADABLE (raises)                  -> the fail-safe fallback to `default`,
  loud, with the exception TYPE only, and never when the global switch is on;
* NIGHTSHIFT_PIPELINE_PAUSED                    -> 1/true/yes/on pause, anything else does not;
* an explicit `--only` run and `--all` listing are not the scheduler and ignore the pause;
* daily_video.yml turns an empty matrix into a skipped job, not a red run.

Runs under both ``python -m pytest`` and ``python -m unittest``.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

from modules.channels import DEFAULT_ORG_ID, ChannelContext, ChannelRegistry
from tools import list_channels

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"
CUSTOMER_ORG = "8710f2b3-bcd6-4c90-a992-cbc329af93bb"
BASH = shutil.which("bash")


def _row(channel_id, org_id=DEFAULT_ORG_ID, *, status="ACTIVE", hour=15, schedule_on=True) -> dict:
    return {
        "channel_id": channel_id,
        "name": channel_id,
        "niche": "tech",
        "status": status,
        "org_id": org_id,
        "schedule_config": {"enabled": schedule_on, "publish_hour_utc": hour},
        "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z"},
    }


def _registry(*rows) -> ChannelRegistry:
    return ChannelRegistry([ChannelContext.from_dict(r) for r in rows])


class _Unreadable:
    """A registry whose read blows up with a message that must never be logged."""

    def active(self):
        raise RuntimeError("boom https://secret-project.supabase.co key=sb_secret_SENTINEL")


def _run(due_hour=None, registry=None, env=None):
    """due_channels with the pause variable controlled; returns (ids, stderr)."""
    clean = {k: v for k, v in os.environ.items() if k != list_channels.PAUSE_ENV}
    clean.update(env or {})
    err = io.StringIO()
    with mock.patch.dict(os.environ, clean, clear=True), contextlib.redirect_stderr(err):
        rows = list_channels.due_channels(due_hour, registry=registry)
    return [r["channel_id"] for r in rows], err.getvalue()


class AllOperatorChannelsPausedIsAnEmptyMatrix(unittest.TestCase):
    def test_pausing_chronos_the_only_operator_channel_schedules_nothing(self):
        ids, err = _run(15, _registry(_row("default", status="PAUSED")))
        self.assertEqual(ids, [])
        self.assertIn("all operator channels paused", err)

    def test_switching_the_schedule_off_is_the_same_decision(self):
        ids, err = _run(15, _registry(_row("default", schedule_on=False)))
        self.assertEqual(ids, [])
        self.assertIn("all operator channels paused", err)

    def test_every_operator_channel_paused_schedules_nothing_not_default(self):
        reg = _registry(_row("default", status="PAUSED"), _row("shop", status="PAUSED"))
        self.assertEqual(_run(15, reg)[0], [])

    def test_the_due_hour_filter_cannot_resurrect_a_paused_default(self):
        reg = _registry(_row("default", status="PAUSED"))
        for hour in (None, 0, 15, 23):
            self.assertEqual(_run(hour, reg)[0], [], f"hour {hour}")

    def test_pausing_chronos_leaves_the_other_operator_channels_running(self):
        reg = _registry(_row("default", status="PAUSED"), _row("shop"))
        ids, err = _run(15, reg)
        self.assertEqual(ids, ["shop"])
        self.assertNotIn("all operator channels paused", err)

    def test_a_customers_active_channel_never_stands_in_for_paused_operator_ones(self):
        reg = _registry(_row("default", status="PAUSED"), _row("customer-chan", CUSTOMER_ORG))
        ids, err = _run(15, reg)
        self.assertEqual(ids, [])
        self.assertIn("customer-chan", err)  # named as not scheduled
        self.assertIn("all operator channels paused", err)

    def test_customers_are_never_scheduled_even_when_the_operator_is_running(self):
        reg = _registry(_row("default"), _row("customer-chan", CUSTOMER_ORG))
        self.assertEqual(_run(15, reg)[0], ["default"])

    def test_a_running_chronos_is_still_scheduled(self):
        self.assertEqual(_run(15, _registry(_row("default")))[0], ["default"])


class UnreadableRegistryKeepsTheLoudFailSafe(unittest.TestCase):
    def test_an_exception_falls_back_to_default_and_says_so(self):
        ids, err = _run(None, _Unreadable())
        self.assertEqual(ids, ["default"])
        self.assertIn("UNREADABLE", err)
        self.assertIn("FALLING BACK", err)
        self.assertIn("RuntimeError", err)

    def test_the_warning_carries_the_exception_type_only(self):
        _, err = _run(None, _Unreadable())
        for leaked in ("boom", "secret-project", "sb_secret_SENTINEL", "supabase.co"):
            self.assertNotIn(leaked, err)

    def test_the_fallback_is_not_the_all_paused_note(self):
        _, err = _run(None, _Unreadable())
        self.assertNotIn("all operator channels paused", err)

    def test_the_due_hour_filter_still_applies_to_the_fallback(self):
        # The legacy default sits at 15:00 UTC: at any other hour the hourly
        # cron must not run it.
        self.assertEqual(_run(3, _Unreadable())[0], [])
        self.assertEqual(_run(15, _Unreadable())[0], ["default"])

    def test_the_global_pause_beats_the_fallback(self):
        ids, err = _run(15, _Unreadable(), env={"NIGHTSHIFT_PIPELINE_PAUSED": "true"})
        self.assertEqual(ids, [])
        self.assertIn("pipeline paused by NIGHTSHIFT_PIPELINE_PAUSED", err)
        self.assertNotIn("UNREADABLE", err)

    def test_a_loaded_registry_never_takes_the_fallback_path(self):
        _, err = _run(15, _registry(_row("default", status="PAUSED")))
        self.assertNotIn("UNREADABLE", err)
        self.assertNotIn("FALLING BACK", err)


class GlobalPauseSwitch(unittest.TestCase):
    RUNNING = _registry(_row("default"), _row("shop"))

    def test_truthy_words_pause_in_any_case_with_spaces(self):
        for value in ("1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " true ", "\ton\n"):
            ids, err = _run(15, self.RUNNING, env={"NIGHTSHIFT_PIPELINE_PAUSED": value})
            self.assertEqual(ids, [], repr(value))
            self.assertIn("pipeline paused by NIGHTSHIFT_PIPELINE_PAUSED", err, repr(value))

    def test_everything_else_does_not_pause(self):
        for value in ("", "0", "false", "False", "no", "off", "ture", "paused", "2", "y", "enabled", "{", "🛑"):
            ids, err = _run(15, self.RUNNING, env={"NIGHTSHIFT_PIPELINE_PAUSED": value})
            self.assertEqual(ids, ["default", "shop"], repr(value))
            self.assertNotIn("pipeline paused", err, repr(value))

    def test_unset_does_not_pause(self):
        self.assertEqual(_run(15, self.RUNNING)[0], ["default", "shop"])

    def test_a_typo_is_warned_about_and_never_echoed(self):
        _, err = _run(15, self.RUNNING, env={"NIGHTSHIFT_PIPELINE_PAUSED": "ture"})
        self.assertIn("NOT paused", err)
        self.assertNotIn("ture", err.replace("NIGHTSHIFT_PIPELINE_PAUSED", ""))

    def test_the_known_off_words_are_silent(self):
        for value in ("", "0", "false", "no", "off"):
            _, err = _run(15, self.RUNNING, env={"NIGHTSHIFT_PIPELINE_PAUSED": value})
            self.assertNotIn("warning", err, repr(value))

    def test_pausing_chronos_alone_does_not_need_the_switch_and_the_switch_needs_no_registry(self):
        # The switch must work when the database is the thing that is down.
        ids, _ = _run(None, _Unreadable(), env={"NIGHTSHIFT_PIPELINE_PAUSED": "1"})
        self.assertEqual(ids, [])

    def test_pipeline_paused_reads_the_given_mapping(self):
        self.assertTrue(list_channels.pipeline_paused({"NIGHTSHIFT_PIPELINE_PAUSED": "on"}))
        self.assertFalse(list_channels.pipeline_paused({}))


class CommandLineEntryPoint(unittest.TestCase):
    """main(): the pause is for the scheduler's listing, not for a named run."""

    def _main(self, argv, registry, env=None):
        clean = {k: v for k, v in os.environ.items() if k != list_channels.PAUSE_ENV}
        clean.update(env or {})
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, clean, clear=True), \
                mock.patch.object(sys, "argv", ["list_channels.py", *argv]), \
                mock.patch.object(list_channels, "ChannelRegistry", lambda: registry), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = list_channels.main()
        return rc, out.getvalue(), err.getvalue()

    def test_a_paused_pipeline_prints_a_valid_empty_matrix_and_exits_zero(self):
        rc, out, err = self._main(["--due-hour", "15"], _registry(_row("default")),
                                  {"NIGHTSHIFT_PIPELINE_PAUSED": "true"})
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {"include": []})
        self.assertIn("pipeline paused", err)

    def test_all_paused_prints_a_valid_empty_matrix_and_exits_zero(self):
        rc, out, _ = self._main(["--due-hour", "15"], _registry(_row("default", status="PAUSED")))
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {"include": []})

    def test_a_named_manual_run_ignores_the_pause(self):
        rc, out, _ = self._main(["--only", "default"], _registry(_row("default")),
                                {"NIGHTSHIFT_PIPELINE_PAUSED": "true"})
        self.assertEqual(rc, 0)
        self.assertEqual([r["channel_id"] for r in json.loads(out)["include"]], ["default"])

    def test_the_all_channels_admin_listing_ignores_the_pause(self):
        rc, out, _ = self._main(["--all"], _registry(_row("default", status="PAUSED")),
                                {"NIGHTSHIFT_PIPELINE_PAUSED": "true"})
        self.assertEqual(rc, 0)
        self.assertEqual([r["channel_id"] for r in json.loads(out)["include"]], ["default"])


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def _step(job: str, name: str) -> dict:
    return next(s for s in _workflow()["jobs"][job]["steps"] if s.get("name") == name)


class WorkflowHandlesAnEmptyMatrix(unittest.TestCase):
    def test_make_video_is_skipped_when_the_count_is_zero(self):
        job = _workflow()["jobs"]["make-video"]
        self.assertEqual(str(job["if"]).replace(" ", ""), "needs.resolve.outputs.count>0")
        self.assertEqual(job["needs"], "resolve")

    def test_the_matrix_is_only_parsed_from_the_resolve_output(self):
        matrix = _workflow()["jobs"]["make-video"]["strategy"]["matrix"]
        self.assertEqual(matrix.replace(" ", ""), "${{fromJson(needs.resolve.outputs.matrix)}}")

    def test_resolve_publishes_both_the_matrix_and_the_count(self):
        outputs = _workflow()["jobs"]["resolve"]["outputs"]
        self.assertIn("matrix", outputs)
        self.assertIn("count", outputs)

    def test_the_pause_variable_reaches_the_resolver_through_env_not_shell_text(self):
        step = _step("resolve", "Pick due channels")
        self.assertEqual(step["env"]["NIGHTSHIFT_PIPELINE_PAUSED"], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")
        self.assertNotIn("${{", step["run"])

    def test_the_pause_variable_is_not_handed_to_the_render_step(self):
        # Nothing downstream reads it; the render job only exists when something is due.
        self.assertNotIn("NIGHTSHIFT_PIPELINE_PAUSED", _step("make-video", "Run Chronos bot")["env"])

    def test_workflow_permissions_are_unchanged(self):
        self.assertEqual(_workflow()["permissions"], {"contents": "read"})


@unittest.skipUnless(BASH, "bash is required to run the workflow step")
class PickStepEndToEnd(unittest.TestCase):
    """Run the workflow's real "Pick due channels" script against the real resolver."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        shim = self.tmp / "bin"
        shim.mkdir()
        (shim / "python").symlink_to(sys.executable)
        self.shim = shim
        self.out = self.tmp / "github_output"
        self.out.write_text("")

    def pick(self, event: str, channel: str = "", paused: str = ""):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("SUPABASE", "NIGHTSHIFT_PIPELINE"))}
        env.update({
            "PATH": str(self.shim) + os.pathsep + env.get("PATH", ""),
            "GITHUB_OUTPUT": str(self.out),
            "EVENT_NAME": event,
            "INPUT_CHANNEL": channel,
            "NIGHTSHIFT_PIPELINE_PAUSED": paused,
            "PYTHONPATH": str(ROOT),
        })
        script = _step("resolve", "Pick due channels")["run"]
        proc = subprocess.run([BASH, "-e", "-c", script], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=120)
        lines = dict(l.split("=", 1) for l in self.out.read_text().splitlines() if "=" in l)
        return proc, lines

    def test_a_paused_schedule_resolves_to_an_empty_matrix_and_a_green_step(self):
        proc, out = self.pick("schedule", paused="true")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(out["matrix"]), {"include": []})
        self.assertEqual(out["count"], "0")
        self.assertIn("pipeline paused by NIGHTSHIFT_PIPELINE_PAUSED", proc.stderr)

    def test_a_paused_all_channels_dispatch_resolves_to_nothing(self):
        proc, out = self.pick("workflow_dispatch", paused="1")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(out["count"], "0")

    def test_the_same_dispatch_unpaused_still_finds_the_default_channel(self):
        proc, out = self.pick("workflow_dispatch", paused="false")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(out["count"], "1")
        self.assertEqual(json.loads(out["matrix"])["include"][0]["channel_id"], "default")

    def test_a_named_manual_dispatch_runs_even_while_paused(self):
        proc, out = self.pick("workflow_dispatch", channel="default", paused="true")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(out["count"], "1")


if __name__ == "__main__":
    unittest.main()
