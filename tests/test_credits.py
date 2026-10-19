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
import time
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import credits  # noqa: E402
from modules.budget import BUDGET_STOP_EXIT  # noqa: E402
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

    # A prices() outage at settlement: the whole run is planned as unpriced, once (documented in modules/credits.py).
    class PricesDown(FakeCredits):
        def prices(self):
            self.calls.append(("prices",))
            raise CreditsUnavailable("credit_prices: ReadTimeout")

    def test_a_prices_outage_charges_the_whole_hold_after_its_retries_never_a_guess(self):
        c, naps = self.PricesDown(), []
        with self.assertLogs("modules.credits", level="WARNING") as logs:
            note = credits.settle_hold(c, self.HOLD, succeeded=True, channel_id="news", since=None,
                                       ledger=lambda *_: [entry("tts_characters", 3000)], sleep=naps.append)
        self.assertEqual(c.settled(), [("capture", "r1", 40.0)])       # not the 3.0 the ledger would meter
        self.assertIn("unpriced", note)
        self.assertEqual([x for x in c.calls if x[0] == "prices"], [("prices",)] * credits.SETTLE_TRIES)
        self.assertEqual(naps, [2.0, 4.0])
        self.assertTrue(any("whole hold of 40.00 credits" in m for m in logs.output))

    def test_a_prices_outage_never_turns_a_failed_run_into_a_charge(self):
        c = self.PricesDown()
        credits.settle_hold(c, self.HOLD, succeeded=False, channel_id="news", since=None,
                            ledger=lambda *_: [entry("tts_characters", 3000)], sleep=lambda _s: None)
        self.assertEqual(c.settled(), [("release", "r1")])
        self.assertNotIn(("prices",), c.calls)                          # a release never reads the prices

    def test_a_prices_outage_decision_is_the_hold_even_when_the_capture_must_wait(self):
        # Both calls fail (the same database): the plan that is kept for the replay already says 40.0.
        c = FakeCredits(down=True)
        plan = credits.plan_settlement(c, self.HOLD, succeeded=True, channel_id="news", since=None,
                                       ledger=lambda *_: [entry("tts_characters", 3000)], sleep=lambda _s: None)
        self.assertEqual((plan.action, plan.amount), ("capture", 40.0))

    def test_unreachable_api_is_reported_not_guessed(self):
        self.assertIsNone(credits.settle_hold(FakeCredits(down=True), self.HOLD, succeeded=True,
                                              channel_id="news", since=None, ledger=lambda *_: [],
                                              sleep=lambda _s: None))

    # D7: one blip must not leave the hold open for the 24 h sweep to release.
    def test_a_transient_failure_is_retried_and_the_capture_goes_through(self):
        class Flaky(FakeCredits):
            fails = 2

            def capture(self, ref, amount):
                if self.fails:
                    self.fails -= 1
                    raise CreditsUnavailable("capture_credits: ReadTimeout")
                return super().capture(ref, amount)

        c, naps = Flaky(), []
        note = credits.settle_hold(c, self.HOLD, succeeded=True, channel_id="news", since=None,
                                   ledger=lambda *_: [entry("tts_characters", 3000)], sleep=naps.append)
        self.assertIn("metered", note)
        self.assertEqual(c.settled(), [("capture", "r1", 3.0)])
        self.assertEqual(naps, [2.0, 4.0])  # backs off between tries

    def test_a_transient_release_failure_is_retried(self):
        class Flaky(FakeCredits):
            fails = 1

            def release(self, ref):
                if self.fails:
                    self.fails -= 1
                    raise CreditsUnavailable("release_credits: ReadTimeout")
                return super().release(ref)

        c = Flaky()
        credits.settle_hold(c, self.HOLD, succeeded=False, channel_id="news", since=None,
                            sleep=lambda _s: None)
        self.assertEqual(c.settled(), [("release", "r1")])

    def test_gives_up_after_three_tries(self):
        c, naps = FakeCredits(down=True), []
        self.assertIsNone(credits.settle_hold(c, self.HOLD, succeeded=False, channel_id="news", since=None,
                                              sleep=naps.append))
        self.assertEqual(len(naps), credits.SETTLE_TRIES - 1)


# ── the worker ────────────────────────────────────────────────────────────

# Like the real main.py, a run that exits 0 leaves a video and tells the worker
# so (NIGHTSHIFT_RUN_RESULT_FILE); FAKE_NO_VIDEO plays "exited 0 with nothing".
FAKE_MAIN = (
    "import json, os, sys, time\n"
    "open('report.out', 'w').write('ran')\n"
    "rf = os.environ.get('NIGHTSHIFT_RUN_RESULT_FILE')\n"
    "if rf and not os.environ.get('FAKE_NO_VIDEO'):\n"
    "    open('final_video.mp4', 'wb').write(b'video')\n"
    "    json.dump({'slug': 's', 'video_path': os.path.abspath('final_video.mp4')}, open(rf, 'w'))\n"
    "time.sleep(float(os.environ.get('FAKE_SLEEP', '0')))\n"
    "sys.exit(int(os.environ.get('FAKE_RC', '0')))\n"
)


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
    # A customer's job as migration 0041 queues it: its hold, and the length
    # that hold was priced for (a minute: 25 credits at PRICES, under the 40 held).
    base = {"id": 9, "channel_id": "news", "kind": "daily", "params": {"duration": 60}, "attempts": 1,
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

    def run_one(self, j, fake, entries=(), **worker_kw):
        self.entries = list(entries)
        q = self.queue = FakeQueue([j])
        w = self.worker = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                                    resolve_channel=lambda cid: {"channel_id": cid, "is_default": False,
                                                                 "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                                    heartbeat_seconds=0.05, out=io.StringIO(), credits=fake,
                                    ledger_reader=self.ledger, **worker_kw)
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

    def test_the_sweep_also_expires_credit_lots_when_the_client_can(self):
        class WithLots(FakeCredits):
            def expire_lots(self):
                self.calls.append(("expire_lots",))
                return 0

        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        fake = WithLots()
        self.run_one(job(credit_ref=None), fake)
        # The sweep runs before the claim. (The job itself is then refused for
        # having no hold — migration 0041 — after looking up its organization.)
        self.assertEqual(fake.calls[:2], [("expire",), ("expire_lots",)])

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

    # -- D7: what a charge is for ------------------------------------------

    def test_exit_0_without_a_video_fails_the_job_and_releases_the_hold(self):
        # Used to capture the whole hold ("no_ledger"): a black cut, a budget
        # stop, anything that exited 0 with nothing to show was charged.
        self.env["FAKE_NO_VIDEO"] = "1"
        fake = FakeCredits()
        ends = self.run_one(job(), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("without producing a video", ends[0][1])
        self.assertEqual(fake.settled(), [("release", "rj-abc")])

    def test_an_api_balance_job_that_exits_0_without_a_video_is_failed_so_the_database_releases(self):
        class ApiCredits(FakeCredits):
            def api_hold_start(self, ref, job_id):
                self.calls.append(("api_hold_start", ref, job_id))
                return 12.0

        for no_video, status in ((True, "failed"), (False, "succeeded")):
            with self.subTest(no_video=no_video):
                self.env.pop("FAKE_NO_VIDEO", None)
                if no_video:
                    self.env["FAKE_NO_VIDEO"] = "1"
                fake = ApiCredits()
                ends = self.run_one(job(credit_ref=None, api_hold_ref="api-1"), fake)
                self.assertEqual(ends[0][0], status)
                self.assertEqual(fake.settled(), [])  # settled in the database, not here
                self.assertTrue((self.repo / "report.out").exists())

    def test_only_a_non_empty_video_the_result_file_names_counts(self):
        w = qw.Worker(FakeQueue([]), worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      credits=FakeCredits())
        video, result = self.repo / "final_video.mp4", self.repo / "r.json"
        result.write_text(json.dumps({"video_path": str(video)}))
        self.assertFalse(w._run_made_video(result))        # named, but not on disk
        video.write_bytes(b"")
        self.assertFalse(w._run_made_video(result))        # an empty file is not a video
        video.write_bytes(b"v")
        self.assertTrue(w._run_made_video(result))
        self.assertFalse(w._run_made_video(self.repo / "missing.json"))
        result.write_text("not json")
        self.assertFalse(w._run_made_video(result))

    def test_budget_stop_exit_fails_the_job_and_releases_the_hold(self):
        self.env["FAKE_RC"] = str(BUDGET_STOP_EXIT)
        self.env["FAKE_NO_VIDEO"] = "1"
        fake = FakeCredits()
        ends = self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("spend ceiling", ends[0][1])
        self.assertEqual(fake.settled(), [("release", "rj-abc")])

    def test_the_hold_is_settled_before_the_job_row_is_finished(self):
        # A kill between "succeeded" and the settlement left a delivered video
        # with an open hold, which the 24 h sweep then released.
        order = []
        fake = FakeCredits()
        fake.capture = lambda ref, amount: order.append("capture") or amount
        real_finish = FakeQueue.finish

        def finish(self_q, job_id, worker_id, status, error):
            order.append("finish")
            return real_finish(self_q, job_id, worker_id, status, error)
        with mock.patch.object(FakeQueue, "finish", finish):
            self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(order, ["capture", "finish"])

    def test_a_failed_run_is_released_before_its_row_is_failed_too(self):
        self.env["FAKE_RC"] = "2"
        order = []
        fake = FakeCredits()
        fake.release = lambda ref: order.append("release") or 40.0
        real_finish = FakeQueue.finish

        def finish(self_q, job_id, worker_id, status, error):
            order.append("finish")
            return real_finish(self_q, job_id, worker_id, status, error)
        with mock.patch.object(FakeQueue, "finish", finish):
            self.run_one(job(), fake)
        self.assertEqual(order, ["release", "finish"])

    def down_then_up(self):
        """A credits client whose capture/release fail until ``broken`` is cleared."""
        class Flaky(FakeCredits):
            broken = True

            def capture(self, ref, amount):
                if self.broken:
                    raise CreditsUnavailable("capture_credits: ReadTimeout")
                return super().capture(ref, amount)

            def release(self, ref):
                if self.broken:
                    raise CreditsUnavailable("release_credits: ReadTimeout")
                return super().release(ref)
        return Flaky()

    def marker(self):
        return self.repo / "output" / qw.PENDING_SETTLEMENTS_FILE

    def replay(self):
        self.worker._last_pending_retry = None
        self.worker._retry_pending_settlements()

    def test_a_settlement_that_cannot_reach_the_api_is_kept_and_retried(self):
        fake = self.down_then_up()
        with mock.patch.object(credits, "SETTLE_BACKOFF_SECONDS", 0.0):
            ends = self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(ends, [("succeeded", None)])  # the delivered video stays delivered
        self.assertEqual(fake.settled(), [])
        rows = json.loads(self.marker().read_text())
        self.assertEqual([(r["job_ref"], r["action"], r["amount_to_capture"]) for r in rows],
                         [("rj-abc", "capture", 5.0)])

        # The API is back: the loop's retry settles it from the marker and clears it.
        fake.broken = False
        self.replay()
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 5.0)])
        self.assertFalse(self.marker().exists())

    def test_a_replay_charges_the_amount_decided_at_the_end_of_that_job_not_a_fresh_ledger(self):
        # Job A's settlement is pending; job B then runs and records 30 credits'
        # worth of costs in the same local ledger. Replaying A must still capture
        # exactly A's 5.00 (it used to read the ledger again: 35.00).
        fake = self.down_then_up()
        with mock.patch.object(credits, "SETTLE_BACKOFF_SECONDS", 0.0):
            self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.entries = [entry("tts_characters", 5000), entry("tts_characters", 30000)]
        fake.broken = False
        self.replay()
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 5.0)])

    def test_a_pending_release_is_replayed_as_a_release_never_a_capture(self):
        self.env["FAKE_RC"] = "2"
        fake = self.down_then_up()
        with mock.patch.object(credits, "SETTLE_BACKOFF_SECONDS", 0.0):
            ends = self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(ends[0][0], "failed")
        self.assertEqual([r["action"] for r in json.loads(self.marker().read_text())], ["release"])
        fake.broken = False
        self.replay()
        self.assertEqual(fake.settled(), [("release", "rj-abc")])
        self.assertFalse(self.marker().exists())

    def pending_worker(self, fake):
        return qw.Worker(FakeQueue([]), worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                         credits=fake)

    @staticmethod
    def pending_row(**kw):
        row = {"job_id": 1, "job_ref": "rj-x", "org_id": CUSTOMER_ORG, "hold": 40.0, "action": "capture",
               "amount_to_capture": 5.0, "detail": "", "channel_id": "news", "at": qw._now()}
        row.update(kw)
        return row

    def test_a_pending_settlement_still_down_stays_pending(self):
        self.worker = w = self.pending_worker(FakeCredits(down=True))
        w._save_pending([self.pending_row()])
        with mock.patch.object(credits, "SETTLE_BACKOFF_SECONDS", 0.0):
            self.replay()
        self.assertEqual(len(w._load_pending()), 1)

    def test_a_pending_settlement_older_than_72_hours_is_dropped_with_an_error(self):
        fake = FakeCredits()
        self.worker = w = self.pending_worker(fake)
        old = (qw.datetime.now(qw.timezone.utc) - qw.timedelta(hours=73)).isoformat()
        w._save_pending([self.pending_row(at=old)])
        with self.assertLogs("queue_worker", level="ERROR") as logs:
            self.replay()
        self.assertTrue(any("giving up" in m and "rj-x" in m for m in logs.output))
        self.assertEqual(fake.settled(), [])
        self.assertEqual(w._load_pending(), [])

    def test_a_capture_that_comes_back_as_zero_is_reported_not_captured(self):
        class Expired(FakeCredits):
            def capture(self, ref, amount):
                self.calls.append(("capture", ref, amount))
                return 0.0  # the reservation was already released by the expiry sweep
        self.worker = w = self.pending_worker(Expired())
        w._save_pending([self.pending_row()])
        with self.assertLogs("modules.credits", level="ERROR") as logs:
            self.replay()
        self.assertTrue(any("took effect as 0" in m for m in logs.output))
        self.assertEqual(w._load_pending(), [])  # asking again would say the same

    def test_a_corrupt_pending_file_is_kept_aside_never_overwritten(self):
        self.worker = w = self.pending_worker(FakeCredits())
        (self.repo / "output").mkdir()
        self.marker().write_text('[{"job_ref": "rj-x", "action": "capt')  # truncated by a crash
        with self.assertLogs("queue_worker", level="ERROR") as logs:
            self.assertEqual(w._load_pending(), [])
        self.assertTrue(any("by hand" in m for m in logs.output))
        kept = list((self.repo / "output").glob(qw.PENDING_SETTLEMENTS_FILE + ".*.corrupt"))
        self.assertEqual(len(kept), 1)
        self.assertIn("rj-x", kept[0].read_text())
        w._save_pending([self.pending_row()])  # a new row does not touch the kept file
        self.assertIn("rj-x", kept[0].read_text())

    def test_the_hold_is_settled_before_the_row_ends_on_a_timeout_and_on_a_budget_stop(self):
        for label, env, kw in (("timeout", {"FAKE_SLEEP": "60"}, {"job_timeout_seconds": 1, "kill_after_seconds": 2}),
                               ("budget stop", {"FAKE_RC": str(BUDGET_STOP_EXIT), "FAKE_NO_VIDEO": "1"}, {})):
            with self.subTest(label):
                self.env = {"PATH": os.environ.get("PATH", ""), **env}
                order = []
                fake = FakeCredits()
                fake.release = lambda ref: order.append("release") or 40.0
                real_finish = FakeQueue.finish

                def finish(self_q, job_id, worker_id, status, error):
                    order.append("finish")
                    return real_finish(self_q, job_id, worker_id, status, error)
                with mock.patch.object(FakeQueue, "finish", finish):
                    self.run_one(job(), fake, **kw)
                self.assertEqual(order, ["release", "finish"])

    # -- a re-queued job whose credits the dead attempt already took ---------

    def requeued(self, *, status="captured", with_video=True, attempts=2):
        class Taken(FakeCredits):
            def reservation(self, ref):
                return {"status": status, "captured": 5}
        fake = Taken(hold=None)  # start_credit_reservation: not open any more
        result = self.repo / ".run_result_9.json"
        for stale in (result, self.repo / "final_video.mp4", self.repo / "report.out"):
            stale.unlink(missing_ok=True)
        if with_video:
            (self.repo / "final_video.mp4").write_bytes(b"v")
            result.write_text(json.dumps({"video_path": "final_video.mp4"}))  # relative: against repo_dir
        return fake, self.run_one(job(attempts=attempts), fake)

    def test_a_requeued_job_already_charged_with_its_video_on_disk_is_finished_succeeded(self):
        fake, ends = self.requeued()
        self.assertEqual(ends, [("succeeded", None)])
        self.assertFalse(self.ran())  # nothing was run again
        self.assertEqual(fake.settled(), [])

    def test_it_is_still_failed_when_the_charge_or_the_video_is_missing_or_it_is_the_first_attempt(self):
        for kw in ({"status": "released"}, {"with_video": False}, {"attempts": 1}):
            with self.subTest(**kw):
                _, ends = self.requeued(**kw)
                self.assertEqual(ends[0][0], "failed")
                self.assertIn("not open", ends[0][1])

    # -- the result file outlives a queue row that could not be finished ---------

    def result_path(self):
        return self.repo / ".run_result_9.json"

    def test_the_result_file_is_removed_once_the_row_is_finished(self):
        ends = self.run_one(job(), FakeCredits(), [entry("tts_characters", 5000)])
        self.assertEqual(ends, [("succeeded", None)])
        self.assertFalse(self.result_path().exists())

    def test_a_charged_run_whose_row_could_not_be_finished_keeps_its_result_file_and_is_not_failed_on_requeue(self):
        # Attempt 1: the video is made, the hold is captured, and the queue never answers the finish (down for all
        # its retries). The row stays "running" and the stale sweep re-queues it.
        fake = FakeCredits()
        with mock.patch.object(FakeQueue, "finish", lambda *a, **k: None), \
                mock.patch.object(qw.time, "sleep", lambda _s: None):
            self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 5.0)])
        self.assertTrue(self.result_path().exists(), "the only proof the video exists was deleted")
        (self.repo / "report.out").unlink()

        # Attempt 2: its hold is no longer open (captured). The kept file is what finishes it as delivered.
        class Taken(FakeCredits):
            def reservation(self, ref):
                return {"status": "captured", "captured": 5}
        again = Taken(hold=None)
        ends = self.run_one(job(attempts=2), again)
        self.assertEqual(ends, [("succeeded", None)])
        self.assertFalse(self.ran())                    # nothing was run twice
        self.assertEqual(again.settled(), [])           # and nothing was charged twice
        self.assertFalse(self.result_path().exists())   # finished for real this time: now it goes

    def test_a_delivered_requeue_whose_own_finish_is_lost_keeps_the_file_for_the_next_attempt(self):
        class Taken(FakeCredits):
            def reservation(self, ref):
                return {"status": "captured", "captured": 5}
        (self.repo / "final_video.mp4").write_bytes(b"v")
        self.result_path().write_text(json.dumps({"video_path": "final_video.mp4"}))
        with mock.patch.object(FakeQueue, "finish", lambda *a, **k: None), \
                mock.patch.object(qw.time, "sleep", lambda _s: None):
            self.run_one(job(attempts=2), Taken(hold=None))
        self.assertTrue(self.result_path().exists())

    def test_a_finish_answer_of_not_ours_keeps_the_file_too(self):
        # finish() answers False when the row is no longer this worker's (the stale sweep re-queued it while
        # the worker was cut off). The run was still captured by this worker, so the file is not deleted on
        # that answer either: only an explicit True (terminal and ours) releases it.
        fake = FakeCredits()
        with mock.patch.object(FakeQueue, "finish", lambda *a, **k: False):
            self.run_one(job(), fake, [entry("tts_characters", 5000)])
        self.assertEqual(fake.settled(), [("capture", "rj-abc", 5.0)])
        self.assertTrue(self.result_path().exists())
        (self.repo / "report.out").unlink()

        class Taken(FakeCredits):
            def reservation(self, ref):
                return {"status": "captured", "captured": 5}
        ends = self.run_one(job(attempts=2), Taken(hold=None))
        self.assertEqual(ends, [("succeeded", None)])
        self.assertFalse(self.ran())

    def test_a_requeued_attempt_that_is_refused_for_good_removes_the_kept_file(self):
        _, ends = self.requeued(status="released")          # not delivered: the hold was released
        self.assertEqual(ends[0][0], "failed")
        self.assertFalse(self.result_path().exists())

    def test_a_refused_requeue_whose_own_finish_is_lost_keeps_the_file(self):
        with mock.patch.object(FakeQueue, "finish", lambda *a, **k: None), \
                mock.patch.object(qw.time, "sleep", lambda _s: None):
            self.requeued(status="released")
        self.assertTrue(self.result_path().exists())

    def test_a_stale_unconfirmed_flag_from_an_earlier_job_does_not_keep_this_jobs_file(self):
        # A path that never calls _finish (the job is no longer ours mid-run) must not inherit the previous
        # job's "row unconfirmed": process() starts every job with the flag cleared.
        self.env["FAKE_SLEEP"] = "60"
        self.entries = []
        q = FakeQueue([])
        q.heartbeat = lambda job_id, worker_id: not self.result_path().exists()   # lost once the file is written
        w = qw.Worker(q, worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                      resolve_channel=lambda cid: {"channel_id": cid, "is_default": False,
                                                   "token_secret": "CHRONOS_YT_TOKEN_NEWS"},
                      heartbeat_seconds=0.05, out=io.StringIO(), credits=FakeCredits(),
                      ledger_reader=self.ledger, kill_after_seconds=1)
        w._row_unconfirmed = True
        self.assertEqual(w.process(job()), "lost")
        self.assertEqual(q.ends, [])                        # no finish was ever sent
        self.assertFalse(self.result_path().exists())

    # -- old result files are swept at start-up -----------------------------

    def aged(self, name, days):
        p = self.repo / name
        p.write_text("{}")
        t = time.time() - days * 86400
        os.utime(p, (t, t))
        return p

    def sweeper(self):
        return qw.Worker(FakeQueue([]), worker_id="w1", env=self.env, repo_dir=self.repo, prelude=[],
                         credits=FakeCredits(), out=io.StringIO())

    def test_start_up_sweeps_only_old_result_files(self):
        old = self.aged(".run_result_1.json", qw.RESULT_FILE_MAX_AGE_DAYS + 1)
        fresh = self.aged(".run_result_2.json", 0)
        other = self.aged("keep_me.json", 30)
        decoy = self.aged(".run_result_3.json.bak", 30)
        link = self.repo / ".run_result_4.json"
        link.symlink_to(other)
        os.utime(link, (time.time() - 30 * 86400,) * 2, follow_symlinks=False)
        self.assertEqual(self.sweeper()._sweep_old_result_files(), 1)
        self.assertFalse(old.exists())
        for kept in (fresh, other, decoy):
            self.assertTrue(kept.exists(), kept.name)
        self.assertTrue(link.is_symlink() and other.exists())

    def test_the_sweep_is_bounded_and_runs_when_the_worker_starts(self):
        for i in range(5):
            self.aged(f".run_result_{i}.json", 10)
        with mock.patch.object(qw, "RESULT_SWEEP_MAX", 2):
            self.assertEqual(self.sweeper()._sweep_old_result_files(), 2)
        self.assertEqual(len(list(self.repo.glob(".run_result_*.json"))), 3)
        self.sweeper().run_forever(once=True)                # start-up sweeps the rest
        self.assertEqual(list(self.repo.glob(".run_result_*.json")), [])

    # -- D3: a hung run ends the job and gives the credits back --------------

    def test_a_run_past_the_job_timeout_is_stopped_failed_and_released(self):
        self.env["FAKE_SLEEP"] = "60"
        fake = FakeCredits()
        started = time.monotonic()
        ends = self.run_one(job(), fake, job_timeout_seconds=1, kill_after_seconds=2)
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("timed out", ends[0][1])
        self.assertNotIn("WORKER_JOB_TIMEOUT_SECONDS", ends[0][1])  # customer-facing text
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

    # -- C2: a customer's job is paid for, whatever the env flag says -------

    def test_customer_job_without_a_hold_is_refused_even_when_not_enforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        fake = FakeCredits()
        ends = self.run_one(job(credit_ref=None), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("no credit reservation", ends[0][1])
        self.assertFalse(self.ran())
        self.assertEqual(fake.settled(), [])

    def test_customer_job_whose_hold_is_not_open_is_refused_even_when_not_enforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        ends = self.run_one(job(), FakeCredits(hold=None))
        self.assertEqual(ends[0][0], "failed")
        self.assertFalse(self.ran())

    def test_unreachable_credits_refuse_even_when_not_enforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        ends = self.run_one(job(), FakeCredits(down=True))
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("unavailable", ends[0][1])
        self.assertFalse(self.ran())

    def test_without_a_credits_client_nothing_runs_even_when_not_enforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        ends = self.run_one(job(credit_ref=None), None)
        self.assertEqual(ends[0][0], "failed")
        self.assertFalse(self.ran())

    def test_operators_own_job_runs_unpaid_when_not_enforced_as_before(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        fake = FakeCredits(org=credits.DEFAULT_ORG_ID)
        ends = self.run_one(job(credit_ref=None, channel_id="chronos", params={}), fake)
        self.assertEqual(ends, [("succeeded", None)])
        self.assertEqual(fake.settled(), [])

    # -- C1: the length the hold priced is the length that runs ------------

    def test_customer_job_without_its_frozen_length_is_refused_before_its_hold_starts(self):
        # Without params.duration main.py would read the channel's target at
        # run time — whatever the customer set it to after the hold.
        fake = FakeCredits()
        ends = self.run_one(job(params={}), fake)
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("length was not fixed", ends[0][1])
        self.assertFalse(self.ran())
        self.assertFalse(any(c[0] == "start" for c in fake.calls))

    def test_hold_below_the_frozen_length_is_refused_and_released_even_when_not_enforced(self):
        self.env.pop("NIGHTSHIFT_CREDITS_ENFORCE")
        fake = FakeCredits(hold=40.0)
        ends = self.run_one(job(params={"duration": 3600}), fake)  # 60 min = 1500 credits
        self.assertEqual(ends[0][0], "failed")
        self.assertIn("below the 1500.00", ends[0][1])
        self.assertFalse(self.ran())
        self.assertEqual(fake.settled(), [("release", "rj-abc")])


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

    def test_start_never_writes_an_organization_id_that_is_not_a_uuid(self):
        # GITHUB_ENV is line-oriented: a line break in a database value would
        # set a variable for every later step. The hold was claimed already,
        # so it is released through the normal path before the refusal.
        for org in (CUSTOMER_ORG + "\nBASH_ENV=/tmp/evil", "not-a-uuid", CUSTOMER_ORG + "\r"):
            fake = FakeCredits(org=org)
            self.assertEqual(credits_settle.start(self.env(), fake), 1)
            self.assertEqual(self.github_env.read_text(), "")
            self.assertEqual(fake.settled(), [("release", "gh-123")])

    def test_start_refusal_when_the_release_cannot_be_recorded_still_writes_nothing(self):
        class ReleaseDown(FakeCredits):
            def release(self, ref):
                raise CreditsUnavailable("release_credits: HTTP 503")

        self.assertEqual(credits_settle.start(self.env(), ReleaseDown(org="x\nPATH=/tmp")), 1)
        self.assertEqual(self.github_env.read_text(), "")

    def test_env_writer_refuses_multi_line_values(self):
        with self.assertRaises(ValueError):
            credits_settle._append_env(str(self.github_env), {"CREDITS_ORG": "a\nB=c"})
        self.assertEqual(self.github_env.read_text(), "")

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

    def test_expire_lots_calls_the_0034_rpc_with_no_arguments(self):
        s = self.Session(self.Resp(200, 1700))
        c = credits.CreditsRest("https://x.supabase.co", "service-secret", session=s)
        self.assertEqual(c.expire_lots(), 1700)
        url, body = s.posts[0]
        self.assertTrue(url.endswith("/rest/v1/rpc/expire_credit_lots"))
        self.assertEqual(body, {})

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
