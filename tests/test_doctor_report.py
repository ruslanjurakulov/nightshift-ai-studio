"""The scheduled readiness check (tools/doctor_report.py, .github/workflows/doctor_scheduled.yml): what it records,
that it records no value, that its workflow holds no secret the daily run does not, and that the operator bot reads
what it wrote. Fakes only: no network, no provider."""

import re
import unittest
from datetime import datetime, timezone
from pathlib import Path

import yaml

from modules.operator_bot import alerts
from tests.operator_bot_fakes import FakeSync
from tests.test_reliability_alerts import iso, make
from tools import doctor, doctor_report

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)


def check(group, name, status, detail="", fix=""):
    return doctor.Check(group, name, status, detail, fix)


class RowTestCase(unittest.TestCase):
    def test_only_failures_outside_the_host_group_are_named(self):
        checks = [check("keys", "GEMINI_API_KEY", doctor.FAIL), check("keys", "PEXELS_API_KEY", doctor.PASS),
                  check("host", "ffmpeg", doctor.FAIL), check("host", "free disk", doctor.FAIL),
                  check("providers", "elevenlabs", doctor.WARN), check("youtube", "operator channel token", doctor.FAIL),
                  check("config", "key shapes", doctor.UNVERIFIED)]
        self.assertEqual(doctor_report.failing_names(checks), ["keys/GEMINI_API_KEY", "youtube/operator channel token"])

    def test_the_row_is_ok_or_fail_with_names_only_and_no_channel(self):
        ok = doctor_report.build_row([check("keys", "GEMINI_API_KEY", doctor.PASS)])
        self.assertEqual((ok["kind"], ok["title"], ok["body"]), ("operator.doctor", "ok", ""))
        bad = doctor_report.build_row([check("providers", "pexels", doctor.FAIL, "search check: Pexels refused the key",
                                             "update PEXELS_API_KEY")])
        self.assertEqual((bad["title"], bad["body"]), ("fail", "providers/pexels"))
        self.assertNotIn("channel_id", bad)
        self.assertNotIn("refused", str(bad))                    # the detail line never goes into the row

    def test_a_host_only_failure_is_an_ok_verdict(self):
        row = doctor_report.build_row([check("host", "ffmpeg", doctor.FAIL)])
        self.assertEqual(row["title"], "ok")

    def test_names_are_cut_capped_and_the_overflow_is_counted_not_dropped(self):
        names = [check("keys", f"KEY_{i:02d}_" + "X" * 30, doctor.FAIL) for i in range(12)]
        row = doctor_report.build_row(names)
        self.assertEqual(row["title"], "fail")
        self.assertLessEqual(len(row["body"]), doctor_report.MAX_BODY)
        parts = row["body"].split(",")
        self.assertEqual(parts[-1], "+6")                                    # six more failed than the row holds
        self.assertTrue(all(len(n) <= doctor_report.NAME_MAX for n in parts[:-1]))
        odd = doctor_report.failing_names([check("keys", "a,b <script>$TOKEN", doctor.FAIL)])
        self.assertEqual(odd, ["keys/ab scriptTOKEN"])

    def test_a_providers_own_hiccup_is_marked_transient_and_a_refusal_is_not(self):
        checks = [check("providers", "elevenlabs", doctor.FAIL, "subscription check: ElevenLabs rate-limited the check"),
                  check("providers", "pexels", doctor.FAIL, "search check: Pexels answered HTTP 503"),
                  check("providers", "leonardo", doctor.FAIL, "account check: Leonardo unreachable"),
                  check("providers", "gemini", doctor.FAIL, "Gemini refused the key"),
                  check("youtube", "operator channel token", doctor.FAIL, "Google says the refresh token is expired (invalid_grant)"),
                  check("keys", "GEMINI_API_KEY", doctor.FAIL, "missing - needed for script"),
                  check("providers", "x", doctor.FAIL, "answered HTTP 401")]
        self.assertEqual([(n, t) for n, t in doctor_report.failing(checks)],
                         [("providers/elevenlabs", True), ("providers/pexels", True), ("providers/leonardo", True),
                          ("providers/gemini", False), ("youtube/operator channel token", False),
                          ("keys/GEMINI_API_KEY", False), ("providers/x", False)])
        body = doctor_report.build_row(checks)["body"]
        self.assertTrue(body.startswith("~providers/elevenlabs,~providers/pexels,~providers/leonardo,providers/gemini"))


class PausedPipelineTestCase(unittest.TestCase):
    """The scheduled doctor reports a paused pipeline in its summary but never records it as a failing check."""

    def test_a_paused_pipeline_is_not_a_failing_check(self):
        checks = [check("pipeline", "scheduled runs", doctor.WARN, "paused", "remove the variable"),
                  check("keys", "GEMINI_API_KEY", doctor.PASS)]
        self.assertEqual(doctor_report.failing_names(checks), [])
        self.assertEqual(doctor_report.build_row(checks)["title"], "ok")

    def test_the_real_doctor_under_a_pause_records_ok_and_shows_the_check_in_ci(self):
        from tests.test_doctor import make_ctx
        env = {"NIGHTSHIFT_PIPELINE_PAUSED": "true", "GITHUB_ACTIONS": "true"}
        out, sync = [], FakeSync()
        rc = doctor_report.main(env=env, sync=sync, out=out.append,
                                run=lambda: doctor.run_checks(make_ctx(env), offline=True))
        self.assertEqual(rc, 0)
        (table, rows), = sync.upserts
        self.assertEqual((rows[0]["title"], rows[0]["body"]), ("ok", ""))
        text = "\n".join(out)
        self.assertIn("[WARN] pipeline/scheduled runs", text)       # visible in the job summary, name and verdict only
        self.assertNotIn("NIGHTSHIFT_PIPELINE_PAUSED", text)

    def test_the_bot_hears_no_readiness_alert_for_it(self):
        row = dict(doctor_report.build_row([check("pipeline", "scheduled runs", doctor.WARN)]), at=iso(NOW), channel_id=None)
        engine, _, _, ops, _ = make(now=NOW, channels=[], tables={"alert_events": [row]})
        self.assertEqual([a for a in alerts.detect(ops, 15000) if a.key.startswith("doctor:check")], [])


class MainTestCase(unittest.TestCase):
    def run_main(self, checks, sync, env=None, raising=False):
        out = []

        def run():
            if raising:
                raise RuntimeError("boom")
            return checks

        rc = doctor_report.main(env=env or {}, run=run, sync=sync, out=out.append)
        return rc, "\n".join(out)

    def test_a_failure_is_recorded_and_the_job_stays_green(self):
        sync = FakeSync()
        rc, text = self.run_main([check("youtube", "operator channel token", doctor.FAIL, "expired", "re-authorise")], sync)
        self.assertEqual(rc, 0)
        (table, rows), = sync.upserts
        self.assertEqual((table, rows[0]["kind"], rows[0]["title"]), ("alert_events", "operator.doctor", "fail"))
        self.assertIn("recorded: fail", text)

    def test_in_ci_only_names_and_verdicts_reach_the_log(self):
        detail = "key accepted, 8123 characters left (about 9 minutes of narration), plan status active, model gemini-2.5-pro"
        checks = [check("providers", "elevenlabs", doctor.PASS, detail),
                  check("providers", "gemini", doctor.FAIL, "Gemini has no model gemini-9-secret-preview", "set GEMINI_MODEL"),
                  check("host", "free disk", doctor.WARN, "4.5 GB free on the output volume")]
        rc, text = self.run_main(checks, FakeSync(), env={"GITHUB_ACTIONS": "true"})
        self.assertEqual(rc, 0)
        self.assertIn("[PASS] providers/elevenlabs", text)
        self.assertIn("[FAIL] providers/gemini", text)
        for leaked in ("8123", "characters", "plan status", "gemini-2.5", "gemini-9", "GEMINI_MODEL", "4.5 GB", "narration"):
            self.assertNotIn(leaked, text)
        local = self.run_main(checks, FakeSync(), env={})[1]
        self.assertIn("8123 characters left", local)                         # the full report stays for a local run

    def test_no_secret_value_reaches_the_log_or_the_row(self):
        secret = "sk-this-is-a-fake-provider-key-1234567890"
        env = {"GEMINI_API_KEY": secret}
        checks = [check("keys", "GEMINI_API_KEY", doctor.FAIL, f"refused {secret}", "rotate it")]
        sync = FakeSync()
        rc, text = self.run_main(checks, sync, env=env)
        self.assertNotIn(secret, text)
        self.assertNotIn(secret, str(sync.upserts))

    def test_without_supabase_nothing_can_be_told_so_the_job_goes_red(self):
        class Off:
            enabled = False

        rc, text = self.run_main([], Off())
        self.assertEqual(rc, 1)
        self.assertIn("not configured", text)

    def test_a_refused_or_failed_write_goes_red(self):
        class Refuses(FakeSync):
            def upsert(self, *a, **k):
                return 0

        class Raises(FakeSync):
            def upsert(self, *a, **k):
                raise RuntimeError("down")

        self.assertEqual(self.run_main([], Refuses())[0], 1)
        self.assertEqual(self.run_main([], Raises())[0], 1)

    def test_a_check_that_could_not_run_records_nothing(self):
        sync = FakeSync()
        rc, text = self.run_main([], sync, raising=True)
        self.assertEqual((rc, sync.upserts), (1, []))
        self.assertIn("could not run", text)

    def test_the_bot_reads_what_the_report_wrote(self):
        sync = FakeSync()
        self.run_main([check("providers", "elevenlabs", doctor.FAIL)], sync)
        row = dict(sync.upserts[0][1][0], at=iso(NOW), channel_id=None)
        engine, _, _, ops, _ = make(now=NOW, channels=[], tables={"alert_events": [row]})
        found = [a for a in alerts.detect(ops, 15000) if a.kind == "health"]
        self.assertEqual([a.key for a in found], ["doctor:check:providers-elevenlabs:2026-10-14"])


class WorkflowTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = yaml.safe_load((WORKFLOWS / "doctor_scheduled.yml").read_text())
        cls.daily = yaml.safe_load((WORKFLOWS / "daily_video.yml").read_text())
        cls.job = cls.doc["jobs"]["doctor"]
        cls.step = next(s for s in cls.job["steps"] if s.get("name") == "Readiness check")
        # Everything the daily video job hands to any of its steps: the run step and the token-restore steps.
        cls.daily_env = {}
        # The pause variable is read where the daily run picks its channels (the resolve job), not in make-video.
        for job in cls.daily["jobs"].values():
            for s in job.get("steps", []):
                for k, v in (s.get("env") or {}).items():
                    cls.daily_env[k] = f"{cls.daily_env.get(k, '')} {v}"

    def refs(self, expr):
        return set(re.findall(r"(?:secrets|vars)\.[A-Z0-9_]+", str(expr)))

    def test_it_runs_on_a_schedule_and_by_hand_with_least_privilege(self):
        on = self.doc.get("on") or self.doc.get(True)
        self.assertIn("schedule", on)
        self.assertIn("workflow_dispatch", on)
        self.assertEqual(self.doc["permissions"], {"contents": "read"})
        checkout = next(s for s in self.job["steps"] if str(s.get("uses", "")).startswith("actions/checkout"))
        self.assertIs(checkout["with"]["persist-credentials"], False)

    def test_it_holds_no_secret_or_variable_the_daily_run_does_not(self):
        daily_refs = set()
        for expr in self.daily_env.values():
            daily_refs |= self.refs(expr)
        for name, expr in self.step["env"].items():
            if name.startswith("DOCTOR_CHANNEL_TOKEN_"):
                # The scheduled channels' tokens: the daily run restores the same secrets per channel through
                # secrets[matrix.token_secret]; here they are read by the names the resolver job computed
                # (tests/test_doctor_channel_tokens.py pins the exact expressions).
                continue
            self.assertIn(name, self.daily_env, f"{name} is not passed to the daily run")
            self.assertTrue(self.refs(expr) <= self.refs(self.daily_env[name]),
                            f"{name} reads a source the daily run does not use for it")
        mine = set()
        for expr in self.step["env"].values():
            mine |= self.refs(expr)
        self.assertTrue(mine <= daily_refs, mine - daily_refs)

    def test_the_other_jobs_of_the_daily_workflow_widen_the_doctors_set_by_exactly_the_pause_variable(self):
        # The doctor's env may be judged against every daily job, but a future job must not widen what it may read
        # unnoticed: what the other jobs add over make-video is the pause variable and nothing else.
        make_video = set()
        for s in self.daily["jobs"]["make-video"]["steps"]:
            for v in (s.get("env") or {}).values():
                make_video |= self.refs(v)
        others = set()
        for name, job in self.daily["jobs"].items():
            if name != "make-video":
                for s in job.get("steps", []):
                    for v in (s.get("env") or {}).values():
                        others |= self.refs(v)
        self.assertEqual(others - make_video, {"vars.NIGHTSHIFT_PIPELINE_PAUSED"})

    def test_it_sees_the_pause_variable_the_scheduler_reads(self):
        self.assertEqual(self.step["env"]["NIGHTSHIFT_PIPELINE_PAUSED"], "${{ vars.NIGHTSHIFT_PIPELINE_PAUSED }}")

    def test_every_secret_the_doctor_judges_is_passed_to_it(self):
        wanted = set()
        for alts in doctor.VIDEO_KEYS.values():
            for alt in alts:
                wanted |= set(alt)
        wanted |= set(doctor.IMAGE_KEYS.values())
        wanted |= {"GEMINI_API_KEY", "PEXELS_API_KEY", "ELEVENLABS_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY",
                   "YOUTUBE_TOKEN_JSON", "YOUTUBE_CLIENT_SECRET_JSON", "YOUTUBE_CHANNEL_ID", "VIDIQ_ACCESS_TOKEN"}
        self.assertEqual(sorted(wanted - set(self.step["env"])), [])

    def test_no_expression_is_spliced_into_the_shell_and_nothing_is_dumped(self):
        script = self.step["run"]
        self.assertNotIn("${{", script)
        self.assertIn("tools/doctor_report.py", script)
        lines = [l.strip() for l in script.splitlines() if l.strip() and not l.strip().startswith("#")]
        self.assertEqual(lines[0], "set -o pipefail")                        # else tee swallows a failed report
        for forbidden in ("printenv", "set -x", "env |", "export -p"):
            self.assertNotIn(forbidden, script)

    def test_it_never_starts_a_video_run_or_calls_the_api(self):
        text = (WORKFLOWS / "doctor_scheduled.yml").read_text()
        for forbidden in ("main.py", "daily_video", "queue_worker", "gh api", "curl ", "workflow_run", "pull_request"):
            self.assertNotIn(forbidden, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))


if __name__ == "__main__":
    unittest.main()
