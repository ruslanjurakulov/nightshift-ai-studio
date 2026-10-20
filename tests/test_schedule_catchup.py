"""Catch-up and once-per-slot for the scheduled matrix (H5a), against a fake Supabase.

``daily_video.yml`` used to run only the channels whose slot hour equals the current UTC hour, so a cron
delayed past the top of the hour (or dropped) lost that channel's whole day. These tests pin the rules that
make a catch-up safe:

* a slot that passed within the window and has NO run is caught up; one with ANY evidence (the dead-man
  switch's own: a video, held or blocked row, a storyboard, a run event) is not, at its exact hour either;
* an unreadable evidence source never starts a catch-up (an unknown is not a licence to spend) and leaves the
  exact hour behaving as it always did, loudly;
* a pause (global, per channel, schedule off), a customer channel, an unreadable registry and a channel edited
  after the slot all keep their veto.

Offline: the "Supabase" is a dict of tables and nothing here touches the network, a provider or a real run.
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from modules import schedule_catchup
from modules.channels import DEFAULT_ORG_ID, ChannelContext, ChannelRegistry
from tools import list_channels

CUSTOMER_ORG = "8710f2b3-bcd6-4c90-a992-cbc329af93bb"
LONG_AGO = "2026-01-01T00:00:00Z"
UTC = timezone.utc


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=UTC)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def chan(channel_id, *, hour=15, org=DEFAULT_ORG_ID, status="ACTIVE", schedule_on=True, updated=LONG_AGO) -> dict:
    return {
        "channel_id": channel_id, "name": channel_id, "niche": "tech", "status": status, "org_id": org,
        "schedule_config": {"enabled": schedule_on, "publish_hour_utc": hour},
        "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z"},
        "created_at": LONG_AGO, "updated_at": updated,
    }


def registry(*rows) -> ChannelRegistry:
    return ChannelRegistry([ChannelContext.from_dict(r) for r in rows])


class FakeSupabase:
    """A SupabaseSync lookalike over in-memory tables. ``eq.`` filters are honoured, the rest is left to the
    caller's own client-side checks (as they are in production). ``fail`` names tables whose read raises."""

    def __init__(self, channels, videos=(), storyboards=(), events=(), fail=(), enabled=True):
        self.enabled = enabled
        self.tables = {"channels": list(channels), "videos": list(videos),
                       "storyboards": list(storyboards), "system_events": list(events)}
        self.fail, self.reads = set(fail), []

    def select_strict(self, table, params=None):
        from modules.supabase_sync import SupabaseReadError

        self.reads.append(table)
        if table in self.fail:
            raise SupabaseReadError(table, 503, "boom-SENTINEL")
        rows = list(self.tables.get(table, []))
        for key, cond in (params or {}).items():
            if isinstance(cond, str) and cond.startswith("eq."):
                rows = [r for r in rows if str(r.get(key)) == cond[3:]]
        limit = int((params or {}).get("limit") or 0)
        return rows[:limit] if limit else rows


def video(channel_id, *, published=None, held=None, state=None, fmt="long", parent=None, vid="v1") -> dict:
    return {"video_id": vid, "channel_id": channel_id, "publish_state": state, "published_at": published,
            "held_at": held, "video_format": fmt, "parent_video_id": parent}


def warning_lines(text: str) -> str:
    """What the scheduler itself said as a warning: the `warning:` and `::warning::` lines, nothing else. Python's
    last-resort handler also prints an unrelated library log line to stderr when a test runs alone; that is not
    this module's output and must not decide a test."""
    return "\n".join(l for l in text.splitlines() if l.startswith(("warning:", "::warning::")))


def run(due_hour, rows, *, now, sync=None, registry_=None, env=None, window="3"):
    """due_channels with the clock, the environment and Supabase controlled. Returns (matrix rows, stderr).

    ``window`` is the catch-up window the scenario assumes (the default is 1 hour, which most scenarios here are
    wider than); ``None`` leaves the variable unset to test the default itself. ``logging`` is switched off so a
    test does not depend on how the runner configures it."""
    sync = sync if sync is not None else FakeSupabase([c for c in rows])
    reg = registry_ if registry_ is not None else registry(*rows)
    clean = {k: v for k, v in os.environ.items()
             if k not in (list_channels.PAUSE_ENV, schedule_catchup.CATCHUP_ENV)}
    if window is not None:
        clean[schedule_catchup.CATCHUP_ENV] = window
    clean.update(env or {})
    err = io.StringIO()
    logging.disable(logging.CRITICAL)
    try:
        with mock.patch.dict(os.environ, clean, clear=True), contextlib.redirect_stderr(err):
            out = list_channels.due_channels(due_hour, registry=reg, now=now, evidence_sync=sync)
    finally:
        logging.disable(logging.NOTSET)
    return out, err.getvalue()


def ids(out):
    return [r["channel_id"] for r in out]


NOW = at(20, 17, 30)                      # the hourly run of 17:00 UTC, started half an hour late


class TheWindow(unittest.TestCase):
    def setUp(self):
        self.rows = [chan("default", hour=15)]

    def test_a_slot_that_passed_two_hours_ago_with_no_run_is_caught_up(self):
        out, err = run(17, self.rows, now=NOW)
        self.assertEqual(ids(out), ["default"])
        self.assertTrue(out[0]["catchup"])
        self.assertEqual(out[0]["slot_start"], "2026-10-20T15:00:00Z")
        self.assertEqual(out[0]["slot_date"], "2026-10-20")
        self.assertIn("catching up", err)

    def test_the_exact_hour_is_not_a_catch_up(self):
        out, _ = run(15, self.rows, now=at(20, 15, 5))
        self.assertEqual(ids(out), ["default"])
        self.assertFalse(out[0]["catchup"])
        self.assertEqual(out[0]["slot_start"], "2026-10-20T15:00:00Z")

    def test_the_hour_before_the_slot_is_not_due(self):
        self.assertEqual(run(14, self.rows, now=at(20, 14, 5))[0], [])

    def test_the_default_window_is_one_hour(self):
        # One hour is all a late or dropped cron needs; more is only more paid retries of a run that wrote no row.
        self.assertEqual(ids(run(16, self.rows, now=at(20, 16, 5), window=None)[0]), ["default"])    # 1 h late
        self.assertEqual(run(17, self.rows, now=at(20, 17, 5), window=None)[0], [])                  # 2 h late

    def test_a_window_of_three_still_reaches_three_hours_and_no_more(self):
        self.assertEqual(ids(run(18, self.rows, now=at(20, 18, 5))[0]), ["default"])      # 3 h late
        self.assertEqual(run(19, self.rows, now=at(20, 19, 5))[0], [])                    # 4 h late

    def test_the_window_can_be_widened_to_six_and_no_further(self):
        env = {schedule_catchup.CATCHUP_ENV: "6"}
        self.assertEqual(ids(run(21, self.rows, now=at(20, 21, 5), env=env)[0]), ["default"])
        self.assertEqual(run(22, self.rows, now=at(20, 22, 5), env=env)[0], [])
        env = {schedule_catchup.CATCHUP_ENV: "40"}
        self.assertEqual(run(22, self.rows, now=at(20, 22, 5), env=env)[0], [])

    def test_zero_switches_the_catch_up_off_but_not_the_exact_hour(self):
        env = {schedule_catchup.CATCHUP_ENV: "0"}
        self.assertEqual(run(17, self.rows, now=NOW, env=env)[0], [])
        self.assertEqual(ids(run(15, self.rows, now=at(20, 15, 5), env=env)[0]), ["default"])

    def test_the_window_wraps_past_midnight_and_names_yesterdays_slot(self):
        rows = [chan("default", hour=23)]
        out, _ = run(1, rows, now=at(21, 1, 20))
        self.assertEqual(ids(out), ["default"])
        self.assertEqual(out[0]["slot_start"], "2026-10-20T23:00:00Z")
        self.assertEqual(out[0]["slot_date"], "2026-10-20")

    def test_a_clock_that_ticked_into_the_next_hour_still_means_the_hour_that_was_asked_about(self):
        out, _ = run(15, self.rows, now=at(20, 16, 0))        # the workflow read 15, the clock now says 16:00
        self.assertEqual(out[0]["slot_start"], "2026-10-20T15:00:00Z")
        self.assertFalse(out[0]["catchup"])

    def test_a_channel_with_no_hour_keeps_the_15_utc_slot(self):
        row = chan("default")
        row["schedule_config"] = {"enabled": True}
        out, _ = run(17, [row], now=NOW)
        self.assertEqual(out[0]["slot_start"], "2026-10-20T15:00:00Z")


class OnlyAnUnworkedSlotIsCaughtUp(unittest.TestCase):
    """The dead-man's evidence, in each of its forms: any of it means the slot was worked."""

    def setUp(self):
        self.chan = chan("default", hour=15)

    def go(self, **tables):
        sync = FakeSupabase([self.chan], **tables)
        return run(17, [self.chan], now=NOW, sync=sync)

    def test_an_uploaded_video_in_the_slot_is_not_run_again(self):
        out, err = self.go(videos=[video("default", published=iso(at(20, 15, 40)), state="uploaded")])
        self.assertEqual(out, [])
        self.assertIn("already has a run", err)

    def test_a_held_video_is_a_run(self):
        self.assertEqual(self.go(videos=[video("default", held=iso(at(20, 16, 10)), state="held")])[0], [])

    def test_a_blocked_video_is_a_run(self):
        self.assertEqual(self.go(videos=[video("default", held=iso(at(20, 15, 55)), state="blocked")])[0], [])

    def test_a_storyboard_waiting_for_a_person_is_a_run(self):
        sb = [{"id": "s1", "channel_id": "default", "status": "pending", "created_at": iso(at(20, 15, 30))}]
        self.assertEqual(self.go(storyboards=sb)[0], [])

    def test_a_run_event_is_a_run(self):
        ev = [{"event": "system.started", "ts": iso(at(20, 15, 3)), "channel_id": "default"}]
        self.assertEqual(self.go(events=ev)[0], [])

    def test_a_video_made_before_the_slot_does_not_count(self):
        out, _ = self.go(videos=[video("default", published=iso(at(20, 14, 59)))])
        self.assertEqual(ids(out), ["default"])

    def test_yesterdays_video_does_not_count(self):
        out, _ = self.go(videos=[video("default", published=iso(at(19, 15, 40)))])
        self.assertEqual(ids(out), ["default"])

    def test_another_channels_video_does_not_count(self):
        out, _ = self.go(videos=[video("shop", published=iso(at(20, 15, 40)))])
        self.assertEqual(ids(out), ["default"])

    def test_a_repurposed_short_is_not_the_slots_video(self):
        out, _ = self.go(videos=[video("default", held=iso(at(20, 15, 40)), fmt="short", parent="vX")])
        self.assertEqual(ids(out), ["default"])

    def test_at_the_exact_hour_a_slot_that_already_has_a_run_is_not_scheduled_again(self):
        # e.g. a manual run at 15:00:30, before the cron's resolver ran
        sync = FakeSupabase([self.chan], videos=[video("default", held=iso(at(20, 15, 0)), state="held")])
        out, err = run(15, [self.chan], now=at(20, 15, 4), sync=sync)
        self.assertEqual(out, [])
        self.assertIn("already has a run", err)

    def test_the_next_days_slot_is_a_new_slot(self):
        sync = FakeSupabase([self.chan], videos=[video("default", published=iso(at(20, 15, 40)))])
        out, _ = run(15, [self.chan], now=at(21, 15, 4), sync=sync)
        self.assertEqual(ids(out), ["default"])

    def test_two_channels_are_judged_separately(self):
        a, b = chan("default", hour=15), chan("shop", hour=16)
        sync = FakeSupabase([a, b], videos=[video("default", published=iso(at(20, 15, 40)))])
        out, _ = run(17, [a, b], now=NOW, sync=sync)
        self.assertEqual(ids(out), ["shop"])
        self.assertEqual(out[0]["slot_start"], "2026-10-20T16:00:00Z")

    def test_a_channel_edited_after_the_slot_is_not_caught_up_for_a_slot_that_was_never_its_own(self):
        # Moving a channel's hour (or switching it on) at 16:00 must not start the 15:00 slot that already passed.
        edited = chan("default", hour=15, updated=iso(at(20, 16, 0)))
        out, _ = run(17, [edited], now=NOW, sync=FakeSupabase([edited]))
        self.assertEqual(out, [])

    def test_the_same_edit_does_not_hold_back_the_exact_hour(self):
        edited = chan("default", hour=17, updated=iso(at(20, 16, 0)))
        out, _ = run(17, [edited], now=NOW, sync=FakeSupabase([edited]))
        self.assertEqual(ids(out), ["default"])


class AnUnknownNeverStartsARun(unittest.TestCase):
    def setUp(self):
        self.chan = chan("default", hour=15)

    def test_an_unreadable_videos_table_means_no_catch_up_and_says_so(self):
        out, err = run(17, [self.chan], now=NOW, sync=FakeSupabase([self.chan], fail={"videos"}))
        self.assertEqual(out, [])
        self.assertIn("NOT catching up", err)
        self.assertIn("::warning::", err)

    def test_an_unreadable_videos_table_leaves_the_exact_hour_exactly_as_it_was_and_says_so(self):
        out, err = run(15, [self.chan], now=at(20, 15, 4), sync=FakeSupabase([self.chan], fail={"videos"}))
        self.assertEqual(ids(out), ["default"])
        self.assertFalse(out[0]["catchup"])
        self.assertIn("running at the exact hour as usual", err)
        self.assertIn("::warning::", err)

    def test_every_source_matters_not_just_the_videos(self):
        for table in ("storyboards", "system_events", "channels"):
            with self.subTest(table):
                out, _ = run(17, [self.chan], now=NOW, sync=FakeSupabase([self.chan], fail={table}))
                self.assertEqual(out, [])

    def test_a_read_that_hit_its_row_limit_is_not_proof_of_absence(self):
        many = [video("default", published=iso(at(19, 8, 0)), vid=f"v{i}") for i in range(300)]
        out, _ = run(17, [self.chan], now=NOW, sync=FakeSupabase([self.chan], videos=many))
        self.assertEqual(out, [])

    def test_positive_evidence_still_counts_when_another_source_failed(self):
        sync = FakeSupabase([self.chan], videos=[video("default", published=iso(at(20, 15, 40)))],
                            fail={"system_events"})
        self.assertEqual(run(17, [self.chan], now=NOW, sync=sync)[0], [])

    def test_a_warning_never_carries_what_the_database_said(self):
        _, err = run(17, [self.chan], now=NOW, sync=FakeSupabase([self.chan], fail={"videos"}))
        said = warning_lines(err)
        self.assertIn("NOT catching up", said)            # the assertion below is not vacuous
        for leaked in ("SENTINEL", "503", "boom"):
            self.assertNotIn(leaked, said)

    def test_a_channel_the_evidence_did_not_cover_is_unknown_not_unworked(self):
        shop, other = chan("shop", hour=15), chan("news", hour=15)
        out, _ = run(17, [shop], now=NOW, sync=FakeSupabase([other]))           # the table does not list `shop`
        self.assertNotIn("shop", ids(out))

    def test_the_exact_hour_of_a_channel_the_evidence_did_not_cover_runs_but_says_it_cannot_see(self):
        shop, other = chan("shop", hour=15), chan("news", hour=15)
        out, err = run(15, [shop], now=at(20, 15, 4), sync=FakeSupabase([other]))
        self.assertIn("shop", ids(out))
        self.assertIn("UNREADABLE for shop", err)

    def test_supabase_not_configured_runs_the_exact_hour_silently_and_never_catches_up(self):
        sync = FakeSupabase([self.chan], enabled=False)
        out, err = run(15, [self.chan], now=at(20, 15, 4), sync=sync)
        self.assertEqual(ids(out), ["default"])
        self.assertNotIn("warning", err)
        out, err = run(17, [self.chan], now=NOW, sync=sync)
        self.assertEqual(out, [])
        self.assertNotIn("warning", err)
        self.assertEqual(sync.reads, [])

    def test_a_broken_evidence_reader_is_an_unknown_not_a_crash(self):
        with mock.patch.object(schedule_catchup, "read_evidence", side_effect=RuntimeError("boom")):
            out, err = run(17, [self.chan], now=NOW)
        self.assertEqual(out, [])
        self.assertIn("RuntimeError", err)
        with mock.patch.object(schedule_catchup, "read_evidence", side_effect=RuntimeError("boom")):
            out, _ = run(15, [self.chan], now=at(20, 15, 4))
        self.assertEqual(ids(out), ["default"])


class AVetoIsAlwaysRespected(unittest.TestCase):
    """The reason a catch-up can never run a paused channel: it only ever picks among what the scheduler already
    allows, and the pause returns before any of it."""

    def test_the_global_pause_wins_and_reads_nothing(self):
        rows = [chan("default", hour=15)]
        sync = FakeSupabase(rows)
        for value in ("true", "1", "garbage"):
            with self.subTest(value):
                out, err = run(17, rows, now=NOW, sync=sync, env={list_channels.PAUSE_ENV: value})
                self.assertEqual(out, [])
        self.assertEqual(sync.reads, [])

    def test_the_global_pause_also_stops_the_exact_hour(self):
        rows = [chan("default", hour=15)]
        self.assertEqual(run(15, rows, now=at(20, 15, 4), env={list_channels.PAUSE_ENV: "true"})[0], [])

    def test_a_paused_channel_is_never_caught_up(self):
        rows = [chan("default", hour=15, status="PAUSED"), chan("shop", hour=15)]
        out, _ = run(17, rows, now=NOW)
        self.assertEqual(ids(out), ["shop"])

    def test_a_channel_whose_schedule_is_off_is_never_caught_up(self):
        rows = [chan("default", hour=15, schedule_on=False)]
        self.assertEqual(run(17, rows, now=NOW)[0], [])

    def test_a_status_the_registry_does_not_recognise_is_paused(self):
        rows = [chan("default", hour=15, status="whatever")]
        self.assertEqual(run(17, rows, now=NOW)[0], [])

    def test_a_customers_channel_is_never_caught_up(self):
        rows = [chan("default", hour=15), chan("cust", hour=15, org=CUSTOMER_ORG)]
        out, _ = run(17, rows, now=NOW)
        self.assertEqual(ids(out), ["default"])

    def test_an_unreadable_registry_gets_no_catch_up_and_reads_no_evidence(self):
        class Boom:
            def active(self):
                raise RuntimeError("boom")

        sync = FakeSupabase([])
        out, _ = run(17, [], now=NOW, sync=sync, registry_=Boom())          # the fallback `default` has hour 15
        self.assertEqual(out, [])
        out, _ = run(15, [], now=at(20, 15, 4), sync=sync, registry_=Boom())
        self.assertEqual(ids(out), ["default"])                             # the old fail-open, unchanged
        self.assertEqual(sync.reads, [])

    def test_a_catch_up_row_asks_for_no_more_than_a_scheduled_one(self):
        out, _ = run(17, [chan("default", hour=15)], now=NOW)
        scheduled, _ = run(15, [chan("default", hour=15)], now=at(20, 15, 4))
        self.assertEqual(set(out[0]) - {"slot_start", "slot_date", "catchup"},
                         set(scheduled[0]) - {"slot_start", "slot_date", "catchup"})
        self.assertNotIn("privacy", out[0])


class NeverTwoRowsForOneChannel(unittest.TestCase):
    def test_a_channel_is_listed_once_however_many_hours_it_could_match(self):
        rows = [chan("default", hour=15)]
        for due in range(24):
            with self.subTest(hour=due):
                out, _ = run(due, rows, now=at(20, due, 5))
                self.assertLessEqual(len(out), 1)

    def test_one_slot_is_due_in_at_most_the_window_of_hourly_runs(self):
        rows = [chan("default", hour=15)]
        due_hours = [h for h in range(24) if run(h, rows, now=at(20, h, 5))[0]]
        self.assertEqual(due_hours, [15, 16, 17, 18])           # the exact hour plus three catch-up hours
        due_hours = [h for h in range(24) if run(h, rows, now=at(20, h, 5), window=None)[0]]
        self.assertEqual(due_hours, [15, 16])                   # by default: the exact hour plus one

    def test_once_the_exact_run_made_a_video_no_later_hour_runs_it_again(self):
        rows = [chan("default", hour=15)]
        sync = FakeSupabase(rows, videos=[video("default", published=iso(at(20, 15, 50)), state="uploaded")])
        for h in range(24):
            with self.subTest(hour=h):
                self.assertEqual(run(h, rows, now=at(20, h, 5), sync=sync)[0], [])


class TheWindowSetting(unittest.TestCase):
    def say(self, value=None):
        said = []
        env = {} if value is None else {schedule_catchup.CATCHUP_ENV: value}
        return schedule_catchup.catchup_hours(env, say=said.append), said

    def test_unset_and_empty_are_the_default_without_a_warning(self):
        for value in (None, "", "  "):
            self.assertEqual(self.say(value), (1, []))

    def test_whole_numbers_up_to_six(self):
        for n in range(0, 7):
            self.assertEqual(self.say(str(n)), (n, []))

    def test_quotes_and_spaces_are_forgiven(self):
        self.assertEqual(self.say(' "2" ')[0], 2)

    def test_garbage_is_the_default_with_a_warning_that_never_echoes_it(self):
        for value in ("abc", "1.5", "-1", "3h", "∞", "SENTINEL-7"):
            got, said = self.say(value)
            self.assertEqual(got, 1, value)
            self.assertEqual(len(said), 1, value)
            self.assertNotIn(value, said[0])

    def test_above_the_maximum_is_clamped_with_a_warning(self):
        got, said = self.say("12")
        self.assertEqual(got, 6)
        self.assertEqual(len(said), 1)

    def test_plain_off_words_mean_off(self):
        for value in ("off", "OFF", "false", "no", "none", "disabled"):
            self.assertEqual(self.say(value), (0, []))


class ExactHourRowsComeFirst(unittest.TestCase):
    def test_the_schedules_own_channels_run_before_a_catch_up(self):
        # Matrix order is run order (max-parallel 1): a run cut short must not have spent its time on a
        # catch-up while a channel that is due on the hour was still waiting.
        late, exact = chan("aaa-late", hour=16), chan("zzz-exact", hour=17)
        for order in ((late, exact), (exact, late)):
            out, _ = run(17, list(order), now=NOW)
            self.assertEqual([(r["channel_id"], r["catchup"]) for r in out if r["channel_id"] != "default"],
                             [("zzz-exact", False), ("aaa-late", True)])

    def test_catch_up_rows_never_precede_exact_rows_among_many(self):
        rows = [chan(f"c{i}", hour=16 if i % 2 else 17) for i in range(6)]
        out, _ = run(17, rows, now=NOW)
        flags = [r["catchup"] for r in out]
        self.assertEqual(flags, sorted(flags))
        self.assertIn(True, flags)
        self.assertIn(False, flags)


class TheMatrixCarriesTheSlot(unittest.TestCase):
    def test_a_listing_without_a_due_hour_names_the_current_hour_as_its_slot(self):
        rows = [chan("default", hour=3)]
        out, _ = run(None, rows, now=at(20, 9, 41))
        self.assertEqual(out[0]["slot_start"], "2026-10-20T09:00:00Z")
        self.assertEqual(out[0]["slot_date"], "2026-10-20")
        self.assertFalse(out[0]["catchup"])

    def test_the_existing_row_keys_are_unchanged(self):
        out, _ = run(15, [chan("default", hour=15)], now=at(20, 15, 4))
        for key in ("channel_id", "name", "niche", "is_default", "is_operators", "token_secret"):
            self.assertIn(key, out[0])


if __name__ == "__main__":
    unittest.main()
