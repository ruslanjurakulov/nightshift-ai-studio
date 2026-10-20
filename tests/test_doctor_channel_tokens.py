"""The scheduled doctor proves EVERY scheduled operator channel's YouTube token, not only the default's (audit H2).

Before: ``check_youtube`` refreshed ``YOUTUBE_TOKEN_JSON`` (the default channel) and the workflow header said
"other operator channels' tokens cannot be proven". A second operator channel's token could die for a week and
the first anyone heard was an upload that failed after the render was paid for.

Now the secret name of each scheduled operator channel is derived by the function the publishing side uses
(``channel_credentials.env_var_name``, via ``tools/list_channels.py``), the workflow hands the doctor that many
secrets by name, and the doctor refreshes each one in memory (free, nothing saved). A scheduled channel whose
secret is not set is a FAIL. The check stays free of paid calls and, in CI, prints names and verdicts only.

No network: HTTP is the doctor's own fake.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import yaml

from modules.channels import DEFAULT_ORG_ID, ChannelContext, ChannelRegistry
from tests.test_doctor import FakeHttp, NOW, make_ctx, one
from tools import doctor as d
from tools import doctor_report as dr
from tools import list_channels
from tools.doctor import FAIL, PASS, SKIP, WARN, Resp

CUSTOMER_ORG = "8710f2b3-bcd6-4c90-a992-cbc329af93bb"
WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
REFRESH_A, SECRET_A = "1//SECRET-refresh-A", "GOCSPX-client-secret-A"
REFRESH_B, SECRET_B = "1//SECRET-refresh-B", "GOCSPX-client-secret-B"


def row(channel_id, org_id=DEFAULT_ORG_ID, status="ACTIVE", enabled=True, ref=None):
    r = {"channel_id": channel_id, "name": channel_id, "niche": "tech", "status": status, "org_id": org_id,
         "schedule_config": {"enabled": enabled, "publish_hour_utc": 15},
         "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z",
                            **({"ref": ref} if ref else {})}}
    return r


def registry(*rows):
    return ChannelRegistry([ChannelContext.from_dict(r) for r in rows])


def token(refresh, secret):
    return json.dumps({"refresh_token": refresh, "client_id": "cid", "client_secret": secret,
                       "token_uri": "https://evil.example/token"})


ROWS = [{"channel_id": "finance", "token_secret": "CHRONOS_YT_TOKEN_FINANCE"},
        {"channel_id": "news", "token_secret": "CHRONOS_YT_TOKEN_NEWS_DESK"}]


class TokenRowsTestCase(unittest.TestCase):
    """tools/list_channels.token_rows: which channels the doctor must prove, and under which secret name."""

    def test_only_active_scheduled_operator_channels_other_than_the_default(self):
        reg = registry(
            row("default"), row("finance"), row("news", ref="news-desk"),
            row("paused-one", status="PAUSED"), row("unscheduled", enabled=False),
            row("customer-chan", org_id=CUSTOMER_ORG))
        rows = list_channels.token_rows(registry=reg)
        self.assertEqual([r["channel_id"] for r in rows], ["finance", "news"])

    def test_the_secret_name_is_the_one_the_publishing_side_reads(self):
        from modules.channel_credentials import env_var_name

        reg = registry(row("default"), row("finance"), row("news", ref="news-desk"))
        rows = {r["channel_id"]: r["token_secret"] for r in list_channels.token_rows(registry=reg)}
        self.assertEqual(rows, {"finance": env_var_name(reg.get("finance")), "news": env_var_name(reg.get("news"))})
        self.assertEqual(rows["finance"], "CHRONOS_YT_TOKEN_FINANCE")
        self.assertEqual(rows["news"], "CHRONOS_YT_TOKEN_NEWS_DESK")

    def test_the_rows_carry_names_and_nothing_else(self):
        rows = list_channels.token_rows(registry=registry(row("default"), row("finance")))
        self.assertEqual(set(rows[0]), {"channel_id", "token_secret"})

    def test_an_unreadable_registry_raises_instead_of_looking_empty(self):
        class Boom:
            enabled = True

            def select_strict(self, table, params=None):
                raise RuntimeError("down https://x.supabase.co key=SECRET")

        with self.assertRaises(RuntimeError):
            list_channels.token_rows(sync=Boom())

    def test_slot_lines_for_the_workflow_are_single_lines_of_names(self):
        reg = registry(row("default"), row("finance"), row("news", ref="news-desk"))
        lines = list_channels.token_slot_lines(6, registry=reg)
        self.assertEqual(len(lines), 7)
        self.assertTrue(lines[0].startswith("rows="))
        self.assertEqual(json.loads(lines[0][5:]), list_channels.token_rows(registry=reg))
        self.assertEqual(lines[1:], ["name0=CHRONOS_YT_TOKEN_FINANCE", "name1=CHRONOS_YT_TOKEN_NEWS_DESK",
                                     "name2=", "name3=", "name4=", "name5="])
        for line in lines:
            self.assertNotIn("\n", line)

    def test_more_channels_than_slots_are_all_in_rows_but_only_slots_get_names(self):
        reg = registry(row("default"), *[row(f"ch{i}") for i in range(8)])
        lines = list_channels.token_slot_lines(6, registry=reg)
        self.assertEqual(len(json.loads(lines[0][5:])), 8)
        self.assertEqual(len([l for l in lines[1:] if not l.endswith("=")]), 6)


def ctx_for(rows, tokens, routes=None, **kw):
    """Env mode: the registry hook supplies the rows, the tokens are in the environment."""
    env = dict(tokens)
    ctx = make_ctx(env, routes if routes is not None else [("POST", "oauth2.googleapis.com/token", Resp(200, {"access_token": "a"}))], **kw)
    ctx.channel_rows = (lambda: rows)
    return ctx


class CheckChannelTokensTestCase(unittest.TestCase):
    def test_every_scheduled_channels_token_is_refreshed_with_its_own_secret(self):
        ctx = ctx_for(ROWS, {"CHRONOS_YT_TOKEN_FINANCE": token(REFRESH_A, SECRET_A),
                             "CHRONOS_YT_TOKEN_NEWS_DESK": token(REFRESH_B, SECRET_B)})
        out = d.check_channel_tokens(ctx)
        self.assertEqual([(c.group, c.name, c.status) for c in out],
                         [("token", "finance", PASS), ("token", "news", PASS)])
        sent = [(c[1], c[4]["refresh_token"], c[4]["client_secret"]) for c in ctx.http.calls]
        self.assertEqual(sent, [(d.YOUTUBE_TOKEN_URI, REFRESH_A, SECRET_A), (d.YOUTUBE_TOKEN_URI, REFRESH_B, SECRET_B)])

    def test_a_missing_secret_for_a_scheduled_channel_is_a_failing_check_naming_the_channel(self):
        ctx = ctx_for(ROWS, {"CHRONOS_YT_TOKEN_NEWS_DESK": token(REFRESH_B, SECRET_B)})
        out = d.check_channel_tokens(ctx)
        finance = one(out, "finance")
        self.assertEqual(finance.status, FAIL)
        self.assertIn("CHRONOS_YT_TOKEN_FINANCE", finance.fix)             # the fix names the secret to add
        self.assertIn("no token secret", finance.detail)                  # said as missing, not as malformed
        self.assertIn("add the GitHub Actions secret", finance.fix)
        self.assertEqual(one(out, "news").status, PASS)
        self.assertEqual(len(ctx.http.calls), 1)                            # nothing to refresh for the empty one

    def test_a_token_that_cannot_be_used_is_a_fail_without_a_call(self):
        for bad in ("not json", "[]", json.dumps({"client_id": "c", "client_secret": "s"}),
                    json.dumps({"refresh_token": REFRESH_A})):
            with self.subTest(bad=bad[:12]):
                ctx = ctx_for(ROWS[:1], {"CHRONOS_YT_TOKEN_FINANCE": bad})
                self.assertEqual(d.check_channel_tokens(ctx)[0].status, FAIL)
                self.assertEqual(ctx.http.calls, [])

    def test_a_token_without_its_own_client_pair_is_a_fail_whatever_the_environment_holds(self):
        # The run reads client_id / client_secret from the token file alone (youtube_token_check._read_token)
        # and refuses a file without them, so the doctor must not pass what the run would stop on.
        env = {"YOUTUBE_CLIENT_SECRET_JSON": json.dumps({"installed": {"client_id": "env-cid", "client_secret": "env-sec"}}),
               "GOOGLE_OAUTH_CLIENT_ID": "env-cid", "GOOGLE_OAUTH_CLIENT_SECRET": "env-sec"}
        for name, doc in (("no client at all", {"refresh_token": REFRESH_A}),
                          ("no secret", {"refresh_token": REFRESH_A, "client_id": "cid"}),
                          ("no id", {"refresh_token": REFRESH_A, "client_secret": SECRET_A}),
                          ("blank refresh token", {"refresh_token": "  ", "client_id": "cid", "client_secret": SECRET_A})):
            with self.subTest(name):
                ctx = ctx_for(ROWS[:1], {"CHRONOS_YT_TOKEN_FINANCE": json.dumps(doc), **env})
                out = d.check_channel_tokens(ctx)
                self.assertEqual([c.status for c in out], [FAIL])
                self.assertEqual(ctx.http.calls, [])

    def test_google_refusing_the_token_is_a_fail_and_a_blip_is_a_warning(self):
        cases = [(Resp(400, {"error": "invalid_grant"}), FAIL), (Resp(401, {"error": "invalid_client"}), FAIL),
                 (Resp(503, None), WARN), (Resp(429, {"error": "x"}), WARN), (Resp(None), WARN)]
        for resp, want in cases:
            with self.subTest(resp=resp.status):
                ctx = ctx_for(ROWS[:1], {"CHRONOS_YT_TOKEN_FINANCE": token(REFRESH_A, SECRET_A)},
                              [("POST", "oauth2", resp)])
                self.assertEqual(d.check_channel_tokens(ctx)[0].status, want)

    def test_no_youtube_flag_skips_every_post(self):
        ctx = ctx_for(ROWS, {"CHRONOS_YT_TOKEN_FINANCE": token(REFRESH_A, SECRET_A)}, youtube=False)
        self.assertEqual({c.status for c in d.check_channel_tokens(ctx)} - {FAIL}, {SKIP})
        self.assertEqual(ctx.http.calls, [])

    def test_nothing_scheduled_besides_the_default_is_no_checks(self):
        ctx = ctx_for([], {})
        self.assertEqual(d.check_channel_tokens(ctx), [])
        self.assertEqual(ctx.http.calls, [])

    def test_without_a_registry_hook_the_check_is_silent(self):
        ctx = make_ctx({})
        self.assertIsNone(ctx.channel_rows)
        self.assertEqual(d.check_channel_tokens(ctx), [])

    def test_an_unreadable_registry_is_one_warning_not_a_pass(self):
        ctx = make_ctx({})
        ctx.channel_rows = lambda: (_ for _ in ()).throw(RuntimeError("down ya29.SECRET"))
        out = d.check_channel_tokens(ctx)
        self.assertEqual([(c.group, c.status) for c in out], [("token", WARN)])
        self.assertNotIn("SECRET", out[0].detail + out[0].fix)

    def test_no_paid_call_and_only_the_token_post(self):
        ctx = ctx_for(ROWS, {"CHRONOS_YT_TOKEN_FINANCE": token(REFRESH_A, SECRET_A),
                             "CHRONOS_YT_TOKEN_NEWS_DESK": token(REFRESH_B, SECRET_B)})
        d.check_channel_tokens(ctx)
        self.assertEqual({(c[0], c[1]) for c in ctx.http.calls}, {("POST", d.YOUTUBE_TOKEN_URI)})


def ci_ctx(rows, slots, routes=None, **kw):
    """CI mode: the workflow put the rows and the slot secrets in the environment."""
    env = {"DOCTOR_CHANNEL_TOKEN_ROWS": json.dumps(rows) if rows is not None else ""}
    env.update({f"DOCTOR_CHANNEL_TOKEN_{i}": v for i, v in enumerate(slots)})
    ctx = make_ctx(env, routes if routes is not None else [("POST", "oauth2", Resp(200, {"access_token": "a"}))], **kw)
    ctx.channel_rows = lambda: (_ for _ in ()).throw(AssertionError("CI mode must not read the registry"))
    return ctx


class CiModeTestCase(unittest.TestCase):
    def test_slots_are_matched_to_rows_by_position(self):
        ctx = ci_ctx(ROWS, [token(REFRESH_A, SECRET_A), token(REFRESH_B, SECRET_B)])
        out = d.check_channel_tokens(ctx)
        self.assertEqual([(c.name, c.status) for c in out], [("finance", PASS), ("news", PASS)])
        self.assertEqual([c[4]["refresh_token"] for c in ctx.http.calls], [REFRESH_A, REFRESH_B])

    def test_an_empty_slot_is_a_missing_secret(self):
        out = d.check_channel_tokens(ci_ctx(ROWS, [token(REFRESH_A, SECRET_A), ""]))
        self.assertEqual([(c.name, c.status) for c in out], [("finance", PASS), ("news", FAIL)])

    def test_rows_that_could_not_be_listed_are_a_warning_not_silence(self):
        for rows in (None, ):
            out = d.check_channel_tokens(ci_ctx(rows, []))
            self.assertEqual([(c.group, c.status) for c in out], [("token", WARN)])
        ctx = ci_ctx(None, [])
        ctx.env = {**ctx.env, "DOCTOR_CHANNEL_TOKEN_ROWS": "{not json"}
        self.assertEqual([c.status for c in d.check_channel_tokens(ctx)], [WARN])
        ctx.env = {**ctx.env, "DOCTOR_CHANNEL_TOKEN_ROWS": json.dumps({"a": 1})}
        self.assertEqual([c.status for c in d.check_channel_tokens(ctx)], [WARN])

    def test_an_empty_list_is_nothing_to_check(self):
        self.assertEqual(d.check_channel_tokens(ci_ctx([], [])), [])

    def test_channels_beyond_the_slots_are_said_to_be_unchecked(self):
        many = [{"channel_id": f"ch{i}", "token_secret": f"CHRONOS_YT_TOKEN_CH{i}"} for i in range(d.CHANNEL_TOKEN_SLOTS + 2)]
        out = d.check_channel_tokens(ci_ctx(many, [token(REFRESH_A, SECRET_A)] * d.CHANNEL_TOKEN_SLOTS))
        self.assertEqual([c.status for c in out].count(PASS), d.CHANNEL_TOKEN_SLOTS)
        rest = [c for c in out if c.status == WARN]
        self.assertEqual([c.name for c in rest], ["ch6", "ch7"])

    def test_a_row_with_a_secret_name_of_the_wrong_shape_is_not_trusted(self):
        bad = [{"channel_id": "x", "token_secret": "PATH"}, {"channel_id": "y", "token_secret": "SUPABASE_SERVICE_KEY"}]
        out = d.check_channel_tokens(ci_ctx(bad, [token(REFRESH_A, SECRET_A)] * 2))
        self.assertEqual({c.status for c in out}, {WARN})

    def test_the_default_channel_is_not_in_the_rows_and_keeps_its_own_check(self):
        ctx = make_ctx({"YOUTUBE_TOKEN_JSON": token(REFRESH_A, SECRET_A), "YOUTUBE_CHANNEL_ID": "UCx"},
                       [("POST", "oauth2", Resp(200, {"access_token": "a"}))])
        self.assertEqual(one(d.check_youtube(ctx), "operator channel token").status, PASS)


class OutputHygieneTestCase(unittest.TestCase):
    SECRETS = (REFRESH_A, SECRET_A, REFRESH_B, SECRET_B, "evil.example")

    def checks(self):
        ctx = ci_ctx(ROWS, [token(REFRESH_A, SECRET_A), token(REFRESH_B, SECRET_B)],
                     [("POST", "oauth2", Resp(400, {"error": "invalid_grant", "error_description": REFRESH_A}))])
        self.ctx = ctx
        return d.check_channel_tokens(ctx)

    def test_no_secret_in_the_report_the_json_or_the_ci_summary(self):
        checks = self.checks()
        for text in (d.render(checks, self.ctx.env), d.to_json(checks, self.ctx.env), dr.ci_summary(checks),
                     json.dumps(dr.build_row(checks))):
            for secret in self.SECRETS:
                self.assertNotIn(secret, text)

    def test_ci_output_is_names_and_verdicts_only(self):
        summary = dr.ci_summary(self.checks())
        self.assertEqual(summary.splitlines()[1:], ["[FAIL] token/finance", "[FAIL] token/news"])

    def test_the_alert_row_names_the_channel_and_nothing_else(self):
        row_ = dr.build_row(self.checks())
        self.assertEqual((row_["title"], row_["body"]), ("fail", "token/finance,token/news"))

    def test_a_missing_secret_is_the_channel_id_only_in_ci(self):
        out = d.check_channel_tokens(ci_ctx(ROWS, [token(REFRESH_A, SECRET_A), ""]))
        self.assertIn("[FAIL] token/news", dr.ci_summary(out))
        self.assertEqual(dr.failing_names(out), ["token/news"])


class RunChecksTestCase(unittest.TestCase):
    def test_online_run_includes_the_channel_tokens_and_offline_does_not(self):
        ctx = ctx_for(ROWS, {"CHRONOS_YT_TOKEN_FINANCE": token(REFRESH_A, SECRET_A),
                             "CHRONOS_YT_TOKEN_NEWS_DESK": token(REFRESH_B, SECRET_B)})
        names = [c.name for c in d.run_checks(ctx)]
        self.assertIn("finance", names)
        self.assertNotIn("finance", [c.name for c in d.run_checks(ctx, offline=True)])

    def test_a_check_that_crashes_cannot_hide_the_others(self):
        ctx = ctx_for(ROWS, {})
        ctx.channel_rows = lambda: 1 / 0
        out = d.run_checks(ctx)
        self.assertTrue(any(c.group == "youtube" for c in out))


class WorkflowTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (WORKFLOWS / "doctor_scheduled.yml").read_text()
        cls.doc = yaml.safe_load(cls.text)
        cls.step = next(s for s in cls.doc["jobs"]["doctor"]["steps"] if s.get("name") == "Readiness check")

    def test_the_doctor_job_gets_one_secret_per_slot_by_the_name_the_resolver_computed(self):
        slots = {k: v for k, v in self.step["env"].items() if k.startswith("DOCTOR_CHANNEL_TOKEN_") and k[-1].isdigit()}
        self.assertEqual(sorted(slots), [f"DOCTOR_CHANNEL_TOKEN_{i}" for i in range(d.CHANNEL_TOKEN_SLOTS)])
        for i in range(d.CHANNEL_TOKEN_SLOTS):
            self.assertEqual(
                slots[f"DOCTOR_CHANNEL_TOKEN_{i}"],
                "${{ secrets[startsWith(needs.resolve.outputs.name%d, 'CHRONOS_YT_TOKEN_') && "
                "needs.resolve.outputs.name%d || 'DOCTOR_NO_SUCH_SECRET'] }}" % (i, i))

    def test_the_rows_variable_is_always_present_so_ci_mode_is_unambiguous(self):
        self.assertEqual(self.step["env"]["DOCTOR_CHANNEL_TOKEN_ROWS"], "${{ needs.resolve.outputs.rows }}")

    def test_the_resolver_exposes_exactly_the_slots_the_doctor_reads(self):
        resolve = self.doc["jobs"]["resolve"]
        self.assertEqual(set(resolve["outputs"]), {"rows"} | {f"name{i}" for i in range(d.CHANNEL_TOKEN_SLOTS)})
        run = next(s for s in resolve["steps"] if s.get("id") == "pick")["run"]
        self.assertIn(f"--token-slots {d.CHANNEL_TOKEN_SLOTS}", run)

    def test_the_doctor_still_runs_when_the_resolver_fails(self):
        job = self.doc["jobs"]["doctor"]
        self.assertEqual(job["needs"], "resolve")
        self.assertIn("always()", str(job["if"]))

    def test_the_resolver_holds_only_the_registry_secrets_and_no_token(self):
        env = next(s for s in self.doc["jobs"]["resolve"]["steps"] if s.get("id") == "pick")["env"]
        self.assertEqual(set(env), {"SUPABASE_URL", "SUPABASE_SERVICE_KEY"})

    def test_least_privilege_and_no_expression_in_any_script(self):
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        for job in self.doc["jobs"].values():
            for s in job["steps"]:
                self.assertNotIn("${{", s.get("run", ""))

    def test_the_header_no_longer_claims_other_tokens_cannot_be_proven(self):
        self.assertNotIn("only the default channel's token is", self.text)


if __name__ == "__main__":
    unittest.main()
