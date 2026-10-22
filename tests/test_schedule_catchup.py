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

    def __init__(self, channels, videos=(), storyboards=(), events=(), fail=(), enabled=True, fail_write=()):
        self.enabled = enabled
        self.fail_write = set(fail_write)
        self.tables = {"channels": list(channels), "videos": list(videos),
                       "storyboards": list(storyboards), "system_events": list(events)}
        self.fail, self.reads = set(fail), []

    def insert_new(self, table, rows, on_conflict):
        """PostgREST ignore-duplicates: only rows whose conflict key is new are inserted and returned. ``fail_write``
        names tables whose write fails (None, as the real client answers on any failure)."""
        if table in self.fail_write or not self.enabled:
            return None
        have, out = {r.get(on_conflict) for r in self.tables.setdefault(table, [])}, []
        for r in rows:
            if r.get(on_conflict) not in have:
                have.add(r.get(on_conflict))
                self.tables[table].append(dict(r))
                out.append(dict(r))
        return out

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


def run(due_hour, rows, *, now, sync=None, registry_=None, env=None, window="3", backup=False):
    """due_channels with the clock, the environment and Supabase controlled. Returns (matrix rows, stderr).

    ``window`` is the catch-up window the scenario assumes (3 hours, the default); ``None`` leaves the variable
    unset to test the default itself; ``backup`` makes the tick one of the extra (backup) cron entries. ``logging`` is switched off so a
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
            out = list_channels.due_channels(due_hour, registry=reg, now=now, evidence_sync=sync, backup_tick=backup)
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

    def test_the_default_window_is_three_hours(self):
        # GitHub delivers about one hourly tick in four (the repo's own history), so one hour of catch-up covers
        # under half the slots; three covers most of them, and six (the cap) stays an explicit choice.
        self.assertEqual(ids(run(18, self.rows, now=at(20, 18, 5), window=None)[0]), ["default"])    # 3 h late
        self.assertEqual(run(19, self.rows, now=at(20, 19, 5), window=None)[0], [])                  # 4 h late

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


class BackupTicks(unittest.TestCase):
    """daily_video.yml ticks four times an hour: the original ``0 * * * *`` and three backups. A backup tick only
    ever acts on POSITIVE knowledge that the slot is free. The original tick keeps its documented fail-open at the
    exact hour, so an outage cannot make four ticks start four runs."""

    def setUp(self):
        self.chan = chan("default", hour=15)

    def test_which_ticks_are_backups(self):
        self.assertFalse(schedule_catchup.is_backup_tick(None))                       # not a scheduled tick at all
        self.assertFalse(schedule_catchup.is_backup_tick(schedule_catchup.PRIMARY_CRON))
        self.assertTrue(schedule_catchup.is_backup_tick("15,30,45 * * * *"))
        self.assertTrue(schedule_catchup.is_backup_tick(""))                          # a tick that cannot say what it is

    def test_a_free_slot_is_handed_out_at_the_exact_hour_as_a_strict_row(self):
        out, _ = run(15, [self.chan], now=at(20, 15, 20), backup=True)
        self.assertEqual(ids(out), ["default"])
        self.assertTrue(out[0]["catchup"])            # the guard in the run then also needs the evidence to be readable
        self.assertEqual(out[0]["slot_start"], iso(at(20, 15, 0)))

    def test_the_original_tick_at_the_exact_hour_is_not_strict(self):
        out, _ = run(15, [self.chan], now=at(20, 15, 4))
        self.assertFalse(out[0]["catchup"])

    def test_a_worked_slot_is_not_handed_out_again(self):
        sync = FakeSupabase([self.chan], videos=[video("default", published=iso(at(20, 15, 12)))])
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 20), sync=sync, backup=True)[0], [])

    def test_an_unknown_starts_nothing_and_says_so(self):
        out, err = run(15, [self.chan], now=at(20, 15, 20), sync=FakeSupabase([self.chan], fail={"videos"}), backup=True)
        self.assertEqual(out, [])
        self.assertIn("::warning::", err)
        self.assertIn("NOT", err)
        for leaked in ("SENTINEL", "503", "boom"):
            self.assertNotIn(leaked, warning_lines(err))
        # ... where the original tick, with the very same evidence, still runs the exact hour as it always did.
        out, _ = run(15, [self.chan], now=at(20, 15, 4), sync=FakeSupabase([self.chan], fail={"videos"}))
        self.assertEqual(ids(out), ["default"])

    def test_supabase_not_configured_leaves_the_exact_hour_to_the_original_tick_alone(self):
        sync = FakeSupabase([self.chan], enabled=False)
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 20), sync=sync, backup=True)[0], [])
        self.assertEqual(ids(run(15, [self.chan], now=at(20, 15, 4), sync=sync)[0]), ["default"])

    def test_an_unreadable_registry_gets_no_backup_run(self):
        class Boom:
            def active(self):
                raise RuntimeError("boom")

        out, err = run(15, [], now=at(20, 15, 20), registry_=Boom(), backup=True)
        self.assertEqual(out, [])
        self.assertIn("::warning::", err)
        out, _ = run(15, [], now=at(20, 15, 4), registry_=Boom())
        self.assertEqual(ids(out), ["default"])                                       # the old fail-open, unchanged

    def test_a_channel_edited_after_the_slot_began_gets_no_unplanned_run_from_a_backup_tick(self):
        # The dead-man's "never due" rule, as for a catch-up: a channel created or edited at 15:10 with hour 15 and
        # nothing produced was not expected to run the 15:00 slot, so the 15:20 backup tick does not start it.
        edited = chan("default", hour=15, updated=iso(at(20, 15, 10)))
        out, _ = run(15, [edited], now=at(20, 15, 20), backup=True)
        self.assertEqual(out, [])
        # ... where the ORIGINAL tick still runs its exact hour (unchanged), and an edit BEFORE the slot is no bar.
        self.assertEqual(ids(run(15, [edited], now=at(20, 15, 4))[0]), ["default"])
        before = chan("default", hour=15, updated=iso(at(20, 14, 59)))
        self.assertEqual(ids(run(15, [before], now=at(20, 15, 20), backup=True)[0]), ["default"])

    def test_late_hours_are_the_same_catch_up_as_for_the_original_tick(self):
        for hour in (16, 17, 18):
            a, _ = run(hour, [self.chan], now=at(20, hour, 20), backup=True)
            b, _ = run(hour, [self.chan], now=at(20, hour, 20))
            self.assertEqual(a, b)
            self.assertTrue(a[0]["catchup"])
        self.assertEqual(run(19, [self.chan], now=at(20, 19, 20), backup=True)[0], [])

    def test_the_pause_and_the_other_vetoes_still_win(self):
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 20), backup=True,
                             env={list_channels.PAUSE_ENV: "true"})[0], [])
        self.assertEqual(run(15, [chan("default", hour=15, status="PAUSED")], now=at(20, 15, 20), backup=True)[0], [])
        self.assertEqual(run(15, [chan("default", hour=15, org=CUSTOMER_ORG)], now=at(20, 15, 20), backup=True)[0], [])

    def test_the_command_line_marks_a_scheduled_tick_that_is_not_the_original(self):
        calls = []

        def fake(due_hour=None, **kw):
            calls.append(kw.get("backup_tick"))
            return []

        for argv, want in ((["--due-hour", "5"], False),
                           (["--due-hour", "5", "--tick", schedule_catchup.PRIMARY_CRON], False),
                           (["--due-hour", "5", "--tick", "15,30,45 * * * *"], True),
                           (["--due-hour", "5", "--tick", ""], True)):
            with mock.patch.object(list_channels, "due_channels", fake), \
                    mock.patch("sys.argv", ["list_channels.py", *argv]), contextlib.redirect_stdout(io.StringIO()):
                list_channels.main()
            self.assertIs(calls[-1], want, argv)


def attempt(channel_id, slot, n):
    return {"event_key": f"slot-attempt:{channel_id}:{slot}:{n}", "event": "schedule.attempt",
            "ts": "2026-10-20T15:05:00Z", "channel_id": channel_id}


class TheAttemptCapInTheResolver(unittest.TestCase):
    """A slot that has used its attempts (and has no video) is not handed out, whichever tick asks."""

    SLOT = "2026-10-20T15:00:00Z"

    def setUp(self):
        self.chan = chan("default", hour=15)

    def sync(self, *attempts, **kw):
        return FakeSupabase([self.chan], events=list(attempts), **kw)

    def used(self, n):
        return self.sync(*[attempt("default", self.SLOT, i) for i in range(1, n + 1)])

    def test_a_slot_with_attempts_left_is_handed_out(self):
        for hour, minute in ((16, 5), (18, 5)):             # attempt 1 was at 15:05: the gap has passed
            self.assertEqual(ids(run(hour, [self.chan], now=at(20, hour, minute), sync=self.used(1))[0]), ["default"])

    def test_a_slot_that_used_its_attempts_is_not_handed_out_at_any_hour_or_by_any_tick(self):
        for hour in (15, 16, 17, 18):
            for backup in (False, True):
                out, err = run(hour, [self.chan], now=at(20, hour, 20), sync=self.used(2), backup=backup)
                self.assertEqual(out, [], (hour, backup))
        self.assertIn("used its 2 attempt(s)", err)

    def test_the_cap_follows_the_variable(self):
        env = {schedule_catchup.ATTEMPT_ENV: "3"}
        self.assertEqual(ids(run(16, [self.chan], now=at(20, 16, 5), sync=self.used(2), env=env)[0]), ["default"])
        self.assertEqual(run(16, [self.chan], now=at(20, 16, 5), sync=self.used(3), env=env)[0], [])
        env = {schedule_catchup.ATTEMPT_ENV: "1"}
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 5), sync=self.used(1), env=env)[0], [])

    def test_another_slot_or_channel_does_not_use_this_ones_attempts(self):
        other = [attempt("default", "2026-10-19T15:00:00Z", 1), attempt("default", "2026-10-19T15:00:00Z", 2),
                 attempt("shop", self.SLOT, 1), attempt("shop", self.SLOT, 2)]
        out, _ = run(15, [self.chan], now=at(20, 15, 4), sync=self.sync(*other))
        self.assertEqual(ids(out), ["default"])

    def test_unreadable_attempts_start_no_catch_up_and_no_backup_run_but_the_original_exact_hour_goes_on(self):
        sync = self.sync(fail={"system_events"})
        self.assertEqual(run(17, [self.chan], now=at(20, 17, 5), sync=sync)[0], [])
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 20), sync=sync, backup=True)[0], [])
        self.assertEqual(ids(run(15, [self.chan], now=at(20, 15, 4), sync=sync)[0]), ["default"])

    def test_an_attempt_count_that_alone_cannot_be_read_is_not_zero(self):
        # The evidence reads fine; only the attempt rows fail. Zero attempts must not be assumed.
        class OnlyAttemptsFail(FakeSupabase):
            def select_strict(self, table, params=None):
                from modules.supabase_sync import SupabaseReadError

                if (params or {}).get("event") == "eq.schedule.attempt":
                    raise SupabaseReadError(table, 503, "boom-SENTINEL")
                return super().select_strict(table, params)

        sync = OnlyAttemptsFail([self.chan])
        out, err = run(17, [self.chan], now=at(20, 17, 5), sync=sync)                    # a catch-up
        self.assertEqual(out, [])
        self.assertIn("attempt count UNREADABLE", err)
        self.assertEqual(run(15, [self.chan], now=at(20, 15, 20), sync=sync, backup=True)[0], [])
        out, err = run(15, [self.chan], now=at(20, 15, 4), sync=sync)                     # the original tick, as always
        self.assertEqual(ids(out), ["default"])
        self.assertIn("::warning::", err)

    def test_attempt_rows_are_read_only_when_a_channel_is_a_candidate(self):
        sync = self.sync()
        run(3, [self.chan], now=at(20, 3, 5), sync=sync)
        self.assertEqual(sync.reads, [])

    def test_a_read_that_hit_its_row_limit_is_unknown_not_zero(self):
        many = [attempt("shop", f"2026-10-{d:02d}T10:00:00Z", 1) for d in range(1, 29)] * 40
        sync = FakeSupabase([self.chan], events=many)
        self.assertIsNone(schedule_catchup.read_attempts(sync, at(20, 17)))

    def test_malformed_rows_are_ignored_not_counted(self):
        junk = [{"event_key": "slot-attempt:default:whenever:1", "event": "schedule.attempt"},
                {"event_key": "other", "event": "schedule.attempt"}, {"event": "schedule.attempt"}]
        self.assertEqual(schedule_catchup.read_attempts(self.sync(*junk), at(20, 17)), {})


class TheGapInTheResolver(unittest.TestCase):
    """A slot whose latest attempt is less than the minimum gap old (default 60 minutes) is not handed out yet."""

    SLOT = "2026-10-20T15:00:00Z"

    def sync(self, *rows):
        return FakeSupabase([chan("default", hour=15)], events=list(rows))

    def claimed(self, n, ts):
        return {**attempt("default", self.SLOT, n), "ts": ts}

    def test_nothing_is_handed_out_until_the_gap_has_passed(self):
        sync = self.sync(self.claimed(1, "2026-10-20T15:05:00Z"))
        rows = [chan("default", hour=15)]
        for minute, backup in ((10, False), (15, True), (30, True), (45, True), (59, True)):
            out, err = run(15, rows, now=at(20, 15, minute), sync=sync, backup=backup)
            self.assertEqual(out, [], minute)
        self.assertIn("waiting before another", err)
        self.assertEqual(run(16, rows, now=at(20, 16, 4), sync=sync, backup=True)[0], [])     # 59 minutes
        self.assertEqual(ids(run(16, rows, now=at(20, 16, 5), sync=sync, backup=True)[0]), ["default"])   # 60

    def test_the_latest_attempt_sets_the_gap(self):
        sync = self.sync(self.claimed(1, "2026-10-20T15:05:00Z"), self.claimed(2, "2026-10-20T16:00:00Z"))
        env = {schedule_catchup.ATTEMPT_ENV: "3"}
        rows = [chan("default", hour=15)]
        self.assertEqual(run(16, rows, now=at(20, 16, 30), sync=sync, env=env)[0], [])
        self.assertEqual(run(16, rows, now=at(20, 16, 45), sync=sync, env=env)[0], [])        # 60 after the FIRST only
        self.assertEqual(ids(run(17, rows, now=at(20, 17, 0), sync=sync, env=env)[0]), ["default"])

    def test_naive_and_z_timestamps_both_count_and_an_unreadable_one_counts_as_just_claimed(self):
        rows = [chan("default", hour=15)]
        for ts, want in (("2026-10-20T15:05:00", ["default"]), ("2026-10-20T16:20:00.5", []), ("nonsense", [])):
            sync = self.sync(self.claimed(1, ts))
            self.assertEqual(ids(run(16, rows, now=at(20, 16, 30), sync=sync)[0]), want, ts)

    def test_the_variable_moves_the_gap(self):
        sync = self.sync(self.claimed(1, "2026-10-20T15:05:00Z"))
        rows = [chan("default", hour=15)]
        env = {schedule_catchup.GAP_ENV: "10"}
        self.assertEqual(ids(run(15, rows, now=at(20, 15, 16), sync=sync, env=env, backup=True)[0]), ["default"])
        env = {schedule_catchup.GAP_ENV: "120"}
        self.assertEqual(run(16, rows, now=at(20, 16, 30), sync=sync, env=env)[0], [])


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
        self.assertEqual(due_hours, [15, 16, 17, 18])           # by default too: the exact hour plus three

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
            self.assertEqual(self.say(value), (3, []))

    def test_whole_numbers_up_to_six(self):
        for n in range(0, 7):
            self.assertEqual(self.say(str(n)), (n, []))

    def test_quotes_and_spaces_are_forgiven(self):
        self.assertEqual(self.say(' "2" ')[0], 2)

    def test_garbage_is_the_default_with_a_warning_that_never_echoes_it(self):
        for value in ("abc", "1.5", "-1", "3h", "∞", "SENTINEL-7"):
            got, said = self.say(value)
            self.assertEqual(got, 3, value)
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
