"""A series can be named on a manual Actions dispatch, and nowhere else yet.

``main.run(series=...)`` always resolved a Series (niche, look, voice style,
avatar, playlist) but only ``main.py --series`` reached it: no workflow input,
no argv builder. This pins the Actions path:

* ``daily_video.yml`` has an optional ``series`` input, read through the
  environment (``INPUT_SERIES``), validated before it can reach the command line,
  and appended as ``--series`` only when non-empty and valid;
* ``modules.run_request.build_main_args`` builds the same argument, so a future
  queue path that can carry it cannot drift (the queue/UI path cannot carry one
  today: ``series`` is deliberately NOT in ``ALLOWED_PARAMS``, because the
  database whitelist ``render_job_params_valid`` would refuse such a job);
* a series that is not ACTIVE, is unknown, or belongs to another channel stops
  ``main.run`` before anything is spent.

The run step is executed under bash with a fake ``python`` that records the
``main.py`` argv, so the tests see what the shell really builds, hostile values
included. No network, no Supabase.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import run_request  # noqa: E402
from modules.run_request import InvalidRunRequest  # noqa: E402
from modules.series import (  # noqa: E402
    STATUS_ACTIVE,
    STATUS_ARCHIVED,
    STATUS_PAUSED,
    Series,
    SeriesNotRunnable,
    SeriesRegistry,
    require_runnable_series,
)
from tools import validate_series_input  # noqa: E402

WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"
VALIDATOR = "tools/validate_series_input.py"

# Everything a series id must NOT be. Each one is something a person could
# type into the dispatch form, or an attacker could put in a dispatch API call.
INVALID_IDS = {
    "path traversal": "../../etc/passwd",
    "path traversal, dotted": "..",
    "slash": "a/b",
    "backslash": "a\\b",
    "space inside": "my series",
    "padded with spaces": " my-series ",
    "trailing newline": "my-series\n",
    "embedded newline": "my-series\n::add-mask::x",
    "carriage return": "my-series\r",
    "tab": "my\tseries",
    "semicolon": "x;touch PWN",
    "command substitution": "$(touch PWN)",
    "backticks": "`touch PWN`",
    "quote": "x'; touch PWN; '",
    "double quote": 'x"; touch PWN; "',
    "ampersand": "x&&touch PWN",
    "pipe": "x|touch PWN",
    "redirect": "x>PWN",
    "dollar var": "$HOME",
    "glob": "*",
    "leading dash (would read as a flag)": "-rf",
    "leading dot": ".hidden",
    "leading underscore": "_x",
    "unicode letters": "серия",
    "unicode lookalike": "série",
    "emoji": "series-\U0001f600",
    "full-width digits": "series-１",
    "uppercase": "My-Series",
    "all uppercase": "SERIES",
    "very long": "a" * 65,
    "absurdly long": "a" * 100_000,
    "null byte": "a\x00b",
    "only whitespace": "   ",
}
VALID_IDS = ("ancient-mysteries", "a", "0", "s1.v2_x-y", "a" * 64)


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def _step(job: str, name: str) -> dict:
    return next(s for s in _workflow()["jobs"][job]["steps"] if s.get("name") == name)


def _series(sid="alpha", status=STATUS_ACTIVE, channel="news", **kw) -> Series:
    return Series(series_id=sid, channel_id=channel, status=status, name=sid.title(), **kw)


# -- the workflow's own structure -------------------------------------------

class WorkflowStructure(unittest.TestCase):
    def test_series_is_an_optional_dispatch_input_defaulting_to_none(self):
        spec = _workflow()[True]["workflow_dispatch"]["inputs"]["series"]
        self.assertFalse(spec.get("required"))
        self.assertEqual(spec.get("default"), "")
        self.assertNotIn("type", spec)            # free text: a choice list would have to be edited per series

    def test_the_run_step_reads_it_from_the_environment(self):
        env = _step("make-video", "Run Chronos bot")["env"]
        self.assertEqual(env["INPUT_SERIES"], "${{ github.event.inputs.series }}")

    def test_no_run_script_interpolates_the_series_input(self):
        # GitHub pastes ${{ ... }} into the script text before bash parses it; a
        # series id like  x'; rm -rf ~; '  would then be code (see test_workflow_lint).
        for job_name, job in _workflow()["jobs"].items():
            for step in job["steps"]:
                script = step.get("run") or ""
                with self.subTest(job=job_name, step=step.get("name")):
                    self.assertNotRegex(script, r"\$\{\{[^}]*series", "series spliced into shell text")
                    self.assertNotIn("github.event.inputs.series", script)
                    self.assertNotIn("inputs.series", script)

    def test_the_series_flag_is_conditional_and_follows_the_validator(self):
        script = _step("make-video", "Run Chronos bot")["run"]
        self.assertIn('if [ -n "${INPUT_SERIES:-}" ]; then', script)
        self.assertIn('args+=(--series "$INPUT_SERIES")', script)
        self.assertEqual(script.count("--series"), 1)
        self.assertLess(script.index(VALIDATOR), script.index('args+=(--series "$INPUT_SERIES")'))
        self.assertLess(script.index('args+=(--series "$INPUT_SERIES")'), script.index("python main.py"))

    def test_a_bad_id_fails_in_the_resolve_job_before_any_channel_job_starts(self):
        steps = [s.get("name") for s in _workflow()["jobs"]["resolve"]["steps"]]
        validate = _step("resolve", "Validate series")
        self.assertLess(steps.index("Validate series"), steps.index("Pick due channels"))
        self.assertEqual(validate["env"]["INPUT_SERIES"], "${{ github.event.inputs.series }}")
        self.assertIn(VALIDATOR, validate["run"])
        self.assertIn("--require-channel", validate["run"])
        self.assertNotIn("${{", validate["run"])
        # Skipped when no series was typed: a scheduled run never executes it.
        self.assertEqual(validate["if"], "github.event.inputs.series != ''")

    def test_the_run_step_does_not_hand_series_to_anything_but_main(self):
        # The credit steps and every other step get no series at all.
        for step in _workflow()["jobs"]["make-video"]["steps"]:
            if step.get("name") == "Run Chronos bot":
                continue
            self.assertNotIn("INPUT_SERIES", step.get("env") or {}, step.get("name"))


# -- the shell, run for real --------------------------------------------------

FAKE_PYTHON = """#!/bin/bash
case "$1" in
  main.py) printf '%s\\n' "${@:2}" > "$ARGV_OUT"; exit "${FAKE_MAIN_RC:-0}";;
  tools/slot_guard.py) exit 0;;
  *) exec "$REAL_PYTHON" "$@";;
esac
"""


class RunStepUnderBash(unittest.TestCase):
    """The real ``run:`` script of "Run Chronos bot", with ``python main.py``
    replaced by a recorder."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="series-dispatch-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        bindir = self.tmp / "bin"
        bindir.mkdir()
        fake = bindir / "python"
        fake.write_text(FAKE_PYTHON)
        fake.chmod(0o755)
        self.script = self.tmp / "step.sh"
        self.script.write_text(_step("make-video", "Run Chronos bot")["run"])
        self.argv_out = self.tmp / "argv.txt"
        self.pwn = self.tmp / "PWN"

    def run_step(self, series=None, event="workflow_dispatch", **inputs):
        env = {
            "PATH": f"{self.tmp / 'bin'}:{os.environ['PATH']}",
            "HOME": str(self.tmp),
            "REAL_PYTHON": sys.executable,
            "ARGV_OUT": str(self.argv_out),
            "GITHUB_OUTPUT": str(self.tmp / "gh_output"),
            "CHANNEL_ID": "news",
            "YOUTUBE_PRIVACY": "private",
            "EVENT_NAME": event,
            "SLOT_START": "2026-10-24T15:00:00Z",
            "INPUT_TOPIC": "", "INPUT_NICHE": "", "INPUT_DURATION": "", "INPUT_LANGUAGE": "",
            "INPUT_VISUAL_STYLE": "", "INPUT_RESUME": "", "INPUT_REPAIR_SCENES": "",
        }
        env.update({f"INPUT_{k.upper()}": v for k, v in inputs.items()})
        env["YOUTUBE_PRIVACY"] = inputs.get("privacy") or "private"      # the step's env: derives it
        if series is not None:
            env["INPUT_SERIES"] = series
        proc = subprocess.run(["bash", "-e", str(self.script)], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=60)
        argv = self.argv_out.read_text().splitlines() if self.argv_out.exists() else None
        return proc, argv

    def test_no_series_builds_exactly_the_old_command(self):
        for series in (None, ""):
            with self.subTest(series=series):
                self.argv_out.unlink(missing_ok=True)
                proc, argv = self.run_step(series)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(argv, ["--channel", "news", "--privacy", "private"])

    def test_a_scheduled_run_never_carries_a_series(self):
        # A cron tick has no dispatch inputs: INPUT_SERIES is empty, and the
        # matrix tools/list_channels.py builds names no series either.
        proc, argv = self.run_step("", event="schedule")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("--series", argv)
        self.assertEqual(argv, ["--channel", "news", "--privacy", "private"])

    def test_a_valid_series_is_one_argument_after_the_style_flag(self):
        for sid in VALID_IDS:
            with self.subTest(series=sid):
                self.argv_out.unlink(missing_ok=True)
                proc, argv = self.run_step(sid, topic="Rome", visual_style="noir", resume="true")
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(argv, ["--channel", "news", "--privacy", "private", "--topic", "Rome",
                                        "--visual-style", "noir", "--series", sid, "--resume"])

    def test_every_invalid_id_fails_the_step_before_main_runs_and_executes_nothing(self):
        for label, bad in INVALID_IDS.items():
            if "\x00" in bad:
                continue                     # an env var cannot hold NUL: the OS refuses it (own test below)
            with self.subTest(case=label):
                self.argv_out.unlink(missing_ok=True)
                self.pwn.unlink(missing_ok=True)
                proc, argv = self.run_step(bad)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIsNone(argv, "main.py must not run for an invalid series id")
                self.assertFalse(self.pwn.exists())
                self.assertFalse((ROOT / "PWN").exists())
                self.assertIn("::error", proc.stdout)
                # The error names the fix and never echoes the value (a newline in it
                # could otherwise forge a workflow command such as ::add-mask::).
                self.assertIn("lowercase", proc.stdout)
                commands = [ln for ln in proc.stdout.splitlines() if ln.startswith("::")]
                self.assertEqual(len(commands), 1, commands)
                self.assertTrue(commands[0].startswith("::error"))
                self.assertNotIn("add-mask", proc.stdout)
                self.assertNotIn(bad.strip() or "\0", proc.stdout.replace("lowercase", ""))

    def test_actions_and_builder_agree_on_every_valid_combination(self):
        # The parity the queue builder exists for: same inputs, same argv.
        cases = [
            {},
            {"series": "alpha"},
            {"series": "alpha", "topic": "Rome"},
            {"series": "alpha", "niche": "history", "duration": 300, "language": "Arabic",
             "visual_style": "noir", "resume": True},
            {"series": "s1.v2_x-y", "privacy": "unlisted"},
        ]
        for params in cases:
            with self.subTest(params=params):
                self.argv_out.unlink(missing_ok=True)
                inputs = {k: ("true" if v is True else str(v)) for k, v in params.items()}
                proc, shell_argv = self.run_step(**inputs)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(shell_argv, run_request.build_main_args("news", params))

    def test_a_nul_byte_cannot_even_reach_the_environment(self):
        with self.assertRaises(ValueError):
            self.run_step("a\x00b")

    def test_main_failure_exit_codes_still_pass_through(self):
        # The series flag must not swallow the runner's contract (75/78/79 are green, others red).
        script = self.script.read_text()
        self.assertIn('if [ "$rc" -eq 75 ]', script)
        self.assertTrue(script.rstrip().endswith('exit "$rc"'))


# -- the argument builder -----------------------------------------------------

class ArgsBuilder(unittest.TestCase):
    def test_without_series_nothing_changes(self):
        self.assertEqual(run_request.build_main_args("news", {}), ["--channel", "news", "--privacy", "private"])
        self.assertEqual(run_request.build_main_args("news", {"series": ""}),
                         ["--channel", "news", "--privacy", "private"])
        self.assertEqual(run_request.build_main_args("news", {"series": None}),
                         ["--channel", "news", "--privacy", "private"])

    def test_with_series_it_is_the_flag_and_the_id(self):
        argv = run_request.build_main_args("news", {"series": "alpha"})
        self.assertEqual(argv, ["--channel", "news", "--privacy", "private", "--series", "alpha"])

    def test_every_invalid_id_is_refused_by_the_builder_too(self):
        for label, bad in INVALID_IDS.items():
            with self.subTest(case=label), self.assertRaises(InvalidRunRequest) as caught:
                run_request.build_main_args("news", {"series": bad})
            self.assertNotIn(bad.strip() or "\0", str(caught.exception).replace("series", ""))

    def test_a_non_string_series_is_refused(self):
        for bad in (5, True, ["a"], {"a": 1}):
            with self.subTest(bad=bad), self.assertRaises(InvalidRunRequest):
                run_request.build_main_args("news", {"series": bad})

    def test_the_queue_path_cannot_carry_a_series_yet(self):
        # render_job_params_valid (supabase/migrations/0029_publish_targets.sql, the last migration
        # that defines it) refuses an unknown key, so a job with a series would be rejected by the
        # database anyway. Accepting one here would make a job that validates in Python and fails in
        # SQL; the whitelist moves together with a migration, not before it.
        self.assertNotIn("series", run_request.ALLOWED_PARAMS)
        with self.assertRaises(InvalidRunRequest):
            run_request.validate("news", "daily", {"series": "alpha"})
        with self.assertRaises(InvalidRunRequest):
            run_request.plan_run("news", "daily", {"series": "alpha"}, {})

    def test_the_comment_about_the_missing_migration_names_the_right_file(self):
        source = (ROOT / "modules" / "run_request.py").read_text()
        self.assertIn("0029_publish_targets.sql", source)
        migrations = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
        latest = [m.name for m in migrations if "function public.render_job_params_valid" in m.read_text()][-1]
        self.assertEqual(latest, "0029_publish_targets.sql")

    def test_a_series_id_the_validator_accepts_is_one_the_builder_accepts(self):
        for sid in VALID_IDS:
            self.assertEqual(run_request.validate_series_arg(sid), sid)


# -- the validator the workflow calls --------------------------------------------

class ValidatorTool(unittest.TestCase):
    def call(self, env, require_channel=False):
        out = []
        rc = validate_series_input.main(env, argv=["--require-channel"] if require_channel else [],
                                        out=out.append)
        return rc, out

    def test_empty_is_none_and_costs_nothing(self):
        for env in ({}, {"INPUT_SERIES": ""}):
            self.assertEqual(self.call(env), (0, []))

    def test_valid_passes_silently(self):
        self.assertEqual(self.call({"INPUT_SERIES": "alpha"}), (0, []))

    def test_invalid_is_an_error_annotation_with_the_fix(self):
        rc, out = self.call({"INPUT_SERIES": "Bad Id"})
        self.assertEqual(rc, 1)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("::error"))
        self.assertIn("lowercase", out[0])
        self.assertNotIn("Bad Id", out[0])

    def test_a_series_without_a_channel_is_refused_when_asked(self):
        # An empty channel means "every active channel": the series would be applied to channels
        # it does not belong to. main.run refuses that too; this stops it before any job starts.
        env = {"INPUT_SERIES": "alpha", "INPUT_CHANNEL": "  "}
        rc, out = self.call(env, require_channel=True)
        self.assertEqual(rc, 1)
        self.assertIn("channel", out[0])
        env["INPUT_CHANNEL"] = "news"
        self.assertEqual(self.call(env, require_channel=True), (0, []))

    def test_the_channel_is_not_required_when_the_flag_is_absent(self):
        self.assertEqual(self.call({"INPUT_SERIES": "alpha"}), (0, []))

    def test_as_a_script_the_exit_code_is_the_verdict(self):
        env = {"PATH": os.environ["PATH"], "INPUT_SERIES": "x;y"}
        proc = subprocess.run([sys.executable, str(ROOT / VALIDATOR)], cwd=ROOT, env=env,
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("::error", proc.stdout)


# -- scheduled runs: list_channels names no series -----------------------------------

class ScheduledRunsUnchanged(unittest.TestCase):
    def test_the_matrix_rows_carry_no_series(self):
        from modules.channels import ChannelContext, ChannelRegistry
        from tools import list_channels
        row = {"channel_id": "news", "name": "News", "niche": "tech", "status": "ACTIVE",
               "schedule_config": {"enabled": True, "publish_hour_utc": 15},
               "credential_ref": {"youtube_channel_id": "UCnews", "verified_at": "2026-09-01T00:00:00Z"}}
        reg = ChannelRegistry([ChannelContext.from_dict(row)])
        rows = list_channels.due_channels(15, registry=reg)
        self.assertTrue(rows)
        for r in rows:
            self.assertFalse([k for k in r if "series" in k.lower()], r)

    def test_nothing_but_the_dispatch_path_feeds_the_series_flag(self):
        # tools/list_channels.py, the queue worker and the run env builder pass no series today.
        for rel in ("tools/list_channels.py", "tools/queue_worker.py"):
            self.assertNotRegex((ROOT / rel).read_text().lower(), r"--series|input_series", rel)
        self.assertNotIn("series", run_request.build_run_env({}, {}))


# -- a series that cannot run stops the run before it spends ----------------------------

class RunnableSeries(unittest.TestCase):
    def test_no_series_asked_means_nothing_to_check(self):
        for requested in (None, ""):
            require_runnable_series(requested, None, "news")

    def test_an_active_series_of_this_channel_runs(self):
        require_runnable_series("alpha", _series(), "news")

    def test_paused_and_archived_series_are_refused_with_the_fix(self):
        for status in (STATUS_PAUSED, STATUS_ARCHIVED):
            with self.subTest(status=status), self.assertRaises(SeriesNotRunnable) as caught:
                require_runnable_series("alpha", _series(status=status), "news")
            msg = str(caught.exception)
            self.assertIn(status, msg)
            self.assertIn("ACTIVE", msg)
            self.assertIn("nothing was spent", msg.lower())

    def test_a_series_that_cannot_be_found_is_refused_not_run_unscoped(self):
        with self.assertRaises(SeriesNotRunnable) as caught:
            require_runnable_series("typo", None, "news")
        self.assertIn("typo", str(caught.exception))

    def test_another_channels_series_is_refused(self):
        with self.assertRaises(SeriesNotRunnable) as caught:
            require_runnable_series("alpha", _series(channel="other"), "news")
        self.assertIn("other", str(caught.exception))
        self.assertIn("news", str(caught.exception))

    def test_it_is_a_runtime_error_like_the_other_early_stops(self):
        self.assertTrue(issubclass(SeriesNotRunnable, RuntimeError))


class MainRunRefusesBeforeSpending(unittest.TestCase):
    """``main.run`` itself, with everything after the series check made to explode."""

    class Reached(Exception):
        pass

    def setUp(self):
        import main  # noqa: PLC0415
        from modules.channels import ChannelContext  # noqa: PLC0415
        self.main = main
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)          # run() makes ./logs
        self.ctx = ChannelContext(channel_id="news", name="News", niche="tech")

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_with(self, registry, series):
        # The disk preflight is the first stage after the credential report: reaching it means
        # "not refused". (A raise inside check_run_credentials would be swallowed as a warning.)
        from modules.credential_health import CredentialCheck, HealthReport  # noqa: PLC0415
        health = HealthReport("news", (CredentialCheck("gemini", "ok", required=True),))
        with mock.patch("modules.series.SeriesRegistry", return_value=registry), \
                mock.patch.object(self.main, "check_run_credentials", return_value=health), \
                mock.patch.object(self.main, "_preflight_disk", side_effect=self.Reached), \
                mock.patch.object(self.main.events, "emit"), \
                mock.patch.object(self.main, "StateStore", side_effect=AssertionError("budget read")), \
                mock.patch.object(self.main, "ScriptEngine", side_effect=AssertionError("script paid for")), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")):
            return self.main.run(channel=self.ctx, series=series, skip_upload=True)

    def test_paused_series_is_refused_and_logged(self):
        reg = SeriesRegistry([_series(status=STATUS_PAUSED)])
        with self.assertLogs(level="WARNING") as logs, self.assertRaises(SeriesNotRunnable):
            self.run_with(reg, "alpha")
        self.assertTrue(any("PAUSED" in m for m in logs.output))

    def test_archived_series_is_refused(self):
        with self.assertRaises(SeriesNotRunnable):
            self.run_with(SeriesRegistry([_series(status=STATUS_ARCHIVED)]), "alpha")

    def test_unknown_series_is_refused(self):
        with self.assertRaises(SeriesNotRunnable):
            self.run_with(SeriesRegistry([_series()]), "nope")

    def test_other_channels_series_is_refused(self):
        with self.assertRaises(SeriesNotRunnable):
            self.run_with(SeriesRegistry([_series(channel="other")]), "alpha")

    def test_an_active_series_goes_on_to_the_preflights(self):
        with self.assertRaises(self.Reached):
            self.run_with(SeriesRegistry([_series()]), "alpha")

    def test_no_series_is_unchanged(self):
        with self.assertRaises(self.Reached):
            self.run_with(SeriesRegistry([]), None)


if __name__ == "__main__":
    unittest.main()
