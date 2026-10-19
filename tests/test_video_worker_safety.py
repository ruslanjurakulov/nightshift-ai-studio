"""A hung or empty video run must not hold the worker or take a customer's money.

Covers the audit's D3, D5 and D7:

* D3 - a queued run has a wall-clock limit (WORKER_JOB_TIMEOUT_SECONDS) and a
  pipeline ffmpeg command has its own; past either the run is stopped, the job
  fails and the hold is released.
* D5 - a run whose required credentials are missing stops before it spends, and
  a media stage that yields nothing stops the run instead of rendering black.
* D7 - the budget stop has its own exit code, and a result file written after
  the render stage is what lets the worker capture credits.

main.py needs the render stack to import, so its wiring is checked by parsing it
(as tests/test_storyboard_review.py does); everything else runs for real.
No network, no provider.
"""

from __future__ import annotations

import ast
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import budget, credential_health, media_fetcher, render_backend, run_checkpoint, run_request  # noqa: E402
from tools import queue_worker as qw  # noqa: E402

MAIN = ROOT / "main.py"
WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"
DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "deploy_web.yml"
WORKER_EXAMPLE = ROOT / "deploy" / ".env.worker.example"


# ── D5: nothing on screen is a failure, not a black video ──────────────────

class RequireMedia(unittest.TestCase):
    def test_no_footage_and_no_images_stops_the_run_with_the_remedy(self):
        with self.assertRaises(media_fetcher.MediaUnavailable) as caught:
            media_fetcher.require_media([], [])
        self.assertIn("PEXELS_API_KEY", str(caught.exception))

    def test_either_kind_of_media_is_enough(self):
        media_fetcher.require_media([Path("a.mp4")], [])
        media_fetcher.require_media([], [Path("a.jpg")])


class PexelsRequirement(unittest.TestCase):
    """Pexels is required unless generated media can carry the video, or this is
    the render benchmark's explicit colour-placeholder run."""

    def report(self, *, pexels_key: str, ai: bool = False, placeholder: bool = False):
        env = {k: v for k, v in os.environ.items() if k != credential_health.PLACEHOLDER_MEDIA_ENV}
        if placeholder:
            env[credential_health.PLACEHOLDER_MEDIA_ENV] = "1"
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("config.GEMINI_API_KEY", "g", create=True), \
                mock.patch("config.PEXELS_API_KEY", pexels_key, create=True), \
                mock.patch("config.TTS_PROVIDER", "edge", create=True), \
                mock.patch.object(credential_health, "ai_media_usable", return_value=ai), \
                mock.patch("modules.channel_credentials.credential_status",
                           return_value=type("s", (), {"is_connected": False, "detail": ""})()):
            return credential_health.check_run_credentials(None)

    def test_a_missing_key_blocks_a_stock_footage_run(self):
        self.assertEqual([c.name for c in self.report(pexels_key="").blocking], ["pexels"])

    def test_a_present_key_never_blocks(self):
        self.assertEqual(self.report(pexels_key="k").blocking, [])

    def test_an_ai_only_configuration_is_not_blocked_by_the_missing_pexels_key(self):
        report = self.report(pexels_key="", ai=True)
        self.assertEqual(report.blocking, [])
        self.assertIn("generated media only", [c for c in report.checks if c.name == "pexels"][0].detail)

    def test_the_benchmarks_placeholder_run_is_not_blocked(self):
        self.assertEqual(self.report(pexels_key="", placeholder=True).blocking, [])

    def test_the_media_check_has_the_same_two_exceptions_and_nothing_else(self):
        media_fetcher.require_media([], [], allow_placeholder=True)
        with self.assertRaises(media_fetcher.MediaUnavailable):
            media_fetcher.require_media([], [])

    def test_the_benchmark_workflow_opts_in_and_main_reads_the_flag(self):
        text = (ROOT / ".github" / "workflows" / "render_benchmark.yml").read_text()
        self.assertIn(f'{credential_health.PLACEHOLDER_MEDIA_ENV}: "1"', text)
        self.assertIn("allow_placeholder=placeholder_media_allowed()", MAIN.read_text())


class MainRunBehaviour(unittest.TestCase):
    """run() itself, with the credential report and the budget stubbed: it must
    stop before any paid stage. Skipped where main.py's render stack is absent."""

    def setUp(self):
        try:
            import main  # noqa: PLC0415
        except Exception as e:  # pragma: no cover - environment without the render stack
            self.skipTest(f"main.py cannot be imported here ({type(e).__name__})")
        self.main = main
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)  # run() makes ./logs
        from modules.channels import ChannelContext  # noqa: PLC0415
        self.ctx = ChannelContext(channel_id="default", name="X", niche="h")
        # What these runs pin is the order of the early stops, not the disk of the machine that runs the test.
        spacious = mock.patch.object(main.disk_guard, "free_bytes", lambda _p: 100 * 1024 ** 3)
        spacious.start()
        self.addCleanup(spacious.stop)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def health(self, *checks):
        from modules.credential_health import HealthReport  # noqa: PLC0415
        return HealthReport("default", tuple(checks))

    def test_run_raises_credentials_missing_before_anything_is_fetched_or_spent(self):
        from modules.credential_health import CredentialCheck, CredentialsMissing  # noqa: PLC0415
        bad = self.health(CredentialCheck("pexels", "missing", required=True, detail="Set PEXELS_API_KEY."))
        with mock.patch.object(self.main, "check_run_credentials", return_value=bad), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")), \
                mock.patch.object(self.main, "StateStore", side_effect=AssertionError("budget read")):
            with self.assertRaises(CredentialsMissing) as caught:
                self.main.run(channel=self.ctx, skip_upload=True)
        self.assertIn("Set PEXELS_API_KEY.", str(caught.exception))

    def test_run_raises_budget_stop_not_a_return_when_the_ceiling_is_met(self):
        from dataclasses import replace  # noqa: PLC0415
        from modules.credential_health import CredentialCheck  # noqa: PLC0415
        ok = self.health(CredentialCheck("gemini", "ok", required=True))
        ctx = replace(self.ctx, agent=replace(self.ctx.agent, spend_ceiling_usd=1.0))
        status = budget.BudgetStatus("default", 1.0, 2.0, False)
        with mock.patch.object(self.main, "check_run_credentials", return_value=ok), \
                mock.patch.object(self.main, "StateStore"), \
                mock.patch.object(budget, "check_budget", return_value=status), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")):
            with self.assertRaises(budget.BudgetStop):
                self.main.run(channel=ctx, skip_upload=True)


class MainWiring(unittest.TestCase):
    def setUp(self):
        self.src = MAIN.read_text()
        tree = ast.parse(self.src)
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "run")
        self.run_src = ast.get_source_segment(self.src, fn)

    def test_missing_required_credentials_raise_before_the_first_paid_stage(self):
        body = self.run_src
        raised = body.index("raise CredentialsMissing(")
        self.assertGreater(raised, body.index("check_run_credentials(ctx)"))
        self.assertIn("health.blocking", body[body.index("check_run_credentials(ctx)"):raised])
        # Outside the preflight's own try/except, which swallows everything.
        self.assertGreater(raised, body.index('"Credential preflight failed'))
        for paid in ("MediaFetcher(slug)", "mixer.build(script)", "ScriptEngine(", "verify_voice("):
            if paid in body:
                self.assertLess(raised, body.index(paid), f"{paid} runs before the credential stop")

    def test_the_media_check_sits_between_media_generation_and_whisper(self):
        body = self.run_src
        check = body.index("require_media(videos, images")
        self.assertGreater(check, body.index("fetcher.generate_images("))
        self.assertLess(check, body.index("run_checkpoint.record_stage(slug, run_checkpoint.STAGE_MEDIA)"))
        self.assertLess(check, body.index("log_usage(\"before transcription\")"))

    def test_the_budget_stop_raises_and_is_not_swallowed_by_its_own_preflight(self):
        body = self.run_src
        stop = body.index("raise budget.BudgetStop(")
        reraise = body.index("except budget.BudgetStop:\n            raise", stop)
        self.assertLess(reraise, body.index("Budget preflight failed"))
        # The old exit-0 `return None` is gone: it was captured in full.
        self.assertNotIn("return None", body[body.index("events.BUDGET_EXCEEDED"):reraise])


# ── D7: the budget stop is not a success ──────────────────────────────────

class BudgetStopExit(unittest.TestCase):
    def test_main_exits_with_the_code_the_runners_read(self):
        main = MAIN.read_text()
        self.assertIn("except budget.BudgetStop:", main)
        self.assertIn("sys.exit(budget.BUDGET_STOP_EXIT)", main)
        self.assertEqual(budget.BUDGET_STOP_EXIT, 78)
        self.assertEqual(qw.BUDGET_STOP_EXIT, budget.BUDGET_STOP_EXIT)

    def test_the_actions_step_maps_it_to_a_green_released_run(self):
        text = WORKFLOW.read_text()
        self.assertIn(f'if [ "$rc" -eq {budget.BUDGET_STOP_EXIT} ]; then', text)
        step = text[text.index(f'if [ "$rc" -eq {budget.BUDGET_STOP_EXIT} ]; then'):]
        self.assertIn('echo "paused=true" >> "$GITHUB_OUTPUT"', step[:200])


class RunResultFile(unittest.TestCase):
    def test_written_only_when_the_worker_asked_for_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "result.json"
            with mock.patch.dict(os.environ, {run_request.RESULT_FILE_ENV: str(target)}):
                run_checkpoint.write_result("slug-1", Path(tmp) / "final_video.mp4")
            self.assertEqual(json.loads(target.read_text()),
                             {"slug": "slug-1", "video_path": str(Path(tmp) / "final_video.mp4")})
            before = sorted(Path(tmp).iterdir())
            env = {k: v for k, v in os.environ.items() if k != run_request.RESULT_FILE_ENV}
            with mock.patch.dict(os.environ, env, clear=True):
                run_checkpoint.write_result("slug-1", "x.mp4")
            self.assertEqual(sorted(Path(tmp).iterdir()), before)

    def test_it_is_written_right_after_the_render_stage_is_recorded(self):
        src = MAIN.read_text()
        record = src.index("run_checkpoint.record_stage(slug, run_checkpoint.STAGE_RENDER")
        self.assertLess(record, src.index("run_checkpoint.write_result(slug, video_path)"))
        # ...and nothing before the render can have written it.
        self.assertEqual(src.count("run_checkpoint.write_result("), 1)

    def test_an_unwritable_path_never_breaks_the_run(self):
        with mock.patch.dict(os.environ, {run_request.RESULT_FILE_ENV: "/nonexistent-dir/x/r.json"}):
            run_checkpoint.write_result("s", "v.mp4")  # must not raise


# ── D3: a hung run ends the job ───────────────────────────────────────────

FAKE_MAIN = ("import os, sys, time\n"
             "time.sleep(float(os.environ.get('FAKE_SLEEP', '0')))\n"
             "sys.exit(int(os.environ.get('FAKE_RC', '0')))\n")


class FakeQueue:
    def __init__(self, jobs):
        self.jobs, self.ends = list(jobs), []

    def claim(self, worker_id, stale_minutes):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, job_id, worker_id):
        return True  # the heartbeat thread keeps saying "alive" while the child hangs

    def finish(self, job_id, worker_id, status, error):
        self.ends.append((status, error))
        return True

    def release(self, job_id, worker_id, *, status, attempts, error):
        self.ends.append(("released:" + status, error))
        return True


class OperatorCredits:
    def channel_org(self, channel_id):
        return "00000000-0000-0000-0000-000000000001"

    def expire(self):
        return 0


class JobTimeout(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)

    def tearDown(self):
        self.tmp.cleanup()

    def worker(self, queue, env, **kw):
        opts = dict(env=dict({"PATH": os.environ.get("PATH", "")}, **env), repo_dir=self.repo, prelude=[],
                    resolve_channel=lambda cid: {"channel_id": cid, "is_default": False, "is_operators": True,
                                                 "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                    heartbeat_seconds=0.05, poll_seconds=0.01, out=io.StringIO(),
                    credits=OperatorCredits(), kill_after_seconds=2)
        opts.update(kw)
        return qw.Worker(queue, worker_id="w1", **opts)

    def job(self):
        return {"id": 5, "channel_id": "news", "kind": "daily", "params": {}, "attempts": 1,
                "max_attempts": 3, "created_at": "2026-09-25T10:00:00+00:00"}

    def test_a_child_that_never_exits_is_killed_and_the_job_fails(self):
        q = FakeQueue([self.job()])
        started = time.monotonic()
        self.worker(q, {"FAKE_SLEEP": "120"}, job_timeout_seconds=1).run_forever(once=True)
        self.assertLess(time.monotonic() - started, 30)
        (status, error), = q.ends
        self.assertEqual(status, "failed")
        self.assertIn("timed out", error)
        # Shown to the customer: no setting names in it.
        self.assertNotIn("WORKER_JOB_TIMEOUT_SECONDS", error)

    def test_a_run_inside_the_limit_is_untouched(self):
        q = FakeQueue([self.job()])
        self.worker(q, {}, job_timeout_seconds=60).run_forever(once=True)
        self.assertEqual(q.ends, [("succeeded", None)])

    def test_the_prelude_shares_the_same_deadline(self):
        q = FakeQueue([self.job()])
        w = self.worker(q, {}, job_timeout_seconds=1,
                        prelude=[[sys.executable, "-c", "import time; time.sleep(120)"]])
        w.run_forever(once=True)
        self.assertEqual(q.ends[0][0], "failed")
        self.assertIn("timed out", q.ends[0][1])
        self.assertFalse((self.repo / "report.out").exists())

    def test_default_is_55_minutes_and_a_nonsense_value_falls_back_to_it(self):
        self.assertEqual(qw.DEFAULT_JOB_TIMEOUT_SECONDS, 3300)
        for bad in (0, -5, None):
            w = self.worker(FakeQueue([]), {}, job_timeout_seconds=bad)
            self.assertEqual(w.job_timeout_seconds, 3300)

    def test_the_env_var_reaches_the_command_line_default(self):
        with mock.patch.dict(os.environ, {"WORKER_JOB_TIMEOUT_SECONDS": "120",
                                          "SUPABASE_URL": "", "SUPABASE_SERVICE_KEY": ""}):
            self.assertEqual(qw._int_env("WORKER_JOB_TIMEOUT_SECONDS", qw.DEFAULT_JOB_TIMEOUT_SECONDS), 120)
        with mock.patch.dict(os.environ, {"WORKER_JOB_TIMEOUT_SECONDS": ""}):
            self.assertEqual(qw._int_env("WORKER_JOB_TIMEOUT_SECONDS", qw.DEFAULT_JOB_TIMEOUT_SECONDS), 3300)


class TerminateKillsTheWholeGroup(unittest.TestCase):
    def test_a_helper_left_behind_by_a_leader_that_exited_on_sigterm_is_killed(self):
        import signal  # noqa: PLC0415
        import subprocess  # noqa: PLC0415
        w = qw.Worker(FakeQueue([]), worker_id="w1", env={}, repo_dir=ROOT, prelude=[], kill_after_seconds=2)
        # The leader prints its helper's pid and exits at once; the helper (which ignores
        # SIGTERM) stays in its group, so only the SIGKILL after the grace removes it.
        proc = subprocess.Popen(["sh", "-c", "trap '' TERM; sleep 300 & echo $!"], stdout=subprocess.PIPE, text=True,
                                start_new_session=True)
        helper = int(proc.stdout.readline())
        proc.wait()
        os.kill(helper, 0)  # alive
        w._terminate(proc)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(helper, 0)
            except ProcessLookupError:
                return
            try:  # a zombie child of this process still answers kill(0); reap if it is ours
                os.waitpid(helper, os.WNOHANG)
            except ChildProcessError:
                pass
            time.sleep(0.05)
        os.kill(helper, signal.SIGKILL)
        self.fail("the helper in the run's process group survived _terminate")


class JobLimitSettings(unittest.TestCase):
    def main_with(self, value):
        env = {"SUPABASE_URL": "https://example.invalid", "SUPABASE_SERVICE_KEY": "x" * 20,
               "WORKER_JOB_TIMEOUT_SECONDS": value}
        with mock.patch.dict(os.environ, env), mock.patch.object(qw, "Worker") as worker, \
                mock.patch.object(qw.logging, "basicConfig"), mock.patch.object(qw.log_redaction, "install"), \
                self.assertLogs("queue_worker", level="INFO") as logs:
            worker.return_value.run_forever.return_value = 0
            qw.main(["--once"])
        return worker.call_args.kwargs["job_timeout_seconds"], "\n".join(logs.output)

    def test_a_value_under_five_minutes_warns_and_falls_back(self):
        used, log = self.main_with("30")
        self.assertEqual(used, 3300)
        self.assertIn("below the 300s minimum", log)

    def test_a_sane_value_is_used_and_shown_in_the_startup_banner(self):
        used, log = self.main_with("1800")
        self.assertEqual(used, 1800)
        self.assertIn("job limit 1800s", log)


class PipelineCommandTimeout(unittest.TestCase):
    def test_a_pipeline_ffmpeg_command_has_a_wall_clock_limit(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen.update(kw)
            return mock.Mock(returncode=0, stderr="")
        with mock.patch.object(render_backend.subprocess, "run", fake_run):
            render_backend._run(["ffmpeg", "-version"])
        self.assertEqual(seen["timeout"], render_backend.PIPELINE_COMMAND_TIMEOUT_S)
        self.assertLess(render_backend.PIPELINE_COMMAND_TIMEOUT_S, qw.DEFAULT_JOB_TIMEOUT_SECONDS)

    def test_a_command_past_the_limit_is_killed_and_reported_as_a_timeout(self):
        started = time.monotonic()
        with mock.patch.object(render_backend, "PIPELINE_COMMAND_TIMEOUT_S", 1):
            with self.assertRaises(render_backend.RenderTimeout):
                render_backend._run([sys.executable, "-c", "import time; time.sleep(120)"])
        self.assertLess(time.monotonic() - started, 30)


# ── the new env var is allow-listed and wired like its siblings ──────────

class AllowList(unittest.TestCase):
    def test_worker_job_timeout_is_in_the_allow_list_and_the_deploy_mapping(self):
        self.assertIn("WORKER_JOB_TIMEOUT_SECONDS=", WORKER_EXAMPLE.read_text().splitlines())
        self.assertIn("WORKERENV_WORKER_JOB_TIMEOUT_SECONDS: ${{ vars.WORKER_JOB_TIMEOUT_SECONDS }}",
                      DEPLOY_WORKFLOW.read_text())


if __name__ == "__main__":
    unittest.main()
