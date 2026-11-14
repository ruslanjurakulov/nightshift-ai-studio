"""A credential preflight stop is named, not ``unknown`` (2026-11-14, render_jobs id 7).

What broke: main.py stopped a run before spending anything because Google had revoked channel ``default``'s
YouTube refresh token (invalid_grant), and its message said exactly that and named the fix. It left as a traceback
with exit 1, so the queue worker could only call it ``[code:unknown]``, and the MCP's get_job_status told the
customer "Something went wrong and the video was not made" (CLAUDE.md rule 6: name the remedy, not the symptom).

What these pin:

* the stop leaves main.py as its own exit code: 85 when the only problem is the YouTube token (the customer
  reconnects), 84 for any other required key (the operator sets it);
* the worker turns that code into ``channel_reconnect_required`` / ``credentials_missing``, fails the job and does
  NOT charge it (the hold is released, as for every other stop before spending);
* the code survives into the customer's sentence and that sentence names the fix;
* no token text reaches the stored error.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credential_health as ch  # noqa: E402
from modules import render_error  # noqa: E402
from modules.credential_health import CredentialCheck, CredentialsMissing, HealthReport  # noqa: E402

#: The detail credential_health writes for a dead token (its own fixed words), as job 7 stored it.
DEAD_DETAIL = ch._DEAD_DETAIL["invalid_grant"].format(channel="default")


def import_main(case: unittest.TestCase):
    """main.py, or a skip where its render stack (moviepy) is not installed; CI installs it."""
    try:
        import main  # noqa: PLC0415
    except Exception as e:  # pragma: no cover - environment without the render stack
        case.skipTest(f"main.py cannot be imported here ({type(e).__name__})")
    return main


def run_main_block(case, run_side_effect, argv=("main.py", "--no-upload")):
    """Execute the real ``if __name__ == "__main__":`` block of main.py with ``run`` replaced."""
    main = import_main(case)

    source = (ROOT / "main.py").read_text()
    tail = source[source.index('if __name__ == "__main__":'):]
    namespace = dict(vars(main), __name__="__main__", run=MagicMock(side_effect=run_side_effect))
    out, err = io.StringIO(), io.StringIO()
    with patch.object(sys, "argv", list(argv)), redirect_stdout(out), redirect_stderr(err):
        try:
            exec(compile(tail, str(ROOT / "main.py"), "exec"), namespace)
        except SystemExit as exit_:
            return exit_.code, out.getvalue() + err.getvalue()
    return None, out.getvalue() + err.getvalue()


class TheExitCodeIsChosenByWhatIsMissing(unittest.TestCase):
    def test_the_codes_are_free_and_do_not_clash_with_any_documented_exit(self):
        from modules import budget, gemini_stages, publish_gate, series, storyboard_review, voice_gate

        taken = {0, 1, 2, 3, 4, 254, storyboard_review.PAUSED_EXIT, budget.BUDGET_STOP_EXIT,
                 publish_gate.HELD_BEFORE_RENDER_EXIT, gemini_stages.GEMINI_QUOTA_EXIT,
                 series.SERIES_NOT_RUNNABLE_EXIT, voice_gate.VOICE_GATE_EXIT, voice_gate.VOICE_GATE_UNAVAILABLE_EXIT}
        self.assertEqual((ch.CREDENTIALS_MISSING_EXIT, ch.RECONNECT_REQUIRED_EXIT), (84, 85))
        self.assertFalse({ch.CREDENTIALS_MISSING_EXIT, ch.RECONNECT_REQUIRED_EXIT} & taken)

    def test_a_dead_youtube_token_alone_is_the_reconnect_exit(self):
        self.assertEqual(CredentialsMissing("x", names=["youtube_token_live"]).exit_code, 85)

    def test_any_other_missing_key_is_the_credentials_exit(self):
        self.assertEqual(CredentialsMissing("x", names=["pexels"]).exit_code, 84)

    def test_a_dead_token_beside_a_missing_platform_key_is_not_called_a_reconnect(self):
        # Reconnecting alone would not let this run start: the operator's key comes first.
        self.assertEqual(CredentialsMissing("x", names=["gemini", "youtube_token_live"]).exit_code, 84)

    def test_a_stop_that_names_nothing_is_never_guessed_to_be_youtube(self):
        self.assertEqual(CredentialsMissing("x").exit_code, 84)


class MainExitsWithTheCodeAndNoTraceback(unittest.TestCase):
    def test_the_reconnect_stop_exits_85_with_the_remedy_in_one_line(self):
        code, output = run_main_block(self, CredentialsMissing(
            f"Run stopped before spending anything: youtube_token_live: {DEAD_DETAIL}", names=["youtube_token_live"]))
        self.assertEqual(code, 85)
        self.assertNotIn("Traceback", output)

    def test_the_credentials_stop_exits_84(self):
        code, _ = run_main_block(self, CredentialsMissing("pexels: Set PEXELS_API_KEY.", names=["pexels"]))
        self.assertEqual(code, 84)

    def test_run_passes_the_blocking_names_to_the_stop(self):
        main_src = (ROOT / "main.py").read_text()
        raised = main_src[main_src.index("raise CredentialsMissing("):]
        self.assertIn("names=[c.name for c in health.blocking]", raised[:400])

    def test_run_raises_it_with_the_youtube_name_when_google_refused_the_token(self):
        main = import_main(self)
        from modules.channels import ChannelContext

        ctx = ChannelContext(channel_id="default", name="X", niche="h")
        cwd, tmp = os.getcwd(), tempfile.TemporaryDirectory()
        os.chdir(tmp.name)  # run() makes ./logs
        self.addCleanup(tmp.cleanup)
        self.addCleanup(os.chdir, cwd)
        dead = HealthReport("default", (CredentialCheck("gemini", "ok", required=True),
                                        CredentialCheck("youtube_token_live", "missing", required=True,
                                                        detail=DEAD_DETAIL)))
        with patch.object(main, "check_run_credentials", return_value=dead), \
                patch.object(main, "MediaFetcher", side_effect=AssertionError("fetched")), \
                patch.object(main, "StateStore", side_effect=AssertionError("budget read")), \
                patch.object(main.disk_guard, "free_bytes", lambda _p: 100 * 1024 ** 3):
            with self.assertRaises(CredentialsMissing) as caught:
                main.run(channel=ctx, skip_upload=True)
        self.assertEqual(caught.exception.exit_code, 85)


class TheWorkerNamesTheFailure(unittest.TestCase):
    def test_the_header_codes_are_the_two_new_codes_and_nothing_near_them(self):
        self.assertEqual(render_error.classify("main.py exited with code 85: x", []),
                         render_error.CHANNEL_RECONNECT_REQUIRED)
        self.assertEqual(render_error.classify("main.py exited with code 84: x", []), render_error.CREDENTIALS_MISSING)
        for header in ("main.py exited with code 850: x", "main.py exited with code 8: x", "main.py exited with code 1"):
            self.assertEqual(render_error.classify(header, []), render_error.UNKNOWN, header)

    def test_job_7s_traceback_is_no_longer_unknown(self):
        # An older main.py (or a run without __main__'s handler) still leaves this traceback: the class names it.
        tail = ["ERROR [channel: default] Credential preflight — MISSING required: youtube_token_live",
                "Traceback (most recent call last):",
                '  File "main.py", line 947, in run',
                f"modules.credential_health.CredentialsMissing: Run stopped before spending anything: {DEAD_DETAIL}"]
        self.assertEqual(render_error.classify("main.py exited with code 1", tail), render_error.CREDENTIALS_MISSING)

    def test_both_branches_fail_the_job_without_charging_it(self):
        src = (ROOT / "tools" / "queue_worker.py").read_text()
        for exit_name, words in (("RECONNECT_REQUIRED_EXIT", "must be reconnected"),
                                 ("CREDENTIALS_MISSING_EXIT", "not configured")):
            start = src.index(f"if rc == {exit_name}:")
            branch = src[start:src.index("if rc ==", start + 10)]
            self.assertIn('return end("failed"', branch, exit_name)
            self.assertNotIn("charge=True", branch, exit_name)
            self.assertIn("nothing was charged", branch, exit_name)
            self.assertIn(words, branch, exit_name)

    def test_the_actions_step_stays_red_with_the_remedy(self):
        flow = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        for rc, words in ((85, "Reconnect"), (84, "not configured")):
            marker = f'if [ "$rc" -eq {rc} ]; then'
            self.assertIn(marker, flow)
            block = flow[flow.index(marker):flow.index("\n          fi", flow.index(marker))]
            self.assertIn("::error", block)
            self.assertIn(words, block)
            self.assertNotIn("paused=true", block)


class AFakeRunThroughTheRealWorker(unittest.TestCase):
    """The worker's real _execute, with a main.py that logs like job 7 and exits 85."""

    SECRET = "1//0g-refresh-token-value-ABCDEF123456"

    def setUp(self):
        from tests.test_queue_worker import FakeQueue, OperatorCredits, job  # noqa: PLC0415
        from tools import queue_worker as qw  # noqa: PLC0415

        self.qw, self.FakeQueue, self.job, self.credits = qw, FakeQueue, job, OperatorCredits()
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(
            "import os, sys\n"
            "print('ERROR [channel: news] Credential preflight — MISSING required: youtube_token_live', flush=True)\n"
            # A run that echoed its token by mistake: the scrubber must still catch it.
            "print('debug token ' + os.environ.get('CHRONOS_YT_TOKEN_NEWS', ''), flush=True)\n"
            f"print('ERROR Credential preflight stopped the run: youtube_token_live: ' + {DEAD_DETAIL!r}, flush=True)\n"
            "sys.exit(int(os.environ.get('FAKE_RC', '85')))\n")
        self.env = {"PATH": os.environ.get("PATH", ""),
                    "CHRONOS_YT_TOKEN_NEWS": json.dumps({"refresh_token": self.SECRET})}
        self.rows = {"news": {"channel_id": "news", "is_default": False, "is_operators": True,
                              "token_secret": "CHRONOS_YT_TOKEN_NEWS"}}

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, rc: str, **job_kw):
        self.env["FAKE_RC"] = rc
        q = self.FakeQueue([self.job(**job_kw)])
        settled = []
        w = self.qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                           resolve_channel=self.rows.__getitem__, heartbeat_seconds=0.05, poll_seconds=0.01,
                           grace_seconds=60, kill_after_seconds=2, out=io.StringIO(), credits=self.credits)
        original = w._execute

        def spy(job, argv, run_env, channel_row, settle=None, video_check=None):
            # Record how the hold is settled: charge=False is a release.
            return original(job, argv, run_env, channel_row,
                            settle=lambda charge: settled.append(charge), video_check=video_check)

        w._execute = spy
        w.run_forever(once=True)
        (_, _, status, error), = q.ends()
        return status, error, settled

    def test_exit_85_is_a_failed_job_coded_reconnect_with_the_hold_released(self):
        status, error, settled = self.run_job("85")
        self.assertEqual(status, "failed")
        self.assertTrue(error.startswith("[code:channel_reconnect_required] main.py exited with code 85: "), error[:120])
        self.assertIn("nothing was charged", error.splitlines()[0])
        self.assertEqual(settled, [False], "the stop before spending must release the hold, never capture it")

    def test_exit_84_is_coded_credentials_missing(self):
        status, error, settled = self.run_job("84")
        self.assertEqual(status, "failed")
        self.assertTrue(error.startswith("[code:credentials_missing] main.py exited with code 84: "), error[:120])
        self.assertEqual(settled, [False])

    def test_no_token_text_reaches_the_stored_error(self):
        _, error, _ = self.run_job("85")
        self.assertNotIn(self.SECRET, error)
        self.assertNotIn("refresh_token", error)
        # The remedy the operator reads survives the scrub.
        self.assertIn("Reconnect", error)


class TheCustomersSentenceNamesTheFix(unittest.TestCase):
    """The sentence the API, the MCP and the Create page show for each code (lib/i18n/*.ts jobError)."""

    def sentences(self, lang):
        text = (ROOT / "command-center" / "lib" / "i18n" / f"{lang}.ts").read_text(encoding="utf-8")
        block = re.search(r"jobError: \{(.*?)\n    \},", text, re.S).group(1)
        return dict(re.findall(r'(\w+): "([^"]*)",', block))

    def test_every_language_has_both_codes(self):
        for lang in ("en", "ru", "uz"):
            s = self.sentences(lang)
            for c in (render_error.CHANNEL_RECONNECT_REQUIRED, render_error.CREDENTIALS_MISSING):
                self.assertIn(c, s, f"{lang}: {c}")

    def test_the_reconnect_sentence_names_the_fix_and_that_nothing_was_charged(self):
        s = self.sentences("en")[render_error.CHANNEL_RECONNECT_REQUIRED]
        self.assertIn("Reconnect YouTube for this channel on the Channels page", s)
        self.assertIn("Nothing was charged", s)

    def test_no_sentence_names_a_vendor_error_or_a_token(self):
        for lang in ("en", "ru", "uz"):
            for c in (render_error.CHANNEL_RECONNECT_REQUIRED, render_error.CREDENTIALS_MISSING):
                s = self.sentences(lang)[c]
                for word in ("invalid_grant", "refresh token", "token", "GEMINI", "PEXELS", "API_KEY"):
                    self.assertNotIn(word, s, f"{lang}/{c}")


if __name__ == "__main__":
    unittest.main()


class NoWorkerEndingFallsThroughToUnknown(unittest.TestCase):
    """render_jobs id 8 (2026-11-14): a deliberate fact-check hold (exit 79) reached the MCP as `unknown`. Every way the
    worker ends a failed run with a main.py exit code, or with its own no-video header, must name a code."""

    def failing_exits(self):
        from tools import queue_worker as qw  # noqa: PLC0415

        src = (ROOT / "tools" / "queue_worker.py").read_text()
        names = re.findall(r"if rc == ([A-Z_]+_EXIT):", src)
        self.assertGreaterEqual(len(names), 8, names)
        # 75 is not a failure: the job succeeds and waits at "Storyboard ready", with no error to explain.
        return {n: getattr(qw, n) for n in names if n != "STORYBOARD_PAUSED_EXIT"}

    def test_every_failing_exit_branch_classifies_to_a_named_code(self):
        for name, rc in self.failing_exits().items():
            with self.subTest(exit=name):
                code = render_error.classify(f"main.py exited with code {rc}: x", [])
                self.assertNotEqual(code, render_error.UNKNOWN, f"{name} ({rc}) reads unknown")
                self.assertIn(code, render_error.CODES)

    def test_the_spend_ceiling_and_the_empty_render_are_named(self):
        self.assertEqual(render_error.classify("main.py exited with code 78: the channel's spend ceiling", []),
                         render_error.SPEND_CEILING)
        self.assertEqual(render_error.classify(f"{render_error.NO_VIDEO_HEADER}; nothing was charged.", []),
                         render_error.RENDER)
        self.assertIn("render_error.NO_VIDEO_HEADER", (ROOT / "tools" / "queue_worker.py").read_text())

    def test_the_held_sentence_says_where_the_held_run_is(self):
        s = TheCustomersSentenceNamesTheFix().sentences("en")[render_error.HELD]
        self.assertIn("held for a person's review", s)
        self.assertIn("Videos page", s)
        self.assertIn("nothing was charged", s)
