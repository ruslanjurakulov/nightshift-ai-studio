"""tools/slot_guard.py: the question asked again inside the run, once the job holds its concurrency group.

Exit 3 = the slot was already worked (nothing is spent); 0 = go. An unknown is a go for an exact-hour run (as it
has always been) and a stop for a catch-up (an unknown must never start a paid run). Offline: the "Supabase" is
the fake from test_schedule_catchup.
"""

from __future__ import annotations

import contextlib
import io
import unittest
from datetime import datetime, timezone

from modules import schedule_catchup
from tests.test_schedule_catchup import FakeSupabase, at, chan, iso, video
from tools import slot_guard

SLOT = "2026-10-20T15:00:00Z"


def decide(sync, *, catchup=False, slot=SLOT, now=at(20, 17, 30)):
    err = io.StringIO()
    out = io.StringIO()
    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
        rc = slot_guard.decide("default", slot, catchup, sync=sync, now=now)
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
        _, said = decide(FakeSupabase([self.chan], fail={"videos"}), catchup=True)
        for leaked in ("SENTINEL", "503", "boom"):
            self.assertNotIn(leaked, said)

    def test_supabase_not_configured_is_silent_and_follows_the_same_rule(self):
        sync = FakeSupabase([self.chan], enabled=False)
        self.assertEqual(decide(sync)[0], slot_guard.GO)
        rc, said = decide(sync, catchup=True)
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


if __name__ == "__main__":
    unittest.main()
