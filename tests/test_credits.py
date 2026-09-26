"""Prepaid credits: what a finished run is charged, and when it may not start
(modules/credits.py, the worker and the Actions settle step around it).

What would break without these:

* a run with an unpriced ledger entry charged only its priced part — a silent
  undercharge that looks like a real price;
* a run that recorded nothing charged 0 instead of its hold;
* a charge above the reservation the customer agreed to;
* a failed run charged at all;
* a queued job inserted straight from a browser (no hold, or a token hold)
  running for free when enforcement is on;
* the operator's own channels (the default org) needing credits.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credits  # noqa: E402
from modules.credits import CreditRefused, CreditsUnavailable, Hold, Price  # noqa: E402
from tools import credits_settle  # noqa: E402
from tools import queue_worker as qw  # noqa: E402

CUSTOMER_ORG = "11111111-2222-3333-4444-555555555555"

PRICES = {
    "usd": Price(100.0, 0.5),               # 1 USD of real cost = 150 credits
    "tts_characters": Price(0.001, 0.0),    # a unit's own row beats `usd`
    "video_minute": Price(20.0, 0.25),
    "job_minimum": Price(5.0, 0.0),
}


def entry(unit, qty, usd=None, channel="news", at="2026-09-26T10:05:00+00:00"):
    return {"unit": unit, "quantity": qty, "estimated_usd": usd, "channel_id": channel,
            "recorded_at": at}


# ── pricing ────────────────────────────────────────────────────────────────

class Pricing(unittest.TestCase):
    def test_unset_or_negative_rate_is_unpriced_never_zero(self):
        p = credits.parse_prices([
            {"unit": "usd", "credits_per_unit": "100", "margin": "0.2"},
            {"unit": "render_seconds", "credits_per_unit": None},
            {"unit": "pexels_requests", "credits_per_unit": -1},
            {"unit": "", "credits_per_unit": 3},
            "garbage",
        ])
        self.assertEqual(set(p), {"usd"})
        self.assertAlmostEqual(p["usd"].charge(1), 120.0)

    def test_a_units_own_price_wins_over_usd(self):
        self.assertAlmostEqual(credits.entry_credits(entry("tts_characters", 2000, usd=0.6), PRICES), 2.0)

    def test_usd_prices_an_entry_only_when_it_was_priced_in_dollars(self):
        self.assertAlmostEqual(credits.entry_credits(entry("gemini_input_tokens", 1e5, usd=0.02), PRICES), 3.0)
        self.assertIsNone(credits.entry_credits(entry("gemini_input_tokens", 1e5, usd=None), PRICES))

    def test_special_rows_never_price_a_ledger_entry(self):
        self.assertIsNone(credits.entry_credits(entry("video_minute", 3), {"video_minute": Price(1.0)}))

    def test_enforcement_is_off_unless_explicitly_on(self):
        self.assertFalse(credits.enforcement_enabled({}))
        self.assertFalse(credits.enforcement_enabled({"NIGHTSHIFT_CREDITS_ENFORCE": "enforce"}))
        self.assertTrue(credits.enforcement_enabled({"NIGHTSHIFT_CREDITS_ENFORCE": " TRUE "}))

    def test_minimum_is_the_floor_or_the_requested_length(self):
        self.assertEqual(credits.minimum_reservation(PRICES), 5.0)
        self.assertEqual(credits.minimum_reservation(PRICES, 180), 75.0)  # 3 min * 20 * 1.25
        self.assertIsNone(credits.minimum_reservation({}, 180))


class Settlement(unittest.TestCase):
    def test_fully_priced_run_is_charged_what_it_used_rounded_up(self):
        s = credits.settle_amount(50, [entry("tts_characters", 2001), entry("render_seconds", 1, usd=0.0001)], PRICES)
        self.assertEqual((s.reason, s.amount), ("metered", 2.02))  # 2.001 + 0.015 -> 2.02

    def test_any_unpriced_entry_charges_the_hold_not_the_priced_floor(self):
        s = credits.settle_amount(40, [entry("tts_characters", 2000), entry("upload_bytes", 9e8)], PRICES)
        self.assertEqual((s.reason, s.amount), ("unpriced", 40.0))
        self.assertEqual(s.unpriced_units, ("upload_bytes",))

    def test_a_run_that_recorded_nothing_is_not_free(self):
        s = credits.settle_amount(40, [], PRICES)
        self.assertEqual((s.reason, s.amount), ("no_ledger", 40.0))

    def test_never_above_the_reservation(self):
        s = credits.settle_amount(10, [entry("render_seconds", 1, usd=1.0)], PRICES)
        self.assertEqual((s.reason, s.amount, s.metered), ("capped", 10.0, 150.0))

    def test_no_prices_at_all_charges_the_hold(self):
        s = credits.settle_amount(12.5, [entry("render_seconds", 1, usd=1.0)], {})
        self.assertEqual((s.reason, s.amount), ("unpriced", 12.5))

    def test_run_entries_are_this_channel_since_the_run_started(self):
        rows = [entry("a", 1), entry("b", 1, channel="other"),
                entry("c", 1, at="2026-09-26T09:59:59+00:00"), entry("d", 1, at="not a time")]
        got = credits.run_entries(rows, "news", "2026-09-26T10:00:00+00:00")
        self.assertEqual([r["unit"] for r in got], ["a"])


# ── the two ends of a run ─────────────────────────────────────────────────

class FakeCredits:
    """The service-key client, in memory."""

    def __init__(self, org=CUSTOMER_ORG, hold=40.0, prices=None, down=False):
        self.org = org
        self.hold = hold
        self.price_map = PRICES if prices is None else prices
        self.down = down
        self.calls = []

    def _check(self):
        if self.down:
            raise CreditsUnavailable("start_credit_reservation: HTTP 404 (is migration 0020 applied?)")

    def channel_org(self, channel_id):
        self._check()
        self.calls.append(("org", channel_id))
        return self.org

    def start(self, ref, org):
        self._check()
        self.calls.append(("start", ref, org))
        return self.hold

    def prices(self):
        self._check()
        return self.price_map

    def capture(self, ref, amount):
        self._check()
        self.calls.append(("capture", ref, amount))
        return amount

    def release(self, ref):
        self._check()
        self.calls.append(("release", ref))
        return self.hold

    def expire(self):
        self.calls.append(("expire",))
        return 0

    def settled(self):
        return [c for c in self.calls if c[0] in ("capture", "release")]


class OpenHold(unittest.TestCase):
    def test_default_org_is_exempt_even_when_enforced(self):
        c = FakeCredits(org=credits.DEFAULT_ORG_ID)
        self.assertIsNone(credits.open_hold(c, job_ref=None, channel_id="chronos", enforce=True))
        self.assertNotIn("start", [x[0] for x in c.calls])

    def test_enforced_run_without_a_hold_is_refused(self):
        with self.assertRaisesRegex(CreditRefused, "no credit reservation"):
            credits.open_hold(FakeCredits(), job_ref="", channel_id="news", enforce=True)

    def test_enforced_run_whose_hold_is_not_open_is_refused(self):
        with self.assertRaisesRegex(CreditRefused, "not open"):
            credits.open_hold(FakeCredits(hold=None), job_ref="r1", channel_id="news", enforce=True)

    def test_token_hold_below_the_requested_length_is_refused_and_released(self):
        c = FakeCredits(hold=10.0)
        with self.assertRaisesRegex(CreditRefused, "below the 75.00"):
            credits.open_hold(c, job_ref="r1", channel_id="news", duration_s=180, enforce=True)
        self.assertEqual(c.settled(), [("release", "r1")])

    def test_unreachable_credits_refuse_when_enforced(self):
        with self.assertRaisesRegex(CreditRefused, "unavailable"):
            credits.open_hold(FakeCredits(down=True), job_ref="r1", channel_id="news", enforce=True)

    def test_not_enforced_and_no_hold_touches_nothing(self):
        c = FakeCredits()
        self.assertIsNone(credits.open_hold(c, job_ref=None, channel_id="news", enforce=False))
        self.assertEqual(c.calls, [])

    def test_not_enforced_with_a_hold_still_settles_it(self):
        hold = credits.open_hold(FakeCredits(), job_ref="r1", channel_id="news", enforce=False)
        self.assertEqual(hold, Hold("r1", CUSTOMER_ORG, 40.0))


class SettleHold(unittest.TestCase):
    HOLD = Hold("r1", CUSTOMER_ORG, 40.0)

    def test_success_captures_the_metered_cost(self):
        c = FakeCredits()
        note = credits.settle_hold(c, self.HOLD, succeeded=True, channel_id="news", since=None,
                                   ledger=lambda ch, since: [entry("tts_characters", 3000)])
        self.assertEqual(c.settled(), [("capture", "r1", 3.0)])
        self.assertIn("metered", note)

    def test_failure_releases_everything(self):
        c = FakeCredits()
        credits.settle_hold(c, self.HOLD, succeeded=False, channel_id="news", since=None,
                            ledger=lambda ch, since: [entry("tts_characters", 3000)])
        self.assertEqual(c.settled(), [("release", "r1")])

    def test_unreadable_ledger_charges_the_hold(self):
        def broken(ch, since):
            raise OSError("disk")
        c = FakeCredits()
        credits.settle_hold(c, self.HOLD, succeeded=True, channel_id="news", since=None, ledger=broken)
        self.assertEqual(c.settled(), [("capture", "r1", 40.0)])

    def test_unreachable_api_is_reported_not_guessed(self):
        self.assertIsNone(credits.settle_hold(FakeCredits(down=True), self.HOLD, succeeded=True,
                                              channel_id="news", since=None, ledger=lambda *_: []))


# ── the worker ────────────────────────────────────────────────────────────

FAKE_MAIN = "import os, sys\nopen('report.out', 'w').write('ran')\nsys.exit(int(os.environ.get('FAKE_RC', '0')))\n"


class FakeQueue:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.ends = []

    def claim(self, worker_id, stale_minutes):
        return self.jobs.pop(0) if self.jobs else None

    def heartbeat(self, job_id, worker_id):
        return True

    def finish(self, job_id, worker_id, status, error):
        self.ends.append((status, error))
        return True

    def release(self, job_id, worker_id, *, status, attempts, error):
        self.ends.append(("released:" + status, error))
        return True


def job(**kw):
    base = {"id": 9, "channel_id": "news", "kind": "daily", "params": {}, "attempts": 1,
            "max_attempts": 3, "created_at": "2026-09-26T10:00:00+00:00", "credit_ref": "rj-abc"}
    base.update(kw)
    return base


class WorkerCredits(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "main.py").write_text(FAKE_MAIN)
        self.env = {"PATH": os.environ.get("PATH", ""), "NIGHTSHIFT_CREDITS_ENFORCE": "1"}
        self.ledger_calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def ledger(self, channel_id, since):
        self.ledger_calls.append((channel_id, since))
        return self.entries

    def run_one(self, j, fake, entries=()):
        self.entries = list(entries)
        q = FakeQueue([j])
        w = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False,
                                                   "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                      heartbeat_seconds=0.05, out=io.StringIO(), credits=fake,
                      ledger_reader=self.ledger)
        w.run_forever(once=True)
        return q.ends

    def ran(self):
        return (self.repo / "report.out").exists()

    def test_success_is_captured_from_the_ledger(self):
        fake = FakeCredits()
        ends = self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(ends, [("succeeded", None)])
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 5.0)])
        self.assertEqual(self.ledger_calls[0][0], "news")

    def test_unpriced_entry_captures_the_reservation(self):
        fake = FakeCredits()
        self.run_one(job(), fake, [entry("tts_characters", 5000), entry("upload_bytes", 1e9)])
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 40.0)])

    def test_failure_releases_and_never_captures(self):
        self.env["FAKE_RC"] = "2"
        fake = FakeCredits()
        ends = self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(ends[0][0], "failed")
        self.assertEqual(fake.settled(), [("release", "rj-abc")])

    def test_enforced_job_without_a_hold_fails_without_running(self):
        fake = FakeCredits()
        ends = self.run_one(job(credit_ref=None), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("nothing was run", ends[0][1])
        self.assertFalse(self.ran())
        self.assertEqual(fake.settled(), [])

    def test_default_org_job_runs_with_no_credits(self):
        fake = FakeCredits(org=credits.DEFAULT_ORG_ID)
        ends = self.run_one(job(credit_ref=None, channel_id="chronos"), fake)
        self.assertEqual(ends, [("succeeded", None)])
        self.assertEqual(fake.settled(), [])

    def test_enforced_without_a_credits_client_refuses(self):
        ends = self.run_one(job(), None)
        self.assertEqual(ends[0][0], "failed")
        self.assertFalse(self.ran())

    def test_not_enforced_worker_runs_unpaid_jobs_as_before(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        fake = FakeCredits()
        ends = self.run_one(job(credit_ref=None), fake)
        self.assertEqual(ends, [("succeeded", None)])
        self.assertEqual(fake.calls, [("expire",)])


# ── the Actions settle step ──────────────────────────────────────────────

class ActionsSettle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.github_env = Path(self.tmp.name) / "github_env"
        self.github_env.write_text("")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **kw):
        base = {"CREDIT_REF": "gh-123", "CHANNEL_ID": "news", "REQUESTED_CHANNEL": "news",
                "INPUT_DURATION": "", "GITHUB_ENV": str(self.github_env)}
        base.update(kw)
        return base

    def test_start_claims_and_hands_the_hold_to_settle(self):
        self.assertEqual(credits_settle.start(self.env(), FakeCredits()), 0)
        written = dict(line.split("=", 1) for line in self.github_env.read_text().splitlines())
        self.assertEqual(written["CREDITS_HOLD"], "40.00")
        self.assertEqual(written["CREDITS_ORG"], CUSTOMER_ORG)
        self.assertIn("CREDITS_SINCE", written)

    def test_start_refuses_a_fan_out_dispatch(self):
        self.assertEqual(credits_settle.start(self.env(REQUESTED_CHANNEL=""), FakeCredits()), 1)

    def test_start_refuses_a_closed_hold(self):
        self.assertEqual(credits_settle.start(self.env(), FakeCredits(hold=None)), 1)

    def test_start_refuses_a_malformed_reference(self):
        self.assertEqual(credits_settle.start(self.env(CREDIT_REF="x; rm -rf ~"), FakeCredits()), 1)

    def test_settle_success_captures_and_failure_releases(self):
        fake = FakeCredits()
        e = self.env(CREDITS_HOLD="40.00", CREDITS_ORG=CUSTOMER_ORG, RUN_OUTCOME="success")
        credits_settle.settle(e, fake, ledger=lambda ch, since: [entry("tts_characters", 1000)])
        credits_settle.settle(dict(e, RUN_OUTCOME="cancelled"), fake, ledger=lambda *_: [])
        self.assertEqual(fake.settled(), [("capture", "gh-123", 1.0), ("release", "gh-123")])

    def test_settle_without_a_claimed_hold_does_nothing(self):
        fake = FakeCredits()
        self.assertEqual(credits_settle.settle(self.env(RUN_OUTCOME="success"), fake), 0)
        self.assertEqual(fake.calls, [])


class Workflow(unittest.TestCase):
    """The credit steps bracket the run step, and a failed claim stops the run."""

    @classmethod
    def setUpClass(cls):
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "daily_video.yml").read_text())
        cls.steps = wf["jobs"]["make-video"]["steps"]
        cls.names = [s.get("name") for s in cls.steps]
        cls.inputs = wf[True]["workflow_dispatch"]["inputs"]

    def step(self, prefix):
        return next(s for s in self.steps if str(s.get("name", "")).startswith(prefix))

    def test_claim_runs_before_the_run_and_the_run_depends_on_it(self):
        claim = self.step("Claim credit reservation")
        run = self.step("Run Chronos bot")
        self.assertLess(self.names.index(claim["name"]), self.names.index(run["name"]))
        self.assertEqual(claim["id"], "credits_start")
        self.assertNotIn("if", run)  # success() by default: a failed claim skips the run
        self.assertEqual(self.inputs["credit_ref"]["default"], "")

    def test_settle_always_runs_after_a_claim_and_reads_the_run_outcome(self):
        settle = self.step("Settle credit reservation")
        self.assertIn("always()", settle["if"])
        self.assertIn("steps.credits_start.outcome == 'success'", settle["if"])
        self.assertEqual(settle["env"]["RUN_OUTCOME"], "${{ steps.run.outcome }}")

    def test_the_reference_never_reaches_the_shell_text(self):
        for prefix in ("Claim credit reservation", "Settle credit reservation"):
            self.assertNotIn("${{", self.step(prefix)["run"])


class CreditsRestClient(unittest.TestCase):
    class Resp:
        def __init__(self, status, body):
            self.status_code = status
            self._body = body

        def json(self):
            return self._body

    class Session:
        def __init__(self, resp):
            self.resp = resp
            self.posts = []

        def post(self, url, json=None, headers=None, timeout=None):
            self.posts.append((url, json))
            return self.resp

        def get(self, url, params=None, headers=None, timeout=None):
            self.posts.append((url, params))
            return self.resp

    def test_capture_calls_the_rpc_and_never_allows_over(self):
        s = self.Session(self.Resp(200, 12.5))
        c = credits.CreditsRest("https://x.supabase.co/", "service-secret", session=s)
        self.assertEqual(c.capture("r1", 12.341), 12.5)
        url, body = s.posts[0]
        self.assertTrue(url.endswith("/rest/v1/rpc/capture_credits"))
        self.assertEqual(body, {"p_job_id": "r1", "p_actual": 12.35, "p_allow_over": False})

    def test_http_error_names_the_status_not_the_body_or_key(self):
        s = self.Session(self.Resp(401, {"message": "service-secret leaked?"}))
        c = credits.CreditsRest("https://x.supabase.co", "service-secret", session=s)
        with self.assertRaises(CreditsUnavailable) as ctx:
            c.release("r1")
        self.assertIn("HTTP 401", str(ctx.exception))
        self.assertNotIn("service-secret", str(ctx.exception))


class Migration(unittest.TestCase):
    SQL = (ROOT / "supabase" / "migrations" / "0020_credits.sql").read_text()

    def test_settlement_functions_are_service_role_only(self):
        for fn in ("add_purchased_credits(uuid, numeric, text, text)", "capture_credits(text, numeric, boolean)",
                   "release_credits(text)", "start_credit_reservation(text, uuid)"):
            with self.subTest(fn=fn):
                self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated;", self.SQL)
                self.assertIn(f"grant execute on function public.{fn} to service_role;", self.SQL)

    def test_every_security_definer_function_pins_its_search_path(self):
        heads = re.findall(r"create or replace function (public\.\w+)\((.*?)\bas \$\$", self.SQL, re.S)
        self.assertGreater(len(heads), 8)
        for name, head in heads:
            if "security definer" in head:
                with self.subTest(fn=name):
                    self.assertIn("set search_path = public, pg_temp", head)

    def test_the_default_org_is_exempt_in_the_database_too(self):
        self.assertIn("select p_org is not distinct from public.default_org_id()", self.SQL)
        self.assertEqual(credits.DEFAULT_ORG_ID, "00000000-0000-0000-0000-000000000001")


if __name__ == "__main__":
    unittest.main()
