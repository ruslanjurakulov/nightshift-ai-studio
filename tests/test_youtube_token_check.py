"""The in-run YouTube token liveness check (audit H2): found out BEFORE the spend, not at the upload.

A dead refresh token (revoked, or expired after 7 days in an OAuth app left in "Testing") used to
surface only when the upload called ``creds.refresh()``, after the script, the voice, the stills and
the render were paid for. The check asks Google's token endpoint (no YouTube quota, nothing uploaded,
nothing saved) with the channel's own token, before the first paid step:

  dead     -> the run stops before it spends, through the same early stop as a missing key;
  unknown  -> asked once more, then the run goes on (an unknown is not a no);
  live     -> nothing changes.

Fakes only: no Google call is made, the HTTP seam is a list of canned answers.
"""

from __future__ import annotations

import io
import json
import logging
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config
from modules import channel_credentials as cc
from modules import credential_health as ch
from modules import youtube_token_check as ytc
from modules.channels import DEFAULT_ORG_ID, ChannelContext, CredentialRef

REFRESH = "1//SECRET-refresh-token-value"
CLIENT_SECRET = "GOCSPX-secret-client-value"
TOKEN = {"token": "ya29.SECRET-access", "refresh_token": REFRESH, "client_id": "123.apps.googleusercontent.com",
         "client_secret": CLIENT_SECRET, "token_uri": "https://evil.example/token", "scopes": ["x"]}
SECRETS = (REFRESH, CLIENT_SECRET, "ya29.SECRET-access", "evil.example")


class FakePost:
    """Canned answers, in order; the last one repeats. Records what was asked and where."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, url, data):
        self.calls.append((url, dict(data)))
        a = self.answers[min(len(self.calls), len(self.answers)) - 1]
        if isinstance(a, BaseException):
            raise a
        return a


OK = (200, {"access_token": "ya29.NEW", "expires_in": 3599})
GRANT = (400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
BLIP = (None, None)


class ClassificationTestCase(unittest.TestCase):
    def test_table(self):
        cases = [
            ((200, {"access_token": "a"}), ytc.LIVE, ""),
            (GRANT, ytc.DEAD, "invalid_grant"),
            ((401, {"error": "invalid_client"}), ytc.DEAD, "invalid_client"),
            ((400, {"error": "unauthorized_client"}), ytc.DEAD, "unauthorized_client"),
            ((400, {"error": "invalid_request"}), ytc.UNKNOWN, "http_error"),    # not ours to interpret
            ((429, {"error": "rate_limit_exceeded"}), ytc.UNKNOWN, "http_error"),
            ((500, None), ytc.UNKNOWN, "http_error"),
            ((503, {"error": "backendError"}), ytc.UNKNOWN, "http_error"),
            ((200, {}), ytc.UNKNOWN, "no_answer"),                                # 200 without a token proves nothing
            ((200, "html"), ytc.UNKNOWN, "no_answer"),
            (BLIP, ytc.UNKNOWN, "network"),
            ((400, {"error": "Invalid Grant; ya29.leak"}), ytc.UNKNOWN, "http_error"),  # only a plain word counts
        ]
        for answer, status, reason in cases:
            with self.subTest(answer=answer):
                v = ytc.verdict_from_response(*answer)
                self.assertEqual((v.status, v.reason), (status, reason))

    def test_every_reason_is_from_the_closed_list(self):
        for answer in (OK, GRANT, BLIP, (500, None), (200, {})):
            self.assertIn(ytc.verdict_from_response(*answer).reason or "", ("",) + ytc.REASONS)


class ChannelFixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        patcher = mock.patch.object(config, "BASE_DIR", self.base)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)

    def channel(self, channel_id="finance", **kw):
        return ChannelContext(channel_id=channel_id, name=channel_id, niche="n",
                              credential=CredentialRef(ref=kw.pop("ref", "")), **kw)

    def write_token(self, channel, doc):
        path = cc.token_path(channel)
        path.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")
        return path


class CheckChannelTokenTestCase(ChannelFixture):
    def run_check(self, channel, post):
        return ytc.check_channel_token(channel, post=post, sleep=lambda s: None)

    def test_a_refused_refresh_token_is_dead_and_asked_once(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        post = FakePost(GRANT)
        v = self.run_check(ch_, post)
        self.assertEqual((v.status, v.reason, v.attempts), (ytc.DEAD, "invalid_grant", 1))
        self.assertEqual(len(post.calls), 1)                      # a definite no is not retried

    def test_a_live_token_is_live(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        v = self.run_check(ch_, FakePost(OK))
        self.assertEqual((v.status, v.attempts), (ytc.LIVE, 1))

    def test_a_network_blip_is_retried_once_then_proceeds_as_unknown(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        post = FakePost(BLIP, (503, None))
        v = self.run_check(ch_, post)
        self.assertEqual((v.status, v.attempts), (ytc.UNKNOWN, 2))
        self.assertEqual(len(post.calls), 2)                      # exactly one retry, no loop

    def test_a_blip_followed_by_an_answer_uses_the_answer(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        self.assertEqual(self.run_check(ch_, FakePost(BLIP, OK)).status, ytc.LIVE)
        self.assertEqual(self.run_check(ch_, FakePost(BLIP, GRANT)).status, ytc.DEAD)

    def test_a_raising_transport_is_an_unknown_not_a_crash(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        v = self.run_check(ch_, FakePost(TimeoutError("read timed out")))
        self.assertEqual(v.status, ytc.UNKNOWN)

    def test_the_retry_waits_and_the_wait_is_bounded(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        waits = []
        ytc.check_channel_token(ch_, post=FakePost(BLIP), sleep=waits.append)
        self.assertEqual(waits, [ytc.RETRY_DELAY_SECONDS])
        self.assertLessEqual(ytc.RETRY_DELAY_SECONDS, 5)

    def test_no_token_file_asks_google_nothing(self):
        post = FakePost(OK)
        v = self.run_check(self.channel(), post)
        self.assertEqual(v.status, ytc.ABSENT)
        self.assertEqual(post.calls, [])

    def test_a_token_file_that_cannot_be_used_is_dead_without_a_call(self):
        for bad in ("not json", "[]", json.dumps({"refresh_token": REFRESH}),
                    json.dumps({**TOKEN, "client_secret": ""}), json.dumps({**TOKEN, "refresh_token": None})):
            with self.subTest(bad=bad[:20]):
                ch_ = self.channel()
                self.write_token(ch_, bad)
                post = FakePost(OK)
                v = self.run_check(ch_, post)
                self.assertEqual((v.status, v.reason), (ytc.DEAD, ytc.MALFORMED))
                self.assertEqual(post.calls, [])

    def test_the_request_goes_to_googles_fixed_url_whatever_the_file_says(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        post = FakePost(OK)
        self.run_check(ch_, post)
        url, form = post.calls[0]
        self.assertEqual(url, "https://oauth2.googleapis.com/token")
        self.assertEqual(form["grant_type"], "refresh_token")

    def test_the_token_is_read_the_way_the_uploader_reads_it(self):
        # An operator channel's token comes from its CHRONOS_YT_TOKEN_<REF> secret, written to its file.
        ch_ = self.channel("news", ref="finance")
        self.assertTrue(ch_.is_operators)
        with mock.patch.dict(os.environ, {"CHRONOS_YT_TOKEN_FINANCE": json.dumps(TOKEN)}):
            post = FakePost(OK)
            v = self.run_check(ch_, post)
        self.assertEqual(v.status, ytc.LIVE)
        self.assertEqual(post.calls[0][1]["refresh_token"], REFRESH)

    def test_a_customer_channel_reads_its_vault_file_never_the_environment(self):
        ch_ = ChannelContext(channel_id="finance", name="f", niche="n", org_id="11111111-1111-1111-1111-111111111111")
        self.assertFalse(ch_.is_operators)
        with mock.patch.dict(os.environ, {"CHRONOS_YT_TOKEN_FINANCE": json.dumps(TOKEN)}):
            post = FakePost(OK)
            v = self.run_check(ch_, post)
            self.assertEqual(v.status, ytc.ABSENT)                # the operator's secret is not theirs
            self.assertEqual(post.calls, [])
            self.write_token(ch_, TOKEN)
            self.assertEqual(self.run_check(ch_, post).status, ytc.LIVE)

    def test_nothing_secret_is_kept_logged_or_printed(self):
        ch_ = self.channel()
        self.write_token(ch_, TOKEN)
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        for answer in (GRANT, OK, BLIP, (500, {"error": "backendError", "echo": REFRESH})):
            v = self.run_check(ch_, FakePost(answer))
            for secret in SECRETS:
                self.assertNotIn(secret, repr(v))
        for secret in SECRETS:
            self.assertNotIn(secret, stream.getvalue())


class HealthReportTestCase(ChannelFixture):
    """The verdict joins the credential report, so the existing early stop and event carry it."""

    def report(self):
        return ch.HealthReport("finance", (ch.CredentialCheck("gemini", ch.OK, required=True),))

    def with_check(self, verdict, channel=None):
        with mock.patch.object(ytc, "check_channel_token", return_value=verdict):
            return ch.with_live_youtube_check(self.report(), channel or self.channel())

    def test_a_dead_token_blocks_the_run_with_fixed_words(self):
        for reason in sorted(ytc.DEAD_CODES) + [ytc.MALFORMED]:
            with self.subTest(reason=reason):
                report = self.with_check(ytc.TokenVerdict(ytc.DEAD, reason, 1))
                self.assertFalse(report.ok)
                self.assertEqual([c.name for c in report.blocking], ["youtube_token_live"])
                detail = report.blocking[0].detail
                self.assertIn("before anything was spent", detail.lower())
                self.assertIn("finance", detail)
                self.assertNotIn("{", detail)

    def test_an_unknown_token_does_not_block_and_says_so(self):
        report = self.with_check(ytc.TokenVerdict(ytc.UNKNOWN, "network", 2))
        self.assertTrue(report.ok)
        self.assertEqual(report.blocking, [])
        live = next(c for c in report.checks if c.name == "youtube_token_live")
        self.assertEqual(live.status, ch.UNKNOWN)
        self.assertIn("not a no", live.detail.lower())

    def test_a_live_token_adds_a_passing_check(self):
        report = self.with_check(ytc.TokenVerdict(ytc.LIVE, "", 1))
        self.assertTrue(report.ok)
        self.assertTrue(next(c for c in report.checks if c.name == "youtube_token_live").ok)

    def test_an_absent_token_adds_nothing(self):
        before = self.report()
        after = self.with_check(ytc.TokenVerdict(ytc.ABSENT))
        self.assertEqual(before.checks, after.checks)

    def test_the_report_dict_the_event_carries_has_no_secret(self):
        report = self.with_check(ytc.TokenVerdict(ytc.DEAD, "invalid_grant", 1))
        text = json.dumps(report.to_dict())
        for secret in SECRETS:
            self.assertNotIn(secret, text)

    def test_a_check_that_blows_up_never_stops_a_run(self):
        with mock.patch.object(ytc, "check_channel_token", side_effect=RuntimeError("boom ya29.SECRET")):
            report = ch.with_live_youtube_check(self.report(), self.channel())
        self.assertTrue(report.ok)
        self.assertNotIn("SECRET", json.dumps(report.to_dict()))


class MainPreflightTestCase(unittest.TestCase):
    """run() asks before the first paid step, only when it will upload, and stops through CredentialsMissing."""

    class Reached(Exception):
        """Raised by the first paid-step guard: the run got past the credential preflight."""

    def setUp(self):
        try:
            import main  # noqa: PLC0415
        except Exception as e:  # pragma: no cover - environment without the render stack
            self.skipTest(f"main.py cannot be imported here ({type(e).__name__})")
        self.main = main
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)
        spacious = mock.patch.object(main.disk_guard, "free_bytes", lambda _p: 100 * 1024 ** 3)
        spacious.start()
        self.addCleanup(spacious.stop)
        self.ctx = ChannelContext(channel_id="default", name="X", niche="h")
        self.ok = ch.HealthReport("default", (ch.CredentialCheck("gemini", ch.OK, required=True),))
        self.emitted = []

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_main(self, verdict, *, skip_upload=False, ctx=None):
        asked = mock.Mock(return_value=verdict)

        def guard(*a, **k):
            raise self.Reached()

        with mock.patch.object(self.main, "check_run_credentials", return_value=self.ok), \
                mock.patch.object(ytc, "check_channel_token", asked), \
                mock.patch.object(self.main, "_guard_spend", guard), \
                mock.patch.object(self.main.events, "emit",
                                  lambda *a, **k: self.emitted.append((a, k))), \
                mock.patch.object(self.main, "StateStore", side_effect=AssertionError("budget read")), \
                mock.patch.object(self.main, "MediaFetcher", side_effect=AssertionError("fetched")):
            try:
                self.main.run(channel=ctx or self.ctx, skip_upload=skip_upload)
            finally:
                self.asked = asked

    def test_a_dead_token_stops_the_run_before_anything_is_spent(self):
        with self.assertRaises(ch.CredentialsMissing) as caught:
            self.run_main(ytc.TokenVerdict(ytc.DEAD, "invalid_grant", 1))
        self.assertIn("youtube_token_live", str(caught.exception))
        self.assertIn("invalid_grant", str(caught.exception))
        self.assertIn("before anything was spent", str(caught.exception))
        for secret in SECRETS:
            self.assertNotIn(secret, str(caught.exception))
        health = [k for a, k in self.emitted if a and a[0] == self.main.events.CREDENTIAL_HEALTH]
        self.assertEqual(len(health), 1)
        self.assertEqual(health[0]["status"], self.main.events.STATUS_FAILED)
        self.assertEqual(health[0]["channel_id"], "default")
        self.assertEqual(health[0]["metadata"]["blocking"], ["youtube_token_live"])

    def test_an_unknown_token_does_not_stall_the_run(self):
        with self.assertRaises(self.Reached):
            self.run_main(ytc.TokenVerdict(ytc.UNKNOWN, "network", 2))
        self.asked.assert_called_once()

    def test_a_live_token_changes_nothing(self):
        with self.assertRaises(self.Reached):
            self.run_main(ytc.TokenVerdict(ytc.LIVE, "", 1))

    def test_a_run_that_will_not_upload_is_not_asked(self):
        with self.assertRaises(self.Reached):
            self.run_main(ytc.TokenVerdict(ytc.DEAD, "invalid_grant", 1), skip_upload=True)
        self.asked.assert_not_called()

    def test_a_channel_with_auto_publish_off_is_not_asked(self):
        from dataclasses import replace  # noqa: PLC0415

        ctx = replace(self.ctx, agent=replace(self.ctx.agent, auto_publish=False))
        with self.assertRaises(self.Reached):
            self.run_main(ytc.TokenVerdict(ytc.DEAD, "invalid_grant", 1), ctx=ctx)
        self.asked.assert_not_called()

    def test_the_check_comes_before_the_first_paid_step_in_the_source(self):
        import ast  # noqa: PLC0415

        src = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")
        run = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "run")
        body = ast.get_source_segment(src, run)
        asked, raised = body.index("with_live_youtube_check(health, ctx)"), body.index("raise CredentialsMissing(")
        self.assertLess(asked, raised)
        self.assertLess(raised, body.index("_guard_spend(ctx, costs, \"the topic\")"))


if __name__ == "__main__":
    unittest.main()
