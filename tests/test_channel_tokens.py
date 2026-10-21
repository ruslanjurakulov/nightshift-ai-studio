"""Customer channels' Vault tokens (migration 0022): modules/channel_tokens.py,
its use in the queue worker, and the workflow's restore step.

What would break without these:

* a customer who connected their channel silently uploading with a stale
  GitHub secret instead (or the operator who pressed "Connect YouTube" on his
  own default channel, Chronos, silently still uploading with a dead
  YOUTUBE_TOKEN_JSON);
* a refresh token surfacing in a log line, an exception, a stored job error or
  a repr — the one thing this whole path exists to prevent;
* a token file left readable by others, or left on disk after the run;
* a Vault outage turning into a rendered video that cannot be uploaded,
  instead of a run that stops before it spends anything;
* a token document the uploader cannot refresh, which on a runner falls
  through to interactive consent and dies.
"""

from __future__ import annotations

import io
import json
import logging
import os
import stat
import sys
import tempfile
import textwrap
import traceback
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import channel_tokens as ct  # noqa: E402
from tools import queue_worker as qw  # noqa: E402
from tools import restore_channel_token as restore  # noqa: E402
from tests.test_queue_worker import OperatorCredits  # noqa: E402

REFRESH = "1//0gVAULTREFRESHTOKENabcdefghijklmnopqrstuvwxyz0123"
CLIENT_ID = "123-abc.apps.googleusercontent.com"
CLIENT_SECRET = "GOCSPX-commandcenterclientsecret"
ENV_TOKEN = json.dumps({"refresh_token": "1//0gGITHUBSECRETTOKENzyxwvutsrqponmlkjihgf",
                        "client_id": "x", "client_secret": "y"})


class Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class Session:
    """Answers read_channel_token like PostgREST would."""

    def __init__(self, resp=None, exc=None):
        self.resp = resp
        self.exc = exc
        self.calls = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append((url, json))
        if self.exc:
            raise self.exc
        return self.resp


def vault_row(**kw):
    row = {"refresh_token": REFRESH, "scopes": ["https://www.googleapis.com/auth/youtube.upload"],
           "oauth_client_id": CLIENT_ID, "youtube_channel_id": "UCcustomer000000000000000",
           "connected_at": "2026-09-26T00:00:00Z"}
    row.update(kw)
    return row


def client(resp=None, exc=None):
    return ct.VaultTokenClient("https://x.supabase.co", "service-key-value",
                               session=Session(resp, exc))


BASE_ENV = {ct.CLIENT_ID_ENV: CLIENT_ID, ct.CLIENT_SECRET_ENV: CLIENT_SECRET}


class FallbackOrder(unittest.TestCase):
    def test_active_vault_token_wins_over_the_github_secret(self):
        env = dict(BASE_ENV, CHRONOS_YT_TOKEN_SHOP=ENV_TOKEN)
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", env, client=client(Resp(200, [vault_row()])))
        self.assertEqual(r.source, ct.SOURCE_VAULT)
        doc = json.loads(r.token_json)
        self.assertEqual(doc["refresh_token"], REFRESH)
        self.assertEqual((doc["client_id"], doc["client_secret"]), (CLIENT_ID, CLIENT_SECRET))

    def test_no_active_connection_falls_back_to_the_github_secret(self):
        env = dict(BASE_ENV, CHRONOS_YT_TOKEN_SHOP=ENV_TOKEN)
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", env, client=client(Resp(200, [])))
        self.assertEqual((r.source, r.token_json), (ct.SOURCE_ENV, ENV_TOKEN))

    def test_migration_not_applied_is_no_token_not_an_error(self):
        env = dict(BASE_ENV, CHRONOS_YT_TOKEN_SHOP=ENV_TOKEN)
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", env,
                                     client=client(Resp(404, {"code": "PGRST202"})))
        self.assertEqual(r.source, ct.SOURCE_ENV)
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", BASE_ENV,
                                     client=client(Resp(404, {"code": "PGRST202"})))
        self.assertEqual(r.source, ct.SOURCE_NONE)

    def test_nothing_anywhere_is_no_token_never_another_channels(self):
        env = dict(BASE_ENV, CHRONOS_YT_TOKEN_OTHER=ENV_TOKEN, YOUTUBE_TOKEN_JSON=ENV_TOKEN)
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", env, client=client(Resp(200, [])))
        self.assertEqual((r.source, r.found), (ct.SOURCE_NONE, False))

    def test_the_operators_default_channel_uses_its_vault_connection_over_YOUTUBE_TOKEN_JSON(self):
        """Migration 0115: the owner's button-connected Chronos token wins; the key is the channel's own id."""
        s = Session(Resp(200, [vault_row()]))
        c = ct.VaultTokenClient("https://x.supabase.co", "k", session=s)
        env = dict(BASE_ENV, YOUTUBE_TOKEN_JSON=ENV_TOKEN)
        r = ct.resolve_channel_token("default", "YOUTUBE_TOKEN_JSON", env, client=c)
        self.assertEqual(r.source, ct.SOURCE_VAULT)
        self.assertEqual(json.loads(r.token_json)["refresh_token"], REFRESH)
        self.assertEqual([call[1] for call in s.calls], [{"p_channel_id": "default"}])

    def test_the_default_channel_without_a_connection_keeps_YOUTUBE_TOKEN_JSON(self):
        r = ct.resolve_channel_token("default", "YOUTUBE_TOKEN_JSON", dict(BASE_ENV, YOUTUBE_TOKEN_JSON=ENV_TOKEN),
                                     client=client(Resp(200, [])))
        self.assertEqual((r.source, r.token_json), (ct.SOURCE_ENV, ENV_TOKEN))
        r = ct.resolve_channel_token("default", "YOUTUBE_TOKEN_JSON", dict(BASE_ENV, YOUTUBE_TOKEN_JSON=ENV_TOKEN),
                                     client=client(Resp(404, {"code": "PGRST202"})))
        self.assertEqual(r.source, ct.SOURCE_ENV)

    def test_a_connection_whose_oauth_client_is_missing_stops_instead_of_using_the_old_secret(self):
        """An unusable connection is not "no connection": falling back would upload with a token the owner just replaced."""
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("default", "YOUTUBE_TOKEN_JSON", {"YOUTUBE_TOKEN_JSON": ENV_TOKEN},
                                     client=client(Resp(200, [vault_row()])))
        self.assertNotIsInstance(cm.exception, ct.VaultLookupError)
        self.assertNotIn(REFRESH, str(cm.exception))

    def test_a_failed_lookup_is_told_apart_from_a_missing_client(self):
        with self.assertRaises(ct.VaultLookupError):
            ct.resolve_channel_token("default", "YOUTUBE_TOKEN_JSON", BASE_ENV, client=client(Resp(500, {})))

    def test_without_supabase_configured_it_is_todays_path(self):
        c = ct.VaultTokenClient("", "")
        r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", {"CHRONOS_YT_TOKEN_SHOP": ENV_TOKEN}, client=c)
        self.assertEqual(r.source, ct.SOURCE_ENV)

    def test_a_failed_lookup_uses_the_secret_when_there_is_one(self):
        env = dict(BASE_ENV, CHRONOS_YT_TOKEN_SHOP=ENV_TOKEN)
        with self.assertLogs("modules.channel_tokens", level="WARNING") as logs:
            r = ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", env, client=client(Resp(503, {})))
        self.assertEqual(r.source, ct.SOURCE_ENV)
        self.assertIn("HTTP 503", "\n".join(logs.output))

    def test_a_failed_lookup_with_no_fallback_stops_the_run(self):
        with self.assertRaises(ct.ChannelTokenError):
            ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", BASE_ENV, client=client(Resp(500, {})))

    def test_token_for_a_different_youtube_channel_is_refused(self):
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("shop", "CHRONOS_YT_TOKEN_SHOP", BASE_ENV,
                                     client=client(Resp(200, [vault_row()])),
                                     expected_youtube_channel_id="UCsomethingelse0000000000")
        self.assertIn("different YouTube channel", str(cm.exception))


class NoTokenLeaks(unittest.TestCase):
    """The refresh token must not appear in any message, repr or traceback."""

    def assert_clean(self, text):
        for secret in (REFRESH, CLIENT_SECRET, "service-key-value"):
            self.assertNotIn(secret, text)

    def test_error_body_echoing_the_token_is_not_repeated(self):
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("shop", "N", BASE_ENV,
                                     client=client(Resp(500, {"message": f"bad {REFRESH}"})))
        self.assert_clean(str(cm.exception))
        self.assert_clean("".join(traceback.format_exception(cm.exception)))

    def test_network_error_carrying_the_token_is_reduced_to_its_type(self):
        boom = ConnectionError(f"reset while sending {REFRESH} with service-key-value")
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("shop", "N", BASE_ENV, client=client(exc=boom))
        self.assertIn("ConnectionError", str(cm.exception))
        self.assert_clean(str(cm.exception))
        self.assert_clean("".join(traceback.format_exception(cm.exception)))

    def test_unreadable_answer_is_reduced(self):
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("shop", "N", BASE_ENV,
                                     client=client(Resp(200, ValueError(f"at {REFRESH}"))))
        self.assert_clean("".join(traceback.format_exception(cm.exception)))

    def test_missing_oauth_client_names_the_fix_not_the_secret(self):
        with self.assertRaises(ct.ChannelTokenError) as cm:
            ct.resolve_channel_token("shop", "N", {}, client=client(Resp(200, [vault_row()])))
        self.assertIn(ct.CLIENT_ID_ENV, str(cm.exception))
        self.assert_clean(str(cm.exception))

    def test_reprs_hide_the_token(self):
        tok = ct.VaultToken(refresh_token=REFRESH, oauth_client_id=CLIENT_ID)
        r = ct.ResolvedToken(ct.SOURCE_VAULT, ct.build_token_json(tok, CLIENT_ID, CLIENT_SECRET))
        self.assert_clean(repr(tok) + repr(r))

    def test_logs_never_carry_the_token(self):
        with self.assertLogs("modules.channel_tokens", level="INFO") as logs:
            ct.resolve_channel_token("shop", "N", BASE_ENV, client=client(Resp(200, [vault_row()])))
            ct.resolve_channel_token("shop", "N", dict(BASE_ENV, N=ENV_TOKEN), client=client(Resp(502, {})))
        self.assert_clean("\n".join(logs.output))
        self.assertNotIn("GITHUBSECRETTOKEN", "\n".join(logs.output))


class OAuthClientPairing(unittest.TestCase):
    def test_the_client_that_minted_the_token_is_required(self):
        tok = ct.VaultToken(refresh_token=REFRESH, oauth_client_id="other-client")
        with self.assertRaises(ct.ChannelTokenError):
            ct.oauth_client_for(tok, BASE_ENV)

    def test_client_secret_json_counts_when_its_id_matches(self):
        env = {ct.CLIENT_FILE_ENV: json.dumps({"web": {"client_id": CLIENT_ID, "client_secret": "file-secret"}}),
               ct.CLIENT_ID_ENV: "someone-else", ct.CLIENT_SECRET_ENV: "zzz"}
        tok = ct.VaultToken(refresh_token=REFRESH, oauth_client_id=CLIENT_ID)
        self.assertEqual(ct.oauth_client_for(tok, env), (CLIENT_ID, "file-secret"))

    def test_the_document_is_one_the_uploader_refreshes_rather_than_reconsents(self):
        """No access token in Vault: the credential must read as expired-with-
        refresh, or every consumer falls into interactive consent on a runner."""
        from google.oauth2.credentials import Credentials

        doc = ct.build_token_json(ct.VaultToken(refresh_token=REFRESH, scopes=("s1",)), CLIENT_ID, CLIENT_SECRET)
        creds = Credentials.from_authorized_user_info(json.loads(doc), ["s1"])
        self.assertFalse(creds.valid)
        self.assertTrue(creds.expired)
        self.assertEqual(creds.refresh_token, REFRESH)


class PrivateFile(unittest.TestCase):
    def test_created_0600_even_over_an_existing_wider_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "youtube_token_shop.json"
            p.write_text("old")
            p.chmod(0o644)
            old = os.umask(0)
            try:
                ct.write_private(p, "{}")
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
            self.assertEqual(p.read_text(), "{}")


# ── the queue worker ────────────────────────────────────────────────────────

FAKE_MAIN = textwrap.dedent("""
    import json, os, sys
    # A customer channel's token reaches the run as the 0600 file the worker wrote
    # (channel_credentials.customer_token_filename), never as an environment
    # variable (BR-L-080); the report says which CHRONOS_YT_TOKEN_* the run saw.
    # (the operator's default channel's, from Vault or YOUTUBE_TOKEN_JSON, is youtube_token.json)
    path = next((p for p in ("youtube_token__shop.json", "youtube_token.json") if os.path.exists(p)), "youtube_token__shop.json")
    doc = open(path).read() if os.path.exists(path) else ""
    report = {"tokens": sorted(k for k in os.environ if k.startswith("CHRONOS_YT_TOKEN_")),
              "oauth_env": sorted(k for k in os.environ if k.startswith("GOOGLE_OAUTH_")),
              "refresh": json.loads(doc).get("refresh_token") if doc else None,
              "mode": oct(os.stat(path).st_mode & 0o777) if doc else None}
    with open("report.out", "w") as fh:
        json.dump(report, fh)
    # A careless library printing the credential it was given:
    print("refreshing with " + (json.loads(doc).get("refresh_token") if doc else ""), flush=True)
    sys.exit(int(os.environ.get("FAKE_RC", "0")))
""")



class FakeQueue:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.calls = []

    def claim(self, worker_id, stale_minutes):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, job_id, worker_id):
        return True

    def finish(self, job_id, worker_id, status, error):
        self.calls.append(("finish", job_id, status, error))
        return True

    def release(self, job_id, worker_id, *, status, attempts, error):
        self.calls.append(("release", job_id, status, attempts, error))
        return True


def job(channel_id="shop"):
    return {"id": 9, "channel_id": channel_id, "kind": "daily", "params": {}, "attempts": 1,
            "max_attempts": 3, "created_at": "2026-09-26T10:00:00+00:00"}


class WorkerWithVault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {"PATH": os.environ.get("PATH", ""), **BASE_ENV,
                    "CHRONOS_YT_TOKEN_NEWS": json.dumps({"refresh_token": "news-refresh-token-xyz"})}
        self.rows = {"shop": {"channel_id": "shop", "is_default": False, "token_secret": "CHRONOS_YT_TOKEN_SHOP"},
                     "default": {"channel_id": "default", "is_default": True, "is_operators": True,
                                 "token_secret": "CHRONOS_YT_TOKEN_DEFAULT"}}
        self.out = io.StringIO()

    def tearDown(self):
        self.tmp.cleanup()

    def run_worker(self, token_client, channel="shop"):
        q = FakeQueue([job(channel)])
        w = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: self.rows[cid], heartbeat_seconds=5,
                      poll_seconds=0.01, grace_seconds=60, kill_after_seconds=2, out=self.out,
                      token_client=token_client, credits=OperatorCredits())
        w.run_forever(once=True)
        return q, w

    def report(self):
        return json.loads((self.repo / "report.out").read_text())

    def test_vault_token_reaches_only_this_run_as_its_own_file_and_is_scrubbed(self):
        q, w = self.run_worker(client(Resp(200, [vault_row()])))
        r = self.report()
        self.assertEqual(r["tokens"], [])  # no operator's token, and none under a name of the row's choosing
        self.assertEqual(r["refresh"], REFRESH)
        self.assertEqual(r["oauth_env"], [])  # the client pair travels in the document only
        self.assertEqual(r["mode"], "0o600")
        self.assertEqual(q.calls[-1][2], "succeeded")
        self.assertNotIn(REFRESH, self.out.getvalue())
        self.assertIn("refreshing with [redacted]", self.out.getvalue())
        self.assertFalse(list(self.repo.glob("youtube_token*.json")))  # deleted after the run
        self.assertNotIn(REFRESH, "".join(w._secrets))  # not kept for the next job

    def test_BR_L_111_a_customers_token_is_scrubbed_from_the_file_even_when_nothing_else_names_it(self):
        """The token travels as a file (BR-L-080), so the scrub list gets its strings from the file."""
        plain = "plainvaulttokenvalue0123456789"
        q, w = self.run_worker(client(Resp(200, [vault_row(refresh_token=plain)])))
        self.assertNotIn(plain, self.out.getvalue())
        self.assertIn("refreshing with [redacted]", self.out.getvalue())

    def test_failed_run_error_is_scrubbed_of_the_vault_token(self):
        self.env["FAKE_RC"] = "2"
        q, _ = self.run_worker(client(Resp(200, [vault_row()])))
        (_, _, status, error) = q.calls[-1]
        self.assertEqual(status, "failed")
        self.assertNotIn(REFRESH, error)
        self.assertNotIn(CLIENT_SECRET, error)

    def test_vault_outage_with_no_secret_fails_before_anything_runs(self):
        with self.assertLogs("queue_worker", level="INFO") as logs:
            q, _ = self.run_worker(client(Resp(500, {"message": REFRESH})))
        (_, _, status, error) = q.calls[-1]
        self.assertEqual(status, "failed")
        self.assertIn("nothing was run", error)
        self.assertNotIn(REFRESH, error + "\n".join(logs.output))
        self.assertFalse((self.repo / "report.out").exists())

    def test_no_connection_and_no_secret_runs_without_a_token_as_before(self):
        q, _ = self.run_worker(client(Resp(200, [])))
        self.assertEqual(self.report()["tokens"], [])
        self.assertEqual(q.calls[-1][2], "succeeded")

    def test_the_operators_default_channel_runs_with_its_vault_token_and_it_is_scrubbed(self):
        """Chronos connected with the Command Center's button: the worker hands the run the Vault token as
        youtube_token.json, never as an env var, and scrubs it from the output."""
        self.env["YOUTUBE_TOKEN_JSON"] = ENV_TOKEN
        q, w = self.run_worker(client(Resp(200, [vault_row()])), channel="default")
        r = self.report()
        self.assertEqual((r["refresh"], r["tokens"], r["oauth_env"], r["mode"]), (REFRESH, [], [], "0o600"))
        self.assertEqual(q.calls[-1][2], "succeeded")
        self.assertNotIn(REFRESH, self.out.getvalue())
        self.assertIn("refreshing with [redacted]", self.out.getvalue())
        self.assertFalse(list(self.repo.glob("youtube_token*.json")))
        self.assertNotIn(REFRESH, "".join(w._secrets))

    def test_the_default_channel_without_a_connection_still_runs_with_YOUTUBE_TOKEN_JSON(self):
        self.env["YOUTUBE_TOKEN_JSON"] = ENV_TOKEN
        q, _ = self.run_worker(client(Resp(200, [])), channel="default")
        self.assertIn("GITHUBSECRETTOKEN", self.report()["refresh"])
        self.assertEqual(q.calls[-1][2], "succeeded")

    def test_the_default_channel_stops_before_spending_when_vault_fails_and_there_is_no_secret(self):
        q, _ = self.run_worker(client(Resp(500, {"message": REFRESH})), channel="default")
        (_, _, status, error) = q.calls[-1]
        self.assertEqual(status, "failed")
        self.assertIn("nothing was run", error)
        self.assertNotIn(REFRESH, error)
        self.assertFalse((self.repo / "report.out").exists())

    def test_a_customer_row_named_like_the_default_channel_never_gets_the_operators_token(self):
        """BR-L-110 with 0115: the Vault key is the row's own id and the env is the operator's only."""
        self.env["YOUTUBE_TOKEN_JSON"] = ENV_TOKEN
        row = {"channel_id": "default", "is_default": False, "is_operators": False, "token_secret": ""}
        resolved = qw.channel_token(row, self.env, client(Resp(200, [])))
        self.assertFalse(resolved.found)
        self.assertNotIn("YOUTUBE_TOKEN_JSON", qw.prepare_credentials(row, self.env, self.repo))

    def test_worker_log_names_the_source_never_the_value(self):
        with self.assertLogs("queue_worker", level="INFO") as logs:
            self.run_worker(client(Resp(200, [vault_row()])))
        joined = "\n".join(logs.output)
        self.assertIn("Vault connection is active", joined)
        self.assertNotIn(REFRESH, joined)
        self.assertNotIn(CLIENT_SECRET, joined)


# ── the workflow step ───────────────────────────────────────────────────────

class Channel:
    def __init__(self, cid, *, default=False, yt=""):
        from modules.channels import ChannelContext

        self.ctx = ChannelContext.from_dict({
            "channel_id": cid, "name": cid, "niche": "n",
            "credential_ref": {"youtube_channel_id": yt, "verified_at": "2026-09-01T00:00:00Z"},
        })
        self.default = default

    def __call__(self, _cid):
        if self.default:
            from modules.channels import legacy_default_channel

            return legacy_default_channel()
        return self.ctx


class RestoreStep(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.github_env = self.base / "github_env"
        self.github_env.write_text("")
        self.patch = mock.patch("config.BASE_DIR", self.base)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def run_step(self, tc, env=None, channel=None):
        out = io.StringIO()
        env = {"CHANNEL_ID": "shop", "GITHUB_ENV": str(self.github_env), **BASE_ENV, **(env or {})}
        rc = restore.main(env, load_channel=channel or Channel("shop"), client=tc, out=out)
        return rc, out.getvalue()

    def test_writes_the_token_file_0600_after_masking_every_secret(self):
        rc, out = self.run_step(client(Resp(200, [vault_row()])))
        self.assertEqual(rc, 0)
        path = self.base / "youtube_token_shop.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(json.loads(path.read_text())["refresh_token"], REFRESH)
        lines = out.splitlines()
        # The only lines naming a secret are the runner's mask commands, and
        # they come before anything else is said about the token.
        for line in lines:
            if REFRESH in line or CLIENT_SECRET in line:
                self.assertTrue(line.startswith("::add-mask::"), line)
        masks = [i for i, l in enumerate(lines) if l.startswith("::add-mask::")]
        self.assertTrue(masks and max(masks) < len(lines) - 1)
        self.assertIn(f"::add-mask::{REFRESH}", lines)
        self.assertIn(f"::add-mask::{CLIENT_SECRET}", lines)

    def test_vault_wins_over_a_secret_that_is_also_set(self):
        rc, out = self.run_step(client(Resp(200, [vault_row()])), env={"CHRONOS_YT_TOKEN_SHOP": ENV_TOKEN})
        self.assertEqual(rc, 0)
        # materialize_token would otherwise overwrite the Vault token with it.
        self.assertEqual(self.github_env.read_text(), "CHRONOS_YT_TOKEN_SHOP=\n")

    def test_no_connection_writes_nothing_and_leaves_the_secret_path_alone(self):
        rc, out = self.run_step(client(Resp(200, [])), env={"CHRONOS_YT_TOKEN_SHOP": ENV_TOKEN})
        self.assertEqual(rc, 0)
        self.assertFalse(list(self.base.glob("youtube_token*.json")))
        self.assertEqual(self.github_env.read_text(), "")

    def test_the_default_channel_is_looked_up_by_its_own_id_and_its_vault_token_replaces_the_secret_file(self):
        (self.base / "youtube_token.json").write_text(ENV_TOKEN)        # what the YOUTUBE_TOKEN_JSON step wrote
        s = Session(Resp(200, [vault_row()]))
        tc = ct.VaultTokenClient("https://x.supabase.co", "k", session=s)
        rc, out = self.run_step(tc, env={"CHANNEL_ID": "default", "YOUTUBE_TOKEN_JSON": ENV_TOKEN},
                                channel=Channel("default", default=True))
        self.assertEqual(rc, 0)
        self.assertEqual([c[1] for c in s.calls], [{"p_channel_id": "default"}])
        path = self.base / "youtube_token.json"
        self.assertEqual(json.loads(path.read_text())["refresh_token"], REFRESH)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertIn(f"::add-mask::{REFRESH}", out.splitlines())
        self.assertNotIn(REFRESH, [l for l in out.splitlines() if not l.startswith("::add-mask::")].__str__())
        self.assertEqual(self.github_env.read_text(), "")      # no env var to blank: the secret is a file

    def test_the_default_channel_without_a_connection_leaves_the_secret_file_alone(self):
        (self.base / "youtube_token.json").write_text(ENV_TOKEN)
        rc, out = self.run_step(client(Resp(200, [])), env={"CHANNEL_ID": "default"}, channel=Channel("default", default=True))
        self.assertEqual(rc, 0)
        self.assertEqual((self.base / "youtube_token.json").read_text(), ENV_TOKEN)
        self.assertIn("using YOUTUBE_TOKEN_JSON, as before", out)

    def test_a_vault_outage_keeps_the_default_channels_secret_file_but_stops_when_there_is_none(self):
        (self.base / "youtube_token.json").write_text(ENV_TOKEN)
        rc, out = self.run_step(client(Resp(500, {"message": REFRESH})), env={"CHANNEL_ID": "default"},
                                channel=Channel("default", default=True))
        self.assertEqual(rc, 0)
        self.assertIn("::warning::", out)
        self.assertNotIn(REFRESH, out)
        self.assertEqual((self.base / "youtube_token.json").read_text(), ENV_TOKEN)
        (self.base / "youtube_token.json").unlink()
        rc, out = self.run_step(client(Resp(500, {})), env={"CHANNEL_ID": "default"}, channel=Channel("default", default=True))
        self.assertEqual(rc, 1)

    def test_a_connection_without_the_command_centers_oauth_client_stops_the_default_channel_before_it_spends(self):
        (self.base / "youtube_token.json").write_text(ENV_TOKEN)
        # No client pair in this environment (run_step always adds one): the old file must not be trusted silently.
        env = {"CHANNEL_ID": "default", "GITHUB_ENV": str(self.github_env)}
        out2 = io.StringIO()
        rc2 = restore.main(env, load_channel=Channel("default", default=True), client=client(Resp(200, [vault_row()])), out=out2)
        self.assertEqual(rc2, 1)
        self.assertIn("OAuth client", out2.getvalue())
        self.assertNotIn(REFRESH, out2.getvalue())

    def test_outage_without_a_secret_fails_the_step_without_the_token(self):
        rc, out = self.run_step(client(Resp(500, {"message": REFRESH})))
        self.assertEqual(rc, 1)
        self.assertNotIn(REFRESH, out)
        self.assertFalse(list(self.base.glob("youtube_token*.json")))

    def test_outage_with_a_secret_keeps_todays_path(self):
        rc, out = self.run_step(client(Resp(500, {})), env={"CHRONOS_YT_TOKEN_SHOP": ENV_TOKEN})
        self.assertEqual(rc, 0)
        self.assertFalse(list(self.base.glob("youtube_token*.json")))
        self.assertNotIn("GITHUBSECRETTOKEN", out)

    def test_unloadable_registry_is_not_this_steps_failure(self):
        def broken(_cid):
            raise KeyError("Unknown channel 'shop'")

        rc, out = self.run_step(client(Resp(200, [vault_row()])), channel=broken)
        self.assertEqual(rc, 0)
        self.assertIn("::warning::", out)

    def test_the_workflow_runs_it_for_every_channel_default_included_after_the_secret_steps(self):
        wf = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        step = wf.index("Restore YouTube token from Vault (connected from the Command Center)")
        self.assertLess(wf.index("Restore YouTube token (this channel)"), step)
        self.assertLess(wf.index("Restore YouTube token (default channel)"), step)
        self.assertLess(step, wf.index("- name: Restore YouTube client secret"))
        block = wf[step:wf.index("- name: Restore YouTube client secret")]
        self.assertNotIn("if:", block.split("env:")[0])      # no matrix gate: the default channel is covered too
        self.assertIn("python tools/restore_channel_token.py", block)
        self.assertIn("GOOGLE_OAUTH_CLIENT_SECRET", block)
        # The cleanup step still removes whatever it wrote.
        self.assertIn('rm -f -- "$GITHUB_WORKSPACE"/youtube_token*.json', wf)

    def test_the_intelligence_poll_reads_the_same_default_token_and_never_fails_on_it(self):
        wf = (ROOT / ".github" / "workflows" / "intelligence_poll.yml").read_text()
        step = wf.index("Restore YouTube token from Vault (default channel)")
        self.assertLess(wf.index("- name: Restore YouTube token\n"), step)
        block = wf[step:wf.index("- name: Restore YouTube client secret")]
        self.assertIn("CHANNEL_ID: default", block)
        self.assertIn("continue-on-error: true", block)
        self.assertIn("python tools/restore_channel_token.py", block)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
