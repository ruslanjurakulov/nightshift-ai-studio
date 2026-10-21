"""The owner's button-connected token (migration 0115) is THE token the scheduled Chronos run uses, checks and proves.

The owner presses "Connect YouTube" on the default channel's card; the refresh token lands in Supabase Vault. What would
break without these:

* the pre-spend liveness check (#556) or the credential health asking Google about the OLD YOUTUBE_TOKEN_JSON secret while the
  upload uses the Vault token (or the reverse): a green check on a token that is not the one uploading, or a stop on a dead
  secret the owner already replaced;
* the doctor passing the old secret while the run uses a dead Vault token;
* the Vault token written where the uploader does not look (the CI trap in modules/channel_credentials.token_path: the
  secret step writes the unsuffixed file while YOUTUBE_CHANNEL_ID suffixes the primary name at run time);
* a customer row (or a lookalike id) reaching the operator's token.

No network: Google and Supabase are fakes.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config as cfg
from modules import channel_credentials as cc
from modules import channel_tokens as ct
from modules import credential_health as ch
from modules import youtube_token_check as ytc
from modules.channels import ChannelContext, CredentialRef, legacy_default_channel
from tests.test_doctor import FakeHttp as DoctorHttp, make_ctx, one
from tools import doctor as d
from tools import restore_channel_token as restore
from tools.doctor import FAIL, PASS, WARN, Resp

VAULT_REFRESH = "1//0gVAULTrefreshTOKENoperator0123456789abcdef"
OLD_REFRESH = "1//0gOLDsecretREFRESHdeadDEADdead0123456789"
CC_CLIENT, CC_SECRET = "cc-client.apps.googleusercontent.com", "GOCSPX-command-center-client"
OLD_CLIENT, OLD_SECRET = "old-installed.apps.googleusercontent.com", "GOCSPX-old-installed-client"
OLD_TOKEN = json.dumps({"refresh_token": OLD_REFRESH, "client_id": OLD_CLIENT, "client_secret": OLD_SECRET,
                        "token": "ya29.old", "scopes": ["x"]})
ENV = {ct.CLIENT_ID_ENV: CC_CLIENT, ct.CLIENT_SECRET_ENV: CC_SECRET}


def vault_row(**kw):
    row = {"refresh_token": VAULT_REFRESH, "scopes": ["https://www.googleapis.com/auth/youtube.upload"],
           "oauth_client_id": CC_CLIENT, "youtube_channel_id": "UCchronos", "connected_at": "2026-10-21T00:00:00Z"}
    row.update(kw)
    return row


class Resp_:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


class Session:
    def __init__(self, resp):
        self.resp, self.calls = resp, []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append((url, json))
        return self.resp


def vault(rows, status=200):
    return ct.VaultTokenClient("https://x.supabase.co", "service-key", session=Session(Resp_(status, rows)))


class FakePost:
    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def __call__(self, url, data):
        self.calls.append((url, dict(data)))
        return self.answers[min(len(self.calls), len(self.answers)) - 1]


OK = (200, {"access_token": "ya29.NEW"})
DEAD = (400, {"error": "invalid_grant"})


class OnDisk(unittest.TestCase):
    """The Actions job: the secret step writes youtube_token.json, then the Vault step may replace it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.gh_env = self.base / "gh_env"
        self.gh_env.write_text("")
        for p in (mock.patch.object(cfg, "BASE_DIR", self.base),
                  mock.patch.object(cfg, "YOUTUBE_TOKEN_FILE", self.base / "youtube_token.json")):
            p.start()
            self.addCleanup(p.stop)
        self.channel = legacy_default_channel()

    def tearDown(self):
        self.tmp.cleanup()

    def restore(self, tc, **env):
        out = io.StringIO()
        rc = restore.main({"CHANNEL_ID": "default", "GITHUB_ENV": str(self.gh_env), **ENV, **env},
                          load_channel=lambda _id: self.channel, client=tc, out=out)
        return rc, out.getvalue()

    def secret_step(self):
        (self.base / "youtube_token.json").write_text(OLD_TOKEN)

    def test_the_liveness_check_asks_google_about_the_vault_token_not_the_old_secret(self):
        self.secret_step()
        self.assertEqual(self.restore(vault([vault_row()]))[0], 0)
        post = FakePost(OK)
        self.assertEqual(ytc.check_channel_token(self.channel, post=post).status, ytc.LIVE)
        (_, form), = post.calls
        self.assertEqual((form["refresh_token"], form["client_id"], form["client_secret"]), (VAULT_REFRESH, CC_CLIENT, CC_SECRET))

    def test_a_dead_old_secret_no_longer_stops_a_run_whose_vault_token_is_live(self):
        """The owner's situation: YOUTUBE_TOKEN_JSON is dead (invalid_grant); he pressed the button; the run must use the new token."""
        self.secret_step()
        self.restore(vault([vault_row()]))

        def google(url, data):
            return OK if data["refresh_token"] == VAULT_REFRESH else DEAD

        report = ch.with_live_youtube_check(ch.check_run_credentials(self.channel), self.channel,
                                            check=lambda c: ytc.check_channel_token(c, post=google))
        self.assertEqual([c.name for c in report.blocking if c.name == "youtube_token_live"], [])
        self.assertTrue(next(c for c in report.checks if c.name == "youtube_token_live").ok)

    def test_with_no_connection_the_old_secret_is_checked_exactly_as_before(self):
        self.secret_step()
        self.assertEqual(self.restore(vault([]))[0], 0)
        post = FakePost(DEAD)
        verdict = ytc.check_channel_token(self.channel, post=post, sleep=lambda s: None)
        self.assertEqual((verdict.status, post.calls[0][1]["refresh_token"]), (ytc.DEAD, OLD_REFRESH))

    def test_the_credential_status_the_bot_mirrors_reads_the_same_file(self):
        self.secret_step()
        self.restore(vault([vault_row()]))
        status = cc.credential_status(self.channel)
        self.assertTrue(status.is_connected)
        self.assertEqual(json.loads(cc.token_path(self.channel).read_text())["refresh_token"], VAULT_REFRESH)

    def test_the_file_is_where_the_run_looks_even_when_YOUTUBE_CHANNEL_ID_suffixes_the_primary_name(self):
        """modules/channel_credentials.token_path: the secret step writes youtube_token.json; at run time the primary name
        is youtube_token_<id>.json (absent) and the unsuffixed file is found by the fallback. The Vault token must be THAT file."""
        self.secret_step()
        self.restore(vault([vault_row()]))
        with mock.patch.object(cfg, "YOUTUBE_TOKEN_FILE", self.base / "youtube_token_UCchronos.json"):
            run_time = cc.token_path(legacy_default_channel())
            self.assertEqual(run_time.name, "youtube_token.json")
            self.assertEqual(json.loads(run_time.read_text())["refresh_token"], VAULT_REFRESH)
            self.assertEqual(cc.legacy_token_path(), run_time)

    def test_without_a_secret_file_the_vault_token_is_still_written_where_the_run_looks(self):
        self.assertEqual(self.restore(vault([vault_row()]))[0], 0)
        self.assertEqual(json.loads(cc.legacy_token_path().read_text())["refresh_token"], VAULT_REFRESH)

    def test_the_vault_token_is_the_default_channels_own_row_and_never_a_references(self):
        """The key is the channel id: a `credential.ref` pointing at another channel changes nothing."""
        ch_ctx = ChannelContext(channel_id="default", name="N", niche="n", credential=CredentialRef(ref="extinct-world"))
        self.channel = ch_ctx
        tc = vault([vault_row()])
        self.restore(tc)
        self.assertEqual([c[1] for c in tc._http.calls], [{"p_channel_id": "default"}])


class Doctor(unittest.TestCase):
    """tools/doctor.py check_youtube proves the token the run uses."""

    class Http(DoctorHttp):
        def __init__(self, vault_resp, routes=None):
            super().__init__(routes)
            self.vault_resp = vault_resp
            self.json_calls = []

        def post_json(self, url, body, headers=None):
            self.json_calls.append((url, body))
            return self.vault_resp

    def ctx(self, vault_resp, env=None, google=OK):
        base = {"YOUTUBE_TOKEN_JSON": OLD_TOKEN, "YOUTUBE_CHANNEL_ID": "UCchronos", **ENV, **(env or {})}

        def route(url, params):
            return Resp(*google)

        c = make_ctx(base, [("POST", "oauth2.googleapis.com/token", route)])
        c.http = self.Http(vault_resp, [("POST", "oauth2.googleapis.com/token", route)])
        return c

    def test_an_active_connection_is_the_token_the_doctor_refreshes(self):
        c = self.ctx(Resp(200, [vault_row()]))
        check = one(d.check_youtube(c), "operator channel token")
        self.assertEqual(check.status, PASS)
        self.assertIn("Command Center", check.detail)
        post, = [x for x in c.http.calls if x[0] == "POST"]
        self.assertEqual((post[4]["refresh_token"], post[4]["client_id"]), (VAULT_REFRESH, CC_CLIENT))
        self.assertEqual(c.http.json_calls[0][1], {"p_channel_id": "default"})

    def test_a_dead_vault_token_fails_even_though_the_old_secret_is_fine(self):
        c = self.ctx(Resp(200, [vault_row()]), google=(400, {"error": "invalid_grant"}))
        check = one(d.check_youtube(c), "operator channel token")
        self.assertEqual(check.status, FAIL)
        self.assertIn("Reconnect", check.fix)
        self.assertNotIn(VAULT_REFRESH, check.detail + check.fix)

    def test_no_connection_is_todays_check_of_YOUTUBE_TOKEN_JSON(self):
        for resp in (Resp(200, []), Resp(404, {"code": "PGRST202"})):
            c = self.ctx(resp)
            self.assertEqual(one(d.check_youtube(c), "operator channel token").status, PASS)
            post, = [x for x in c.http.calls if x[0] == "POST"]
            self.assertEqual(post[4]["refresh_token"], OLD_REFRESH)

    def test_a_connection_this_environment_cannot_refresh_is_a_fail_not_a_pass_on_the_old_secret(self):
        c = self.ctx(Resp(200, [vault_row()]), env={ct.CLIENT_ID_ENV: "", ct.CLIENT_SECRET_ENV: ""})
        check = one(d.check_youtube(c), "operator channel token")
        self.assertEqual(check.status, FAIL)
        self.assertIn("GOOGLE_OAUTH_CLIENT_ID", check.fix)
        self.assertEqual([x for x in c.http.calls if x[0] == "POST"], [])

    def test_a_failed_lookup_warns_and_still_checks_the_old_secret(self):
        c = self.ctx(Resp(503, None))
        checks = d.check_youtube(c)
        self.assertEqual(one(checks, "operator channel connection").status, WARN)
        self.assertEqual(one(checks, "operator channel token").status, PASS)

    def test_no_supabase_means_the_old_path(self):
        c = self.ctx(Resp(200, [vault_row()]))
        c.env = {k: v for k, v in c.env.items() if k != "SUPABASE_URL"}
        self.assertEqual(one(d.check_youtube(c), "operator channel token").status, PASS)
        self.assertEqual(c.http.json_calls, [])

    def test_the_other_operator_channels_are_proved_by_their_vault_connection_first(self):
        rows = [{"channel_id": "finance", "token_secret": "CHRONOS_YT_TOKEN_FINANCE"}]
        env = {"DOCTOR_CHANNEL_TOKEN_ROWS": json.dumps(rows), "DOCTOR_CHANNEL_TOKEN_0": ""}   # secret unset
        c = self.ctx(Resp(200, [vault_row()]), env=env)
        checks = d.check_channel_tokens(c)
        self.assertEqual([(x.name, x.status) for x in checks], [("finance", PASS)])
        self.assertEqual(c.http.json_calls[0][1], {"p_channel_id": "finance"})
        # and without a connection a missing secret is still the FAIL it always was
        c = self.ctx(Resp(200, []), env=env)
        self.assertEqual([(x.name, x.status) for x in d.check_channel_tokens(c)], [("finance", FAIL)])


if __name__ == "__main__":
    unittest.main()
