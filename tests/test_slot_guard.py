"""tools/slot_guard.py: the question asked again inside the run, once the job holds its concurrency group.

Exit 3 = the slot was already worked (nothing is spent); 0 = go. An unknown is a go for an exact-hour run (as it
has always been) and a stop for a catch-up (an unknown must never start a paid run). Offline: the "Supabase" is
the fake from test_schedule_catchup.
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import unittest
from unittest import mock

from modules import schedule_catchup
from tests.test_schedule_catchup import CUSTOMER_ORG, FakeSupabase, at, chan, iso, registry, video, warning_lines
from tools import list_channels, slot_guard

SLOT = "2026-10-20T15:00:00Z"
OWN = object()


def decide(sync, *, catchup=False, slot=SLOT, now=at(20, 17, 30), registry_=OWN, env=None, channel="default"):
    """The guard's verdict and everything it printed. The environment is controlled (no pause unless asked, no
    real Supabase) and logging is off, so the result does not depend on the runner."""
    if registry_ is OWN:
        registry_ = registry(chan("default", hour=15))
    clean = {k: v for k, v in os.environ.items()
             if k not in (list_channels.PAUSE_ENV, "SUPABASE_URL", "SUPABASE_SERVICE_KEY")}
    clean.update(env or {})
    err, out = io.StringIO(), io.StringIO()
    logging.disable(logging.CRITICAL)
    try:
        with mock.patch.dict(os.environ, clean, clear=True), contextlib.redirect_stderr(err), \
                contextlib.redirect_stdout(out):
            rc = slot_guard.decide(channel, slot, catchup, sync=sync, now=now, registry=registry_)
    finally:
        logging.disable(logging.NOTSET)
    return rc, out.getvalue() + err.getvalue()


class TheGuard(unittest.TestCase):
    def setUp(self):
        self.chan = chan("default", hour=15)

    def test_a_worked_slot_is_a_skip_for_both_kinds_of_run(self):
        sync = FakeSupabase([self.chan], videos=[video("default", published=iso(at(20, 15, 40)))])
        for catchup in (False, True):
            self.assertEqual(decide(sync, catchup=catchup)[0], slot_guard.SKIP)

    def test_a_free_slot_is_a_go_for_both_kinds_of_run(self):
        sync = FakeSupabase([self.chan])
        for catchup in (False, True):
            self.assertEqual(decide(sync, catchup=catchup)[0], slot_guard.GO)

    def test_the_run_that_finished_ahead_of_us_is_seen(self):
        # The point of asking again: it was free when the resolver looked and is not now.
        sync = FakeSupabase([self.chan])
        self.assertEqual(decide(sync, catchup=True)[0], slot_guard.GO)
        sync.tables["videos"].append(video("default", held=iso(at(20, 16, 20)), state="blocked"))
        self.assertEqual(decide(sync, catchup=True)[0], slot_guard.SKIP)

    def test_an_unreadable_source_is_a_go_for_an_exact_hour_run_with_a_warning(self):
        rc, said = decide(FakeSupabase([self.chan], fail={"videos"}))
        self.assertEqual(rc, slot_guard.GO)
        self.assertIn("::warning::", said)

    def test_an_unreadable_source_is_a_skip_for_a_catch_up_with_a_warning(self):
        rc, said = decide(FakeSupabase([self.chan], fail={"videos"}), catchup=True)
        self.assertEqual(rc, slot_guard.SKIP)
        self.assertIn("NOT running a catch-up", said)

    def test_the_warning_carries_nothing_the_database_said(self):
        _, out = decide(FakeSupabase([self.chan], fail={"videos"}), catchup=True)
        said = warning_lines(out)
        self.assertIn("NOT running a catch-up", said)     # the assertion below is not vacuous
        for leaked in ("SENTINEL", "503", "boom"):
            self.assertNotIn(leaked, said)

    def test_supabase_not_configured_is_silent_and_follows_the_same_rule(self):
        sync = FakeSupabase([self.chan], enabled=False)
        self.assertEqual(decide(sync, registry_=None)[0], slot_guard.GO)
        rc, said = decide(sync, catchup=True, registry_=None)
        self.assertEqual(rc, slot_guard.SKIP)
        self.assertNotIn("warning", said)

    def test_a_slot_start_that_is_not_a_time_never_starts_a_catch_up(self):
        sync = FakeSupabase([self.chan])
        self.assertEqual(decide(sync, slot="not-a-time")[0], slot_guard.GO)
        self.assertEqual(decide(sync, slot="not-a-time", catchup=True)[0], slot_guard.SKIP)

    def test_a_crash_inside_the_guard_is_an_unknown_not_a_traceback(self):
        class Broken(FakeSupabase):
            def select_strict(self, table, params=None):
                raise RuntimeError("boom")

        self.assertEqual(decide(Broken([self.chan]))[0], slot_guard.GO)
        self.assertEqual(decide(Broken([self.chan]), catchup=True)[0], slot_guard.SKIP)

    def test_the_yesterday_slot_of_a_run_after_midnight_is_judged_on_its_own_day(self):
        sync = FakeSupabase([chan("default", hour=23)],
                            videos=[video("default", published=iso(at(20, 23, 40)))])
        rc, _ = decide(sync, slot="2026-10-20T23:00:00Z", catchup=True, now=at(21, 1, 20))
        self.assertEqual(rc, slot_guard.SKIP)
        rc, _ = decide(sync, slot="2026-10-21T23:00:00Z", now=at(21, 23, 5))      # tomorrow's slot is its own
        self.assertEqual(rc, slot_guard.GO)


class PausedOrNoLongerScheduled(unittest.TestCase):
    """A job that waited in its group can start up to an hour after the resolver chose it: the pause and the
    channel's own switches are asked again, and either one says skip, whatever kind of run it is."""

    def setUp(self):
        self.sync = FakeSupabase([chan("default", hour=15)])

    def test_the_global_pause_stops_both_kinds_of_run_before_any_read(self):
        for value in ("true", "1", "yes", "garbage"):
            for catchup in (False, True):
                with self.subTest(value=value, catchup=catchup):
                    rc, said = decide(self.sync, catchup=catchup, env={list_channels.PAUSE_ENV: value})
                    self.assertEqual(rc, slot_guard.SKIP)
        self.assertEqual(self.sync.reads, [])

    def test_a_pause_value_that_means_run_does_not_stop_it(self):
        for value in ("", "0", "false", "off"):
            sync = FakeSupabase([chan("default", hour=15)])                  # a fresh slot: each go claims an attempt
            self.assertEqual(decide(sync, env={list_channels.PAUSE_ENV: value})[0], slot_guard.GO)

    def test_a_channel_paused_since_the_resolver_looked_is_skipped(self):
        for kw in ({"status": "PAUSED"}, {"schedule_on": False}, {"status": "whatever"}):
            for catchup in (False, True):
                with self.subTest(kw=kw, catchup=catchup):
                    reg = registry(chan("default", hour=15, **kw))
                    self.assertEqual(decide(self.sync, catchup=catchup, registry_=reg)[0], slot_guard.SKIP)

    def test_a_channel_that_is_not_verified_is_skipped(self):
        row = chan("shop", hour=15)
        row["credential_ref"] = {"youtube_channel_id": "UCshop"}                # a draft: never confirmed by YouTube
        self.assertEqual(decide(self.sync, registry_=registry(row), channel="shop")[0], slot_guard.SKIP)
        self.assertEqual(decide(self.sync, registry_=registry(chan("shop", hour=15)), channel="shop")[0], slot_guard.GO)

    def test_a_customers_channel_is_skipped(self):
        reg = registry(chan("cust", hour=15, org=CUSTOMER_ORG))
        self.assertEqual(decide(self.sync, registry_=reg, channel="cust")[0], slot_guard.SKIP)

    def test_a_channel_that_no_longer_exists_is_skipped(self):
        self.assertEqual(decide(self.sync, registry_=registry(chan("shop")), channel="gone")[0], slot_guard.SKIP)

    def test_an_unreadable_registry_is_an_unknown(self):
        class Broken:
            def get(self, channel_id):
                raise RuntimeError("boom")

        rc, out = decide(self.sync, registry_=Broken())
        self.assertEqual(rc, slot_guard.GO)                              # exact hour: as it has always been
        self.assertIn("could not be read", warning_lines(out))
        self.assertNotIn("boom", warning_lines(out))
        self.assertEqual(decide(self.sync, registry_=Broken(), catchup=True)[0], slot_guard.SKIP)

    def test_a_failed_strict_read_of_channels_is_an_unknown_not_an_answer(self):
        # The registry swallows an outage and would answer with an ACTIVE `default`; the guard must not take that.
        sync = FakeSupabase([chan("default", hour=15)], fail={"channels"})
        env = {"SUPABASE_URL": "https://example.invalid", "SUPABASE_SERVICE_KEY": "x"}
        with mock.patch.dict(os.environ, env), mock.patch("modules.supabase_sync.SupabaseSync", return_value=sync), \
                contextlib.redirect_stderr(io.StringIO()):
            logging.disable(logging.CRITICAL)
            try:
                self.assertIsNone(slot_guard.still_scheduled("default"))
            finally:
                logging.disable(logging.NOTSET)

    def test_a_second_read_that_fails_cannot_make_a_present_channel_look_deleted(self):
        # The registry used to be built by a SECOND, forgiving read; if that one failed between the two requests
        # only the synthesized `default` was left and a real channel raised KeyError (read as "deleted"), skipping
        # a legitimate exact-hour run. The decision is now made from the rows of the one strict read.
        class FirstReadOnly(FakeSupabase):
            def select_strict(self, table, params=None):
                rows = super().select_strict(table, params)
                self.tables["channels"] = []            # whatever reads next sees nothing
                return rows

            def select(self, table, params=None):
                return []

        env = {"SUPABASE_URL": "https://example.invalid", "SUPABASE_SERVICE_KEY": "x"}

        def ask(channel, rows):
            sync = FirstReadOnly(rows)
            with mock.patch.dict(os.environ, env), mock.patch("modules.supabase_sync.SupabaseSync", return_value=sync), \
                    contextlib.redirect_stderr(io.StringIO()):
                logging.disable(logging.CRITICAL)
                try:
                    return slot_guard.still_scheduled(channel), sync
                finally:
                    logging.disable(logging.NOTSET)

        verdict, sync = ask("shop", [chan("shop", hour=15)])
        self.assertIs(verdict, True)
        self.assertEqual(sync.reads, ["channels"])                  # one read, not two
        self.assertIs(ask("shop", [chan("shop", hour=15, status="PAUSED")])[0], False)      # still paused: skip
        self.assertIs(ask("shop", [chan("shop", hour=15, org=CUSTOMER_ORG)])[0], False)
        self.assertIs(ask("shop", [chan("news", hour=15)])[0], False)                       # truly absent: skip

    def test_not_configured_is_quiet_and_unknown(self):
        sync = FakeSupabase([chan("default", hour=15)])
        rc, out = decide(sync, registry_=None)
        self.assertEqual(rc, slot_guard.GO)
        self.assertEqual(warning_lines(out), "")
        self.assertEqual(decide(sync, registry_=None, catchup=True)[0], slot_guard.SKIP)

    def test_a_paused_check_does_not_hide_a_worked_slot_or_the_other_way_round(self):
        worked = FakeSupabase([chan("default", hour=15)], videos=[video("default", published=iso(at(20, 15, 40)))])
        self.assertEqual(decide(worked)[0], slot_guard.SKIP)
        self.assertEqual(decide(FakeSupabase([chan("default", hour=15)]))[0], slot_guard.GO)



def attempt_rows(sync):
    return [r for r in sync.tables["system_events"] if r.get("event") == "schedule.attempt"]


class TheAttemptCap(unittest.TestCase):
    """A scheduled slot starts the pipeline at most NIGHTSHIFT_SLOT_MAX_ATTEMPTS times (default 2, at most 4). A scheduled
    retry is a fresh run that pays again, so the cap is what bounds the money, whatever the ticks do."""

    def setUp(self):
        self.chan = chan("default", hour=15)
        self.sync = FakeSupabase([self.chan])

    def go(self, **kw):
        return decide(self.sync, **kw)

    def test_the_first_two_attempts_go_and_the_third_does_not(self):
        self.assertEqual(self.go()[0], slot_guard.GO)
        self.assertEqual(self.go()[0], slot_guard.GO)
        rc, said = self.go()
        self.assertEqual(rc, slot_guard.SKIP)
        self.assertIn("used its 2 attempt(s)", said)
        self.assertIn("Run workflow", said)
        self.assertEqual(len(attempt_rows(self.sync)), 2)               # a refused attempt writes nothing

    def test_the_cap_stops_the_original_ticks_exact_hour_run_and_a_catch_up_alike(self):
        for catchup in (False, True, False, True):
            self.go(catchup=catchup)
        for catchup in (False, True):
            self.assertEqual(self.go(catchup=catchup)[0], slot_guard.SKIP)

    def test_the_row_is_closed_fields_only(self):
        self.go()
        (row,) = attempt_rows(self.sync)
        self.assertEqual(set(row), {"event_key", "event", "ts", "channel_id", "metadata"})
        self.assertEqual(row["event_key"], "slot-attempt:default:2026-10-20T15:00:00Z:1")
        self.assertEqual(row["channel_id"], "default")
        self.assertEqual(row["metadata"], {"slot_start": SLOT, "attempt": 1, "cap": 2})

    def test_the_variable_sets_the_cap_between_one_and_four(self):
        for value, cap in (("1", 1), ("3", 3), ("4", 4), ("9", 4), ("0", 2), ("-1", 2), ("two", 2), ("", 2)):
            sync = FakeSupabase([self.chan])
            gos = [decide(sync, env={schedule_catchup.ATTEMPT_ENV: value})[0] for _ in range(6)]
            self.assertEqual(gos.count(slot_guard.GO), cap, value)
            self.assertEqual(gos[:cap], [slot_guard.GO] * cap, value)

    def test_a_bad_value_is_the_default_with_a_warning_that_never_echoes_it(self):
        for value in ("0", "-3", "SENTINEL-7"):
            said = []
            self.assertEqual(schedule_catchup.max_attempts({schedule_catchup.ATTEMPT_ENV: value}, say=said.append), 2)
            self.assertEqual(len(said), 1, value)
            self.assertNotIn(value, said[0])
        said = []
        self.assertEqual(schedule_catchup.max_attempts({}, say=said.append), 2)
        self.assertEqual(said, [])

    def test_each_claim_takes_a_different_number_so_a_race_cannot_double_up(self):
        got = [schedule_catchup.claim_attempt(self.sync, "default", at(20, 15), 2, at(20, 15, 30)) for _ in range(3)]
        self.assertEqual(got, [("claimed", 1), ("claimed", 2), ("denied", 2)])

    def test_a_slot_that_already_has_its_video_uses_no_attempt(self):
        sync = FakeSupabase([self.chan], videos=[video("default", published=iso(at(20, 15, 40)))])
        self.assertEqual(decide(sync)[0], slot_guard.SKIP)
        self.assertEqual(attempt_rows(sync), [])

    def test_an_attempt_is_not_evidence_that_the_slot_was_worked(self):
        # A run that started and died must stay retryable (up to the cap): the attempt row is not a video.
        self.go()
        ev = schedule_catchup.read_evidence(self.sync, at(20, 17, 30))
        self.assertEqual(schedule_catchup.slot_state(ev, "default", at(20, 15)), schedule_catchup.UNWORKED)

    def test_other_slots_and_other_channels_have_their_own_attempts(self):
        shop = chan("shop", hour=15)
        sync = FakeSupabase([self.chan, shop])
        for _ in range(2):
            decide(sync, registry_=registry(self.chan, shop))
        self.assertEqual(decide(sync, registry_=registry(self.chan, shop))[0], slot_guard.SKIP)
        self.assertEqual(decide(sync, registry_=registry(self.chan, shop), channel="shop")[0], slot_guard.GO)
        self.assertEqual(decide(sync, slot="2026-10-19T15:00:00Z", now=at(19, 16))[0], slot_guard.GO)

    def test_a_claim_that_cannot_be_written_stops_a_catch_up_and_not_the_original_tick(self):
        sync = FakeSupabase([self.chan], fail_write={"system_events"})
        rc, said = decide(sync, catchup=True)
        self.assertEqual(rc, slot_guard.SKIP)
        self.assertIn("could not be recorded", said)
        rc, said = decide(sync, catchup=False)
        self.assertEqual(rc, slot_guard.GO)
        self.assertIn("running at the exact hour as usual", said)

    def test_unreadable_evidence_claims_nothing_for_a_strict_run_and_goes_on_for_the_original_tick(self):
        sync = FakeSupabase([self.chan], fail={"videos"})
        self.assertEqual(decide(sync, catchup=True)[0], slot_guard.SKIP)
        self.assertEqual(attempt_rows(sync), [])
        self.assertEqual(decide(sync, catchup=False)[0], slot_guard.GO)
        self.assertEqual(len(attempt_rows(sync)), 1)

    def test_a_denied_claim_stops_the_original_tick_even_when_the_evidence_is_unreadable(self):
        sync = FakeSupabase([self.chan], fail={"videos"})
        for _ in range(2):
            decide(sync, catchup=False)
        self.assertEqual(decide(sync, catchup=False)[0], slot_guard.SKIP)

    def test_supabase_not_configured_runs_the_original_tick_and_never_a_catch_up(self):
        sync = FakeSupabase([self.chan], enabled=False)
        self.assertEqual(decide(sync, catchup=False)[0], slot_guard.GO)
        self.assertEqual(decide(sync, catchup=True)[0], slot_guard.SKIP)

    def test_the_warning_carries_nothing_the_database_said(self):
        _, out = decide(FakeSupabase([self.chan], fail_write={"system_events"}), catchup=True)
        said = warning_lines(out)
        self.assertIn("could not be recorded", said)
        for leaked in ("SENTINEL", "503", "boom"):
            self.assertNotIn(leaked, said)

if __name__ == "__main__":
    unittest.main()
