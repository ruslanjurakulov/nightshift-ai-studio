"""The VPS queue worker (tools/queue_worker.py) and its run mapping
(modules/run_request.py).

What would break without these:

* a queued job running a DIFFERENT command than the workflow — a looser
  privacy, a provider switched on, a repair that is not a repair;
* a job for one channel seeing another channel's YouTube token;
* a secret landing in render_jobs.error, which the dashboard shows;
* a docker stop losing a job, or a re-queued job paying for its script again.
"""

from __future__ import annotations

import io
import json
import os
import re
import signal
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import run_request  # noqa: E402
from modules.run_request import InvalidRunRequest  # noqa: E402
from tools import queue_worker as qw  # noqa: E402

WORKFLOW = ROOT / ".github" / "workflows" / "daily_video.yml"


# ── mapping ─────────────────────────────────────────────────────────────────

class ParamsToArgs(unittest.TestCase):
    def test_plain_run_is_the_scheduled_run(self):
        argv, env, clean = run_request.plan_run("default", "daily", {}, {})
        self.assertEqual(argv, ["--channel", "default", "--privacy", "private"])
        self.assertEqual(env["YOUTUBE_PRIVACY"], "private")
        self.assertEqual(env["SCRIPT_LANGUAGE"], "English")
        self.assertNotIn("CHRONOS_ENABLE_VIDEO_GEN", env)
        self.assertEqual(clean, {})

    def test_every_input_maps_to_its_flag_in_workflow_order(self):
        params = {"topic": " Rome ", "niche": "history", "duration": 300, "language": "Arabic",
                  "visual_style": "noir", "privacy": "unlisted", "resume": True}
        argv = run_request.build_main_args("news", run_request.validate("news", "daily", params))
        self.assertEqual(argv, ["--channel", "news", "--privacy", "unlisted", "--topic", "Rome",
                                "--niche", "history", "--duration", "300", "--language", "Arabic",
                                "--visual-style", "noir", "--resume"])

    def test_repair_job(self):
        argv, _, _ = run_request.plan_run("news", "repair", {"repair_scenes": "3,17"}, {})
        self.assertEqual(argv[-2:], ["--repair-scenes", "3,17"])

    def test_empty_values_are_the_channel_default_not_a_flag(self):
        argv, _, _ = run_request.plan_run("news", "daily", {"topic": "  ", "video_provider": ""}, {})
        self.assertEqual(argv, ["--channel", "news", "--privacy", "private"])

    def test_video_provider_turns_generation_on_for_this_run_only(self):
        base = {"CHRONOS_VIDEO_PROVIDER": "minimax", "CHRONOS_ENABLE_VIDEO_GEN": ""}
        _, env, _ = run_request.plan_run("news", "daily", {"video_provider": "kling"}, base)
        self.assertEqual((env["CHRONOS_VIDEO_PROVIDER"], env["CHRONOS_ENABLE_VIDEO_GEN"]), ("kling", "true"))
        _, env, _ = run_request.plan_run("news", "daily", {}, base)
        self.assertEqual((env["CHRONOS_VIDEO_PROVIDER"], env["CHRONOS_ENABLE_VIDEO_GEN"]), ("minimax", ""))

    def test_pexels_does_not_turn_image_generation_on(self):
        base = {"CHRONOS_ENABLE_IMAGE_GEN": "false"}
        _, env, _ = run_request.plan_run("news", "daily", {"image_provider": "pexels"}, base)
        self.assertEqual((env["CHRONOS_IMAGE_PROVIDER"], env["CHRONOS_ENABLE_IMAGE_GEN"]), ("pexels", "false"))
        _, env, _ = run_request.plan_run("news", "daily", {"image_provider": "leonardo"}, base)
        self.assertEqual(env["CHRONOS_ENABLE_IMAGE_GEN"], "true")

    def test_privacy_is_never_opened_by_default(self):
        _, env, _ = run_request.plan_run("news", "daily", {"privacy": None}, {"YOUTUBE_PRIVACY": "public"})
        self.assertEqual(env["YOUTUBE_PRIVACY"], "private")

    def test_rejects_what_the_workflow_would_not_accept(self):
        bad = [
            ("daily", {"no_upload": True}),                 # not an input — no bypass flags
            ("daily", {"privacy": "everyone"}),
            ("daily", {"video_provider": "sora"}),
            ("daily", {"duration": 5}),
            ("daily", {"duration": "300"}),
            ("daily", {"duration": True}),
            ("daily", {"topic": "x" * 301}),
            ("daily", {"resume": "yes"}),
            ("daily", {"repair_scenes": "3"}),               # repair only as a repair job
            ("repair", {}),
            ("repair", {"repair_scenes": "3", "resume": True}),
            ("repair", {"repair_scenes": "3;rm -rf"}),
            ("render", {}),
        ]
        for kind, params in bad:
            with self.subTest(kind=kind, params=params):
                with self.assertRaises(InvalidRunRequest):
                    run_request.validate("news", kind, params)
        for channel in ("", "News", "../x", "a" * 65):
            with self.subTest(channel=channel), self.assertRaises(InvalidRunRequest):
                run_request.validate(channel, "daily", {})


class WorkflowParity(unittest.TestCase):
    """The workflow is the reference. If it grows a flag or changes a
    derivation, this fails until run_request mirrors it."""

    @classmethod
    def setUpClass(cls):
        wf = yaml.safe_load(WORKFLOW.read_text())
        cls.inputs = wf[True]["workflow_dispatch"]["inputs"]
        steps = wf["jobs"]["make-video"]["steps"]
        cls.run_step = next(s for s in steps if s.get("name") == "Run Chronos bot")

    def test_whitelist_is_the_workflow_inputs(self):
        self.assertEqual(set(self.inputs) - {"channel"}, set(run_request.ALLOWED_PARAMS))

    def test_choice_lists_match(self):
        self.assertEqual(tuple(self.inputs["privacy"]["options"]), run_request.PRIVACY_CHOICES)
        self.assertEqual(tuple(o for o in self.inputs["video_provider"]["options"] if o),
                         run_request.VIDEO_PROVIDERS)
        self.assertEqual(tuple(o for o in self.inputs["image_provider"]["options"] if o),
                         run_request.IMAGE_PROVIDERS)
        self.assertEqual(self.inputs["privacy"]["default"], "private")

    def test_every_flag_the_run_step_appends_is_mapped(self):
        script = self.run_step["run"]
        flags = re.findall(r'args\+=\((--[a-z-]+)(?: "\$\{?(INPUT_[A-Z_]+))?', script)
        self.assertGreaterEqual(len(flags), 7)
        full = {"topic": "t", "niche": "n", "duration": 60, "language": "L", "visual_style": "v",
                "resume": True}
        argv = run_request.build_main_args("c", full)
        argv_repair = run_request.build_main_args("c", {"repair_scenes": "3"})
        for flag, env_name in flags:
            with self.subTest(flag=flag):
                self.assertIn(flag, argv + argv_repair)
                if env_name:
                    param = env_name[len("INPUT_"):].lower()
                    self.assertIn(param, run_request.ALLOWED_PARAMS)
        self.assertIn('args=(--channel "$CHANNEL_ID" --privacy "${YOUTUBE_PRIVACY:-private}")', script)
        self.assertIn('"${INPUT_RESUME:-}" = "true"', script)

    def test_env_derivations_are_the_ones_mirrored(self):
        env = self.run_step["env"]
        self.assertEqual(env["YOUTUBE_PRIVACY"], "${{ github.event.inputs.privacy || 'private' }}")
        self.assertEqual(env["SCRIPT_LANGUAGE"], "English")
        self.assertEqual(env["CHRONOS_VIDEO_PROVIDER"],
                         "${{ github.event.inputs.video_provider || vars.CHRONOS_VIDEO_PROVIDER }}")
        self.assertEqual(env["CHRONOS_ENABLE_VIDEO_GEN"],
                         "${{ github.event.inputs.video_provider != '' && 'true' || vars.CHRONOS_ENABLE_VIDEO_GEN }}")
        self.assertEqual(env["CHRONOS_IMAGE_PROVIDER"],
                         "${{ github.event.inputs.image_provider || vars.CHRONOS_IMAGE_PROVIDER }}")
        self.assertEqual(env["CHRONOS_ENABLE_IMAGE_GEN"],
                         "${{ github.event.inputs.image_provider != '' && github.event.inputs.image_provider "
                         "!= 'pexels' && 'true' || vars.CHRONOS_ENABLE_IMAGE_GEN }}")

    def test_migration_whitelist_matches(self):
        sql = (ROOT / "supabase" / "migrations" / "0017_render_jobs.sql").read_text()
        m = re.search(r"allowed text\[\] := array\[(.*?)\];", sql, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", m.group(1))), set(run_request.ALLOWED_PARAMS))


# ── scrubbing ──────────────────────────────────────────────────────────────

class Scrubbing(unittest.TestCase):
    ENV = {
        "GEMINI_API_KEY": "AIzaSyD-very-secret-value",
        "CHRONOS_YT_TOKEN_NEWS": json.dumps({"refresh_token": "rt-abcdefghijkl", "client_id": "cid-123456789"}),
        "SUPABASE_URL": "https://abcdxyz.supabase.co",
        "YOUTUBE_CHANNEL_ID": "UCnotasecret",
        "SHORT_KEY": "abc",
        "PATH": "/usr/local/bin:/usr/bin",
    }

    def test_values_and_json_leaves_are_removed(self):
        secrets = qw.secret_values(self.ENV)
        text = ("boom with AIzaSyD-very-secret-value and rt-abcdefghijkl at "
                "https://abcdxyz.supabase.co/rest; channel UCnotasecret")
        out = qw.scrub(text, secrets)
        for s in ("AIzaSyD-very-secret-value", "rt-abcdefghijkl", "abcdxyz.supabase.co"):
            self.assertNotIn(s, out)
        self.assertIn("UCnotasecret", out)
        self.assertNotIn("/usr/local/bin", secrets)
        self.assertNotIn("abc", secrets)

    def test_token_shapes_are_removed_even_when_not_in_env(self):
        out = qw.scrub("Authorization: Bearer abcdef1234567890 sk-abcdefghijklmnop "
                       "ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxx", [])
        self.assertNotIn("abcdef1234567890", out)
        self.assertNotIn("sk-abcdefghijklmnop", out)
        self.assertNotIn("ya29.", out)

    def test_error_is_truncated_from_the_front_and_scrubbed_first(self):
        secret = "S" * 40
        tail = ["line %d" % i for i in range(500)] + [f"final error with {secret}"]
        err = qw.format_error("main.py exited with code 1", tail, [secret])
        self.assertLessEqual(len(err), qw.MAX_ERROR_CHARS)
        self.assertTrue(err.startswith("main.py exited with code 1\n…"))
        self.assertTrue(err.endswith("final error with [redacted]"))
        self.assertNotIn("SSSSSSSS", err)


# ── the worker, with a fake queue and a fake main.py ───────────────────────

FAKE_MAIN = textwrap.dedent("""
    import json, os, sys, time
    report = {"argv": sys.argv[1:], "tokens": sorted(k for k in os.environ if k.startswith("CHRONOS_YT_TOKEN_")),
              "has_token_json": "YOUTUBE_TOKEN_JSON" in os.environ,
              "privacy": os.environ.get("YOUTUBE_PRIVACY"),
              "files": sorted(p for p in os.listdir(".") if p.endswith(".json"))}
    with open("report.out", "w") as fh:
        json.dump(report, fh)
    print("running with key " + os.environ.get("GEMINI_API_KEY", ""), flush=True)
    time.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
    sys.exit(int(os.environ.get("FAKE_RC", "0")))
""")


class FakeQueue:
    def __init__(self, jobs=()):
        self.jobs = list(jobs)
        self.calls = []
        self.heartbeat_answer = True
        self.lock = threading.Lock()

    def claim(self, worker_id, stale_minutes):
        with self.lock:
            self.calls.append(("claim", worker_id))
            return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, job_id, worker_id):
        with self.lock:
            self.calls.append(("heartbeat", job_id))
        return self.heartbeat_answer

    def finish(self, job_id, worker_id, status, error):
        self.calls.append(("finish", job_id, status, error))
        return True

    def release(self, job_id, worker_id, *, status, attempts, error):
        self.calls.append(("release", job_id, status, attempts, error))
        return True

    def ends(self):
        return [c for c in self.calls if c[0] in ("finish", "release")]


def job(**kw):
    base = {"id": 7, "channel_id": "news", "kind": "daily", "params": {}, "attempts": 1,
            "max_attempts": 3, "created_at": "2026-09-25T10:00:00+00:00"}
    base.update(kw)
    return base


class WorkerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {
            "PATH": os.environ.get("PATH", ""),
            "GEMINI_API_KEY": "gemini-secret-value-123",
            "YOUTUBE_TOKEN_JSON": json.dumps({"refresh_token": "default-refresh-token"}),
            "YOUTUBE_CLIENT_SECRET_JSON": json.dumps({"installed": {"client_secret": "cs-123456789"}}),
            "CHRONOS_YT_TOKEN_NEWS": json.dumps({"refresh_token": "news-refresh-token"}),
            "CHRONOS_YT_TOKEN_FINANCE": json.dumps({"refresh_token": "finance-refresh-token"}),
        }
        self.rows = {
            "news": {"channel_id": "news", "is_default": False, "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
            "default": {"channel_id": "default", "is_default": True, "token_secret": "CHRONOS_YT_TOKEN_DEFAULT"},
        }
        self.out = io.StringIO()

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, cid):
        if cid == "draft":
            raise ValueError("channel 'draft' has never been confirmed against YouTube.")
        return self.rows[cid]

    def worker(self, queue, **kw):
        opts = dict(env=self.env, repo_dir=self.repo, prelude=[], resolve_channel=self.resolve,
                    heartbeat_seconds=0.05, poll_seconds=0.01, grace_seconds=60,
                    kill_after_seconds=2, out=self.out)
        opts.update(kw)
        return qw.Worker(queue, worker_id="w1", **opts)

    def report(self):
        return json.loads((self.repo / "report.out").read_text())

    # -- happy path and failure -------------------------------------------

    def test_success_runs_the_mapped_command_and_marks_succeeded(self):
        q = FakeQueue([job(params={"topic": "Rome", "duration": 300})])
        self.assertEqual(self.worker(q).run_forever(once=True), 0)
        self.assertEqual(q.ends(), [("finish", 7, "succeeded", None)])
        r = self.report()
        self.assertEqual(r["argv"], ["--channel", "news", "--privacy", "private", "--topic", "Rome",
                                     "--duration", "300"])
        self.assertEqual(r["privacy"], "private")

    def test_output_is_streamed_scrubbed(self):
        q = FakeQueue([job()])
        self.worker(q).run_forever(once=True)
        self.assertIn("running with key [redacted]", self.out.getvalue())
        self.assertNotIn("gemini-secret-value-123", self.out.getvalue())

    def test_nonzero_exit_is_failed_with_scrubbed_tail(self):
        self.env["FAKE_RC"] = "3"
        q = FakeQueue([job()])
        self.worker(q).run_forever(once=True)
        (_, _, status, error), = q.ends()
        self.assertEqual(status, "failed")
        self.assertTrue(error.startswith("main.py exited with code 3"))
        self.assertIn("running with key [redacted]", error)
        self.assertNotIn("gemini-secret-value-123", error)

    def test_invalid_job_fails_without_running_anything(self):
        q = FakeQueue([job(params={"no_upload": True})])
        self.worker(q).run_forever(once=True)
        (_, _, status, error), = q.ends()
        self.assertEqual(status, "failed")
        self.assertIn("invalid job", error)
        self.assertFalse((self.repo / "report.out").exists())

    def test_unverified_channel_is_refused_like_the_workflow(self):
        q = FakeQueue([job(channel_id="draft")])
        self.worker(q).run_forever(once=True)
        (_, _, status, error), = q.ends()
        self.assertEqual(status, "failed")
        self.assertIn("never been confirmed", error)
        self.assertFalse((self.repo / "report.out").exists())

    def test_once_with_empty_queue_exits(self):
        q = FakeQueue([])
        self.assertEqual(self.worker(q).run_forever(once=True), 0)
        self.assertEqual(q.ends(), [])

    def test_heartbeats_while_running(self):
        self.env["FAKE_SLEEP"] = "0.4"
        q = FakeQueue([job()])
        self.worker(q).run_forever(once=True)
        self.assertGreaterEqual(sum(1 for c in q.calls if c[0] == "heartbeat"), 2)

    def test_lost_ownership_stops_the_run_and_does_not_finish_it(self):
        self.env["FAKE_SLEEP"] = "30"
        q = FakeQueue([job()])
        q.heartbeat_answer = False
        started = time.monotonic()
        self.assertEqual(self.worker(q).process(q.claim("w1", 10)), "lost")
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(q.ends(), [])

    # -- credentials ------------------------------------------------------

    def test_only_this_channels_token_reaches_the_run_and_files_are_removed(self):
        q = FakeQueue([job()])
        self.worker(q).run_forever(once=True)
        r = self.report()
        self.assertEqual(r["tokens"], ["CHRONOS_YT_TOKEN_NEWS"])
        self.assertFalse(r["has_token_json"])
        self.assertEqual(r["files"], ["client_secret.json"])   # no default token for another channel
        self.assertFalse((self.repo / "client_secret.json").exists())
        self.assertFalse(list(self.repo.glob("youtube_token*.json")))

    def test_default_channel_gets_its_token_file_and_no_channel_tokens(self):
        q = FakeQueue([job(channel_id="default")])
        self.worker(q).run_forever(once=True)
        r = self.report()
        self.assertEqual(r["tokens"], [])
        self.assertIn("youtube_token.json", r["files"])
        self.assertFalse((self.repo / "youtube_token.json").exists())

    def test_worker_log_never_names_a_value(self):
        with self.assertLogs("queue_worker", level="INFO") as logs:
            self.worker(FakeQueue([job()])).run_forever(once=True)
        joined = "\n".join(logs.output)
        for value in ("news-refresh-token", "finance-refresh-token", "cs-123456789", "bytes"):
            self.assertNotIn(value, joined)

    # -- SIGTERM ----------------------------------------------------------

    def test_stop_before_the_run_releases_and_gives_the_attempt_back(self):
        q = FakeQueue([job()])
        w = self.worker(q)
        w.request_stop()
        self.assertEqual(w.process(q.claim("w1", 10)), "released")
        (_, _, status, attempts, _), = q.ends()
        self.assertEqual((status, attempts), ("queued", 0))
        self.assertFalse((self.repo / "report.out").exists())

    def test_stop_mid_run_finishes_within_grace(self):
        self.env["FAKE_SLEEP"] = "0.5"
        q = FakeQueue([job()])
        w = self.worker(q, grace_seconds=30)
        threading.Timer(0.2, w.request_stop).start()
        self.assertEqual(w.run_forever(), 0)
        self.assertEqual(q.ends(), [("finish", 7, "succeeded", None)])
        self.assertEqual(sum(1 for c in q.calls if c[0] == "claim"), 1)   # nothing new claimed

    def test_stop_mid_run_past_grace_terminates_and_requeues(self):
        self.env["FAKE_SLEEP"] = "30"
        q = FakeQueue([job(attempts=1)])
        w = self.worker(q, grace_seconds=0)
        threading.Timer(0.3, w.request_stop).start()
        started = time.monotonic()
        self.assertEqual(w.run_forever(), 0)
        self.assertLess(time.monotonic() - started, 15)
        (_, _, status, attempts, error), = q.ends()
        self.assertEqual((status, attempts), ("queued", 1))
        self.assertIn("SIGTERM", error)

    def test_second_signal_forces_and_last_attempt_fails(self):
        self.env["FAKE_SLEEP"] = "30"
        q = FakeQueue([job(attempts=3, max_attempts=3)])
        w = self.worker(q, grace_seconds=3600)
        threading.Timer(0.2, w.request_stop).start()
        threading.Timer(0.4, w.request_stop).start()
        w.run_forever()
        (_, _, status, _, error), = q.ends()
        self.assertEqual(status, "failed")
        self.assertIn("last of 3", error)

    def test_real_sigterm_is_handled(self):
        self.env["FAKE_SLEEP"] = "30"
        q = FakeQueue([job()])
        w = self.worker(q, grace_seconds=0)
        old = signal.getsignal(signal.SIGTERM)
        try:
            w.install_signal_handlers()
            threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
            w.run_forever()
        finally:
            signal.signal(signal.SIGTERM, old)
            signal.signal(signal.SIGINT, signal.default_int_handler)
        self.assertEqual(q.ends()[0][2], "queued")

    # -- resume on re-queue -----------------------------------------------

    def checkpoint(self, slug, *, channel="news", topic=None, created="2026-09-25T10:05:00+00:00",
                   completed=False, script=True):
        d = self.repo / "output" / slug
        d.mkdir(parents=True, exist_ok=True)
        stages = {}
        if script:
            (d / "script.json").write_text("{}")
            stages["script"] = {"at": created, "artifacts": {"script_json": str(d / "script.json")}}
        (d / "checkpoint.json").write_text(json.dumps({
            "slug": slug, "topic": topic if topic is not None else slug.replace("-", " "),
            "channel_id": channel, "created_at": created, "updated_at": created,
            "completed": completed, "stages": stages}))

    def run_requeued(self, **kw):
        q = FakeQueue([job(attempts=2, **kw)])
        self.worker(q).run_forever(once=True)
        return self.report()["argv"]

    def test_requeued_job_with_its_checkpoint_resumes_that_run(self):
        self.checkpoint("fall-of-rome", topic="Fall of Rome")
        self.assertEqual(self.run_requeued()[-3:], ["--topic", "Fall of Rome", "--resume"])

    def test_requeued_job_with_a_topic_resumes_only_that_topics_run(self):
        self.checkpoint("fall-of-rome", topic="Fall of Rome")
        self.checkpoint("other-run", topic="Other run", created="2026-09-25T10:09:00+00:00")
        argv = self.run_requeued(params={"topic": "Fall of Rome"})
        self.assertEqual(argv, ["--channel", "news", "--privacy", "private", "--topic", "Fall of Rome",
                                "--resume"])

    def test_no_resume_when_the_checkpoint_is_not_this_jobs(self):
        cases = {
            "another channel": dict(channel="finance"),
            "older than the job": dict(created="2026-09-25T09:00:00+00:00"),
            "already finished": dict(completed=True),
            "script gone": dict(script=False),
        }
        for why, kw in cases.items():
            with self.subTest(why):
                self.checkpoint("fall-of-rome", topic="Fall of Rome", **kw)
                self.assertNotIn("--resume", self.run_requeued())

    def test_first_attempt_never_resumes(self):
        self.checkpoint("fall-of-rome", topic="Fall of Rome")
        q = FakeQueue([job(attempts=1)])
        self.worker(q).run_forever(once=True)
        self.assertNotIn("--resume", self.report()["argv"])


class QueueClientFilters(unittest.TestCase):
    """Every write is scoped to a job this worker holds, so a late write after a
    re-queue or cancel matches nothing."""

    class Resp:
        def __init__(self, status=200, body=None):
            self.status_code, self._body = status, body

        def json(self):
            return self._body

    class Session:
        def __init__(self, resp):
            self.resp, self.calls = resp, []

        def post(self, url, **kw):
            self.calls.append(("post", url, kw))
            return self.resp

        def patch(self, url, **kw):
            self.calls.append(("patch", url, kw))
            return self.resp

    def test_writes_are_scoped_and_empty_result_means_not_ours(self):
        s = self.Session(self.Resp(200, []))
        c = qw.QueueClient("https://x.supabase.co", "svc", session=s)
        self.assertIs(c.heartbeat(5, "w1"), False)
        _, url, kw = s.calls[-1]
        self.assertTrue(url.endswith("/rest/v1/render_jobs"))
        self.assertEqual(kw["params"]["worker_id"], "eq.w1")
        self.assertEqual(kw["params"]["status"], "eq.running")
        self.assertEqual(kw["params"]["id"], "eq.5")

    def test_claim_calls_the_rpc(self):
        s = self.Session(self.Resp(200, [{"id": 1}]))
        c = qw.QueueClient("https://x.supabase.co/", "svc", session=s)
        self.assertEqual(c.claim("w1", 10), {"id": 1})
        _, url, kw = s.calls[-1]
        self.assertEqual(url, "https://x.supabase.co/rest/v1/rpc/claim_render_job")
        self.assertEqual(kw["json"], {"p_worker": "w1", "p_stale_after": "10 minutes"})

    def test_http_error_is_unknown_not_lost(self):
        c = qw.QueueClient("https://x", "svc", session=self.Session(self.Resp(500, {"message": "x"})))
        self.assertIsNone(c.heartbeat(5, "w1"))
        self.assertIsNone(c.claim("w1", 10))


class MissingConfig(unittest.TestCase):
    def test_exits_with_the_remedy_when_supabase_is_not_set(self):
        saved = {k: os.environ.pop(k, None) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")}
        try:
            self.assertEqual(qw.main(["--once"]), 2)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v


if __name__ == "__main__":
    unittest.main()
