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

from modules import budget, media_fetcher, render_backend, run_checkpoint, run_request  # noqa: E402
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
        check = body.index("require_media(videos, images)")
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
        self.assertIn("WORKER_JOB_TIMEOUT_SECONDS", error)

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
