"""Reliability alerts: silence is an incident (modules/operator_bot/reliability.py).

The dead-man switch and its arithmetic (UTC hour, day boundaries, paused / disabled / customer channels, a first
ever run, runs still in progress), the daily workflow's failures, per-video events, the scheduled readiness check,
provider freshness, the "recovered" note, and the restraint around all of it (one alert per cause per channel per
day, restart idempotency, quiet hours, mute). Fakes only: no network, no provider, no secret."""

import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from modules.operator_bot import alerts, owner_digest, reliability, views
from modules.operator_bot.config import DEFAULT_DEADMAN_HOURS, OperatorConfig, parse_deadman_hours
from modules.operator_bot.i18n import LANGUAGES, table
from tests.operator_bot_fakes import FakeHttp, FakeSync, github_ok, healthy_tables, site_ok, ts
from tests.test_operator_bot_alerts import Clock, build, heartbeat

UTC = timezone.utc
DEFAULT_ORG = "00000000-0000-0000-0000-000000000001"
DAILY = "https://api.github.com/repos/owner/repo/actions/workflows/daily_video.yml"
T = datetime(2026, 10, 14, 19, 0, tzinfo=UTC)          # three hours after the default 15:00 slot, plus one


def at(day, hour, minute=0):
    return datetime(2026, 10, day, hour, minute, tzinfo=UTC)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def channel(cid="default", hour=15, status="ACTIVE", enabled=True, verified=True, org=DEFAULT_ORG,
            created="2026-01-01T00:00:00Z", updated="2026-01-01T00:00:00Z", grace=None):
    sched = {"enabled": enabled}
    if hour is not None:
        sched["publish_hour_utc"] = hour
    if grace is not None:
        sched["deadman_grace_hours"] = grace
    cred = {"verified_at": "2026-01-01T00:00:00Z", "youtube_channel_id": "UCabcdefgh"} if verified else {}
    return {"channel_id": cid, "status": status, "schedule_config": sched, "credential_ref": cred, "org_id": org,
            "created_at": created, "updated_at": updated}


def video(vid="vid1", cid="default", state="held", held=None, published=None, detail=None, fmt="long", parent=None):
    """A videos row as the server answers the bot's select: the hold's cause is the one word the path select returns."""
    return {"video_id": vid, "channel_id": cid, "publish_state": state, "video_format": fmt, "parent_video_id": parent,
            "held_at": iso(held) if held else None, "published_at": iso(published) if published else None,
            "hold_cause": (detail or {}).get("cause"), "hold_stage": (detail or {}).get("stage")}


def storyboard(when, cid="default", sid="sb1"):
    return {"id": sid, "channel_id": cid, "status": "ready", "created_at": iso(when)}


def event(name="system.started", when=None, cid="default"):
    return {"event": name, "ts": iso(when), "channel_id": cid}


def gh_run(rid, event_="schedule", status="completed", conclusion="success", created=None, updated=None, number=None):
    created = created or at(14, 15, 1)
    return {"id": rid, "run_number": number or rid, "event": event_, "status": status, "conclusion": conclusion,
            "head_sha": "abcdef1234567", "created_at": iso(created), "run_started_at": iso(created),
            "updated_at": iso(updated or created + timedelta(minutes=20))}


def daily(*runs):
    return {DAILY: (200, {"workflow_runs": list(runs)})}


def jobs(rid, *items):
    return {f"https://api.github.com/repos/owner/repo/actions/runs/{rid}/jobs": (200, {"jobs": list(items)})}


def made(vid, when, cid="default"):
    """A video that was uploaded (not held): evidence for the dead-man, and no "held for review" note."""
    return video(vid, cid=cid, state="uploaded", published=when)


#: Yesterday's slot satisfied, so only the day under test matters.
YESTERDAY_OK = [video("old", held=at(13, 15, 30))]


def make(now=T, channels=None, videos=None, events=None, http=None, tables=None, cfg=None, synth_default=False):
    clock = Clock(now)
    if channels and not synth_default and not any(c["channel_id"] == "default" for c in channels):
        channels = channels + [channel(status="PAUSED")]       # a default row that is not scheduled (see F9 tests)
    t = {"channels": [channel()] if channels is None else channels,
         "videos": YESTERDAY_OK + (videos or []), "system_events": events or [], "storyboards": []}
    t.update(tables or {})
    return build(t, http, cfg, clock)


def run_detect(**kw):
    engine, _, _, ops, clock = make(**kw)
    return alerts.detect(ops, 15000), engine, ops, clock


def keys(found, prefix="deadman:"):
    return [a.key for a in found if a.key.startswith(prefix)]


class DeadManArithmeticTestCase(unittest.TestCase):
    def test_nothing_is_due_before_the_deadline_and_it_is_due_at_it(self):
        self.assertEqual(keys(run_detect(now=at(14, 17, 59))[0]), [])
        found = run_detect(now=at(14, 18, 0))[0]
        self.assertEqual(keys(found), ["deadman:default:2026-10-14"])
        a = [x for x in found if x.key.startswith("deadman:")][0]
        self.assertEqual((a.kind, a.severity, a.channel_id, a.cooldown_min), ("pipeline", "warn", "default", 0))
        self.assertIn("2026-10-14 15:00 UTC", a.line)

    def test_a_video_row_or_a_run_event_since_the_slot_is_enough(self):
        self.assertEqual(keys(run_detect(videos=[video("v", held=at(14, 15, 40))])[0]), [])
        self.assertEqual(keys(run_detect(videos=[video("v", state="uploaded", published=at(14, 16, 5))])[0]), [])
        self.assertEqual(keys(run_detect(events=[event("system.started", at(14, 15, 2))])[0]), [])
        self.assertEqual(keys(run_detect(events=[event("upload.failed", at(14, 15, 50))])[0]), [])

    def test_evidence_from_before_the_slot_is_not_evidence(self):
        before = run_detect(videos=[video("v", held=at(14, 14, 59))], events=[event("system.started", at(14, 14, 59))])[0]
        self.assertEqual(keys(before), ["deadman:default:2026-10-14"])
        exactly = run_detect(events=[event("system.started", at(14, 15, 0))])[0]
        self.assertEqual(keys(exactly), [])                     # the slot's own second counts

    def test_a_storyboard_waiting_for_a_person_is_evidence_and_earns_a_recovered_note(self):
        engine, _, _, ops, _ = make(videos=[])
        ops.sync.tables["storyboards"] = [storyboard(at(14, 15, 20))]
        self.assertEqual(keys(alerts.detect(ops, 15000, verdicts=(v := reliability.Verdicts())), "deadman:default:2026-10-14"), [])
        self.assertIn("deadman:default:2026-10-14", v.fine)

    def test_a_run_event_silences_the_alarm_but_never_earns_a_recovered_note(self):
        # events reach Supabase only when the daily poll mirrors them: they prove a run began, not that a video exists
        engine, _, _, ops, _ = make(videos=[], events=[event("system.started", at(14, 15, 2))])
        v = reliability.Verdicts()
        self.assertEqual(keys(alerts.detect(ops, 15000, verdicts=v), "deadman:default:2026-10-14"), [])
        self.assertNotIn("deadman:default:2026-10-14", v.fine)

    def test_an_event_that_is_not_a_run_is_not_evidence(self):
        found = run_detect(events=[event("feedback.generated", at(14, 16, 0))])[0]
        self.assertEqual(keys(found), ["deadman:default:2026-10-14"])

    def test_another_channels_video_is_not_this_channels(self):
        found = run_detect(channels=[channel("default"), channel("second", hour=15)],
                           videos=[video("v", cid="second", held=at(14, 15, 30))])[0]
        self.assertEqual([k for k in keys(found) if k.endswith("2026-10-14")], ["deadman:default:2026-10-14"])

    def test_the_slot_is_the_utc_hour_whatever_the_servers_zone(self):
        # hour 0: today's slot began at midnight UTC, so 03:00 is past its deadline
        found = run_detect(now=at(14, 3, 0), channels=[channel("night", hour=0)], videos=[])[0]
        self.assertIn("deadman:night:2026-10-14", keys(found))

    def test_a_slot_late_in_the_day_crosses_midnight_and_keeps_its_own_date(self):
        ch = [channel("late", hour=23)]
        self.assertEqual(keys(run_detect(now=at(15, 1, 0), channels=ch, videos=[])[0]), [])      # 23:00 + 3h = 02:00
        found = run_detect(now=at(15, 2, 0), channels=ch, videos=[])[0]
        self.assertEqual(keys(found), ["deadman:late:2026-10-14"])                              # the slot's date, not today's
        # a video finished after midnight still satisfies the slot that began the evening before
        ok = run_detect(now=at(15, 2, 0), channels=ch, videos=[video("v", cid="late", held=at(15, 0, 30))])[0]
        self.assertEqual(keys(ok), [])

    def test_a_missed_slot_is_still_news_the_next_morning_but_not_for_ever(self):
        self.assertEqual(keys(run_detect(now=at(15, 9, 0), videos=[], channels=[channel()])[0], "deadman:default:2026-10-14"),
                         ["deadman:default:2026-10-14"])
        last = run_detect(now=at(15, 23, 59), videos=[])[0]                     # still "yesterday" for 24 more hours
        self.assertIn("deadman:default:2026-10-14", keys(last))
        gone = run_detect(now=at(16, 0, 0), videos=[])[0]                       # two days back: never repeated
        self.assertNotIn("deadman:default:2026-10-14", keys(gone))
        self.assertIn("deadman:default:2026-10-15", keys(gone))

    def test_the_next_slots_video_is_not_this_slots(self):
        # yesterday (10-14 15:00) produced nothing; today's regular video must not paper over it
        engine, _, _, ops, _ = make(now=at(15, 18, 0), videos=[made("today", at(15, 15, 30))])
        ops.sync.tables["videos"] = [made("today", at(15, 15, 30))]
        v = reliability.Verdicts()
        found = alerts.detect(ops, 15000, verdicts=v)
        self.assertEqual(keys(found), ["deadman:default:2026-10-14"])
        self.assertIn("deadman:default:2026-10-15", v.fine)

    def test_a_late_rerun_before_the_next_slot_does_satisfy_the_missed_one(self):
        engine, _, _, ops, _ = make(now=at(15, 12, 0))
        ops.sync.tables["videos"] = [made("rerun", at(15, 9, 0))]
        v = reliability.Verdicts()
        found = alerts.detect(ops, 15000, verdicts=v)
        self.assertEqual(keys(found), [])
        self.assertIn("deadman:default:2026-10-14", v.fine)

    def test_an_unset_hour_means_the_schedulers_default(self):
        from tools import list_channels
        self.assertEqual(reliability.DEFAULT_HOUR_UTC, list_channels.DEFAULT_HOUR_UTC)
        found = run_detect(now=at(14, 18, 0), channels=[channel(hour=None)], videos=[])[0]
        self.assertIn("deadman:default:2026-10-14", keys(found))
        early = run_detect(now=at(14, 17, 0), channels=[channel(hour=None)], videos=[])[0]
        self.assertNotIn("deadman:default:2026-10-14", keys(early))

    def test_the_default_grace_is_three_hours_and_can_be_changed_or_switched_off(self):
        self.assertEqual(DEFAULT_DEADMAN_HOURS, 3)
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", deadman_hours=1)
        self.assertIn("deadman:default:2026-10-14", keys(run_detect(now=at(14, 16, 0), cfg=cfg, videos=[])[0]))
        off = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", deadman_hours=None)
        self.assertEqual(keys(run_detect(now=at(15, 9, 0), cfg=off, videos=[])[0]), [])

    def test_a_channel_can_carry_its_own_grace(self):
        ch = [channel(grace=6)]
        self.assertEqual(keys(run_detect(now=at(14, 20, 0), channels=ch, videos=[])[0], "deadman:default:2026-10-14"), [])
        self.assertIn("deadman:default:2026-10-14", keys(run_detect(now=at(14, 21, 0), channels=ch, videos=[])[0]))
        bad = [channel(grace=99)]                                # out of range: the default applies
        self.assertIn("deadman:default:2026-10-14", keys(run_detect(now=at(14, 18, 0), channels=bad, videos=[])[0]))

    def test_the_config_value_fails_safe(self):
        self.assertEqual(parse_deadman_hours(None), 3)
        self.assertEqual(parse_deadman_hours(""), 3)
        self.assertEqual(parse_deadman_hours("5"), 5)
        self.assertEqual(parse_deadman_hours(" OFF "), None)
        for junk in ("0", "13", "-2", "soon", "3h"):
            self.assertEqual(parse_deadman_hours(junk), 3, junk)      # a typo must not silence the alert
        self.assertEqual(OperatorConfig.from_env({"OPERATOR_DEADMAN_HOURS": "off"}).deadman_hours, None)
        self.assertEqual(OperatorConfig.from_env({}).deadman_hours, 3)


class WhoIsExpectedTestCase(unittest.TestCase):
    def silent(self, **kw):
        found = run_detect(videos=[], **kw)[0]
        return keys(found, "deadman:default:2026-10-14") + keys(found, "deadman:other:2026-10-14")

    def test_a_paused_a_schedule_disabled_and_an_unverified_channel_are_not_expected(self):
        for ch in (channel(status="PAUSED"), channel(enabled=False), channel("other", verified=False),
                   channel(status="whatever")):
            self.assertEqual(self.silent(channels=[ch]), [], ch)
        self.assertEqual(len(self.silent(channels=[channel()])), 1)

    def test_a_customers_channel_is_never_watched(self):
        theirs = channel("other", org="11111111-1111-1111-1111-111111111111")
        self.assertEqual(self.silent(channels=[theirs]), [])

    def test_a_default_channel_with_no_row_is_synthesized_like_the_registry_does(self):
        other = [channel("other")]
        engine, _, _, ops, _ = make(channels=other, videos=[], synth_default=True)
        found = [k for k in keys(alerts.detect(ops, 15000)) if k.endswith("2026-10-14")]
        self.assertEqual(sorted(found), ["deadman:default:2026-10-14", "deadman:other:2026-10-14"])

    def test_a_default_id_owned_by_another_organization_is_not_synthesized(self):
        # channel_id is the primary key: a customer's 'default' row means the scheduler skips it and never synthesizes
        theirs = channel("default", org="11111111-1111-1111-1111-111111111111")
        engine, _, _, ops, _ = make(channels=[channel("other"), theirs], videos=[], synth_default=True)
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:default:2026-10-14"), [])

    def test_the_default_check_asks_for_the_id_only_and_an_unreadable_answer_is_not_a_schedule(self):
        engine, _, _, ops, _ = make(channels=[channel("other")], videos=[], synth_default=True)
        ev = reliability.Evidence(ops, T)
        read = [p for tbl, p in ops.sync.reads if tbl == "channels" and p.get("channel_id") == "eq.default"]
        self.assertEqual((read[0]["select"], read[0]["limit"]), ("channel_id", "1"))
        self.assertIn("default", [c.channel_id for c in ev.sched])
        engine, _, _, ops, _ = make(channels=[channel("other")], videos=[], synth_default=True)
        real = ops.sync.select_strict

        def refuse(table, params=None):
            if table == "channels" and (params or {}).get("channel_id") == "eq.default":
                from modules.supabase_sync import SupabaseReadError
                raise SupabaseReadError(table, 500, "")
            return real(table, params)

        ops.sync.select_strict = refuse
        ev = reliability.Evidence(ops, T)
        self.assertNotIn("default", [c.channel_id for c in ev.sched])
        self.assertIn("channels", ev.blind)

    def test_a_paused_default_row_is_not_synthesized_over_and_an_empty_table_is_unknown(self):
        engine, _, _, ops, _ = make(channels=[channel(status="PAUSED")], videos=[], synth_default=True)
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:default:2026-10-14"), [])
        self.assertEqual(reliability.scheduled_channels([]), [])

    def test_the_default_channel_needs_no_verification_like_the_scheduler(self):
        self.assertEqual(len(self.silent(channels=[channel(verified=False)])), 1)

    def test_an_empty_or_unreadable_channel_table_is_an_unknown_not_a_schedule(self):
        self.assertEqual(self.silent(channels=[]), [])
        engine, _, _, ops, _ = make(videos=[])
        ops.sync.fail = {"channels"}
        self.assertEqual(keys(alerts.detect(ops, 15000)), [])

    def test_the_channel_query_asks_only_for_the_operators_own_rows(self):
        _, _, ops, _ = run_detect(videos=[])
        reads = [p for tbl, p in ops.sync.reads if tbl == "channels"]
        self.assertTrue(reads)
        self.assertEqual(reads[0]["org_id"], f"eq.{DEFAULT_ORG}")

    def test_a_channel_created_after_its_slot_with_no_history_was_not_due(self):
        new = channel("other", created="2026-10-14T16:30:00Z", updated="2026-10-14T16:30:00Z")
        engine, _, _, ops, _ = make(channels=[new], videos=[], now=at(14, 19, 0))
        ops.sync.tables["videos"] = []
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:other"), [])

    def test_a_channel_created_before_its_slot_is_due_on_its_first_day(self):
        new = channel("other", created="2026-10-14T10:00:00Z", updated="2026-10-14T10:00:00Z")
        engine, _, _, ops, _ = make(channels=[new], videos=[], now=at(14, 19, 0))
        ops.sync.tables["videos"] = []
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:other"), ["deadman:other:2026-10-14"])

    def test_an_edit_after_the_slot_does_not_hide_a_channel_that_has_been_running(self):
        edited = channel(updated="2026-10-14T16:30:00Z")
        found = run_detect(channels=[edited], videos=[video("y", held=at(13, 15, 30))])[0]
        self.assertEqual(keys(found, "deadman:default:2026-10-14"), ["deadman:default:2026-10-14"])


class InProgressAndCauseTestCase(unittest.TestCase):
    def line(self, http=None, **kw):
        found = run_detect(videos=[], http=http, **kw)[0]
        return [a for a in found if a.key == "deadman:default:2026-10-14"]

    def test_a_run_still_in_progress_is_not_silence(self):
        run = gh_run(70, status="in_progress", conclusion=None, created=at(14, 16, 0), updated=at(14, 18, 50))
        self.assertEqual(self.line(daily(run)), [])

    def test_a_run_in_progress_for_longer_than_any_job_can_take_is_hung_not_working(self):
        run = gh_run(70, status="in_progress", conclusion=None, created=at(14, 15, 1), updated=at(14, 18, 59))
        self.assertEqual(len(self.line(daily(run), now=at(14, 19, 2))), 1)

    def test_what_the_run_list_says_is_named_as_the_likely_cause(self):
        none = self.line(daily(gh_run(1, created=at(13, 15, 1))))[0].line           # only yesterday's run
        self.assertIn("did not fire", none)
        queued = self.line(daily(gh_run(2, status="queued", conclusion=None)))[0].line
        self.assertIn("queued", queued)
        failed = self.line(daily(gh_run(3, conclusion="failure", number=41)))[0].line
        self.assertIn("#41", failed)
        self.assertIn("failure", failed)
        empty = self.line(daily(gh_run(4, conclusion="success")))[0].line
        self.assertIn("made nothing", empty)
        unknown = self.line({})[0].line
        self.assertIn("could not be read", unknown)

    def test_a_failed_run_since_the_slot_beats_a_queued_one_as_the_explanation(self):
        runs = [gh_run(1, status="queued", conclusion=None, created=at(14, 15, 20)),
                gh_run(2, conclusion="failure", created=at(14, 15, 2), number=77)]
        line = self.line(daily(*runs))[0].line
        self.assertIn("#77", line)

    def test_a_run_queued_long_after_the_slot_hour_is_not_the_slots_waiting_run(self):
        late_queue = gh_run(3, status="queued", conclusion=None, created=at(14, 18, 30))
        self.assertIn("did not fire", self.line(daily(late_queue))[0].line)

    def test_a_run_list_that_does_not_reach_the_slot_says_it_cannot_tell(self):
        from modules.operator_bot.sources import RUNS_PER_PAGE
        runs = [gh_run(1000 + i, created=at(14, 18, 0) - timedelta(minutes=i)) for i in range(RUNS_PER_PAGE)]
        runs = [r for r in runs if True]
        for r in runs:
            r["created_at"] = iso(at(14, 18, 0) - timedelta(seconds=int(r["id"]) - 1000))     # all after 15:00
        line = self.line(daily(*runs))[0].line
        self.assertIn("does not reach back", line)
        self.assertNotIn("did not fire", line)
        short = self.line(daily(gh_run(1, created=at(13, 18, 0))))[0].line                    # a short list covers its history
        self.assertIn("did not fire", short)

    def test_the_run_list_asks_for_a_hundred_runs(self):
        engine, _, _, ops, _ = make(videos=[], http=daily())
        alerts.detect(ops, 15000)
        urls = [u for u, _h in ops.http_get.calls if "daily_video.yml" in u]
        self.assertTrue(urls and urls[0].endswith("per_page=100"))

    def test_a_manual_dispatch_counts_as_a_run_and_a_pull_request_does_not(self):
        manual = self.line(daily(gh_run(5, event_="workflow_dispatch", conclusion="failure")))[0].line
        self.assertIn("failure", manual)
        other = self.line(daily(gh_run(6, event_="pull_request", conclusion="failure")))[0].line
        self.assertIn("did not fire", other)

    def test_a_run_from_before_the_slot_is_not_this_slots_run(self):
        old = gh_run(7, status="in_progress", conclusion=None, created=at(14, 14, 0), updated=at(14, 18, 59))
        self.assertEqual(len(self.line(daily(old))), 1)


class UnknownIsNotSilenceTestCase(unittest.TestCase):
    def test_unreadable_evidence_is_never_reported_as_a_missing_video(self):
        for failing in ({"videos"}, {"system_events"}):
            engine, _, _, ops, _ = make(videos=[])
            ops.sync.fail = failing
            self.assertEqual(keys(alerts.detect(ops, 15000)), [], failing)

    def test_evidence_that_was_read_still_proves_a_video_when_the_other_source_is_down(self):
        engine, _, _, ops, _ = make(videos=[video("v", held=at(14, 15, 30))])
        ops.sync.fail = {"system_events"}
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:default:2026-10-14"), [])

    def test_a_read_that_hit_its_row_limit_cannot_prove_absence(self):
        rows = [event("system.started", at(12, 1, 0), cid="default") for _ in range(2000)]
        engine, _, _, ops, _ = make(videos=[], events=rows)
        self.assertEqual(keys(alerts.detect(ops, 15000), "deadman:default:2026-10-14"), [])

    def test_a_customers_events_cannot_crowd_out_the_operators_evidence(self):
        _, _, ops, _ = run_detect(videos=[], events=[])
        read = [p for tbl, p in ops.sync.reads if tbl == "system_events"][0]
        self.assertEqual(read["channel_id"], "in.(default)")
        self.assertNotIn("metadata", read["select"])
        self.assertEqual(read["select"], "event,ts,channel_id")
        vids = [p for tbl, p in ops.sync.reads if tbl == "videos"][0]
        self.assertEqual(vids["channel_id"], "in.(default)")
        self.assertEqual(vids["select"], "video_id,channel_id,publish_state,published_at,held_at,video_format,"
                                         "parent_video_id,hold_cause:hold_detail->>cause,hold_stage:hold_detail->>stage")
        # no server-side parent filter: the mirror writes '' not NULL, and is.null would drop every master
        self.assertNotIn("parent_video_id", vids)
        boards = [p for tbl, p in ops.sync.reads if tbl == "storyboards"][0]
        self.assertEqual(boards["select"], "id,channel_id,status,created_at")        # no scenes, no script, no title
        self.assertEqual(boards["channel_id"], "in.(default)")


class BlindTestCase(unittest.TestCase):
    """A dead-man switch that cannot read its evidence says so once a day after six continuous hours."""

    def run_hours(self, hours, fail=("storyboards",), start=at(14, 4, 0), flicker=None):
        engine, store, tg, ops, clock = make(now=start, videos=[])
        engine.tick()                                                         # baseline
        sent = []
        for step in range(hours * 6 + 1):                                     # a pass every 10 minutes
            clock.now = start + timedelta(minutes=10 * step)
            heartbeat(ops, clock)
            hour = step // 6
            ops.sync.fail = set(fail) if not (flicker and hour in flicker) else set()
            sent.append(engine.tick())
        return tg, sent

    def test_nothing_is_said_before_six_hours_of_unknown(self):
        tg, _ = self.run_hours(4)
        self.assertFalse([t for t in tg.texts() if "cannot judge" in t])

    def test_after_six_hours_it_is_said_once_and_names_the_source(self):
        tg, _ = self.run_hours(9)
        said = [t for t in tg.texts() if "cannot judge" in t]
        self.assertEqual(len(said), 1)
        self.assertIn("storyboards", said[0])
        self.assertIn("INFO — tokens and providers", said[0])

    def test_a_source_that_reads_again_breaks_the_run_of_hours(self):
        tg, _ = self.run_hours(9, flicker={5})
        self.assertFalse([t for t in tg.texts() if "cannot judge" in t])

    def test_it_is_said_again_the_next_day_if_it_lasts(self):
        tg, _ = self.run_hours(32)
        self.assertEqual(len([t for t in tg.texts() if "cannot judge" in t]), 2)

    def test_the_markers_are_silent_and_the_first_pass_records_none(self):
        engine, store, tg, ops, clock = make(now=at(14, 4, 0), videos=[])
        ops.sync.fail = {"storyboards"}
        engine.tick()                                                         # baseline: armed marker only
        self.assertFalse([r for r in store.rows if r["title"].startswith("blindmark:")])
        clock.now = at(14, 4, 10)
        heartbeat(ops, clock)
        engine.tick()
        marks = [r for r in store.rows if r["title"].startswith("blindmark:")]
        self.assertEqual(len(marks), 1)
        self.assertFalse(marks[0]["delivered"])

    def test_blind_sources_are_named_by_the_evidence(self):
        engine, _, _, ops, _ = make(videos=[])
        ops.sync.fail = {"storyboards", "system_events"}
        ev = reliability.Evidence(ops, T)
        self.assertEqual(ev.blind, ["storyboards", "events"])
        self.assertFalse(ev.known)

    def test_the_digest_says_unknown_when_storyboards_cannot_be_read(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[])
        ops.sync.fail = {"storyboards"}
        text = reliability.digest_lines(ops, "en")[0]
        self.assertIn("unknown", text)
        self.assertNotIn("default:", text)                                    # one honest line, not a per-channel guess


class RestraintTestCase(unittest.TestCase):
    """The engine's restraint applies to the new alerts unchanged: one per cause per channel per day, across
    restarts, quiet hours and mute."""

    def armed(self, **kw):
        engine, store, tg, ops, clock = make(**kw)
        engine.ops.sync.tables["videos"] = YESTERDAY_OK + engine.ops.sync.tables["videos"][1:]
        return engine, store, tg, ops, clock

    def arm_before_the_deadline(self, **kw):
        kw.setdefault("now", at(14, 12, 0))
        engine, store, tg, ops, clock = make(**kw)
        self.assertTrue(engine.tick().baseline)
        return engine, store, tg, ops, clock

    def test_a_missed_video_is_one_alert_that_does_not_repeat_through_the_day(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        text = tg.texts()[-1]
        self.assertIn("WARN — video pipeline", text)
        self.assertIn("No video from channel default", text)
        row = tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in row], ["Open", "Mute 24h", "Details"])
        self.assertEqual(row[0]["url"], "https://app.example.test/default/errors")
        self.assertEqual((row[1]["callback_data"], row[2]["callback_data"]), ("a:mute:pipeline", "d:pipeline"))
        for minutes in (5, 60, 240):
            clock.advance(minutes=minutes)
            heartbeat(ops, clock)
            self.assertEqual(engine.tick().sent, 0, minutes)

    def test_the_next_day_is_a_new_alert(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        clock.now = at(15, 18, 0)
        heartbeat(ops, clock)
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        self.assertIn("2026-10-15 15:00", tg.texts()[-1])

    def test_a_restart_repeats_nothing(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        reborn = alerts.AlertEngine(ops, store, engine.control, engine.cfg, low_credits=15000)   # the process restarted
        clock.advance(minutes=10)
        heartbeat(ops, clock)
        self.assertEqual(reborn.tick().sent, 0)
        self.assertEqual(len(tg.sent()), 2)                                    # "on" + one alert, ever

    def test_a_restart_with_a_store_that_refused_the_row_still_repeats_nothing(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        store.fail_write = True
        self.assertEqual(engine.tick().sent, 1)
        clock.advance(minutes=10)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)                                # remembered in memory until the store takes it

    def test_quiet_hours_hold_it_and_it_goes_out_after_the_window_if_it_still_applies(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(17, 22))
        engine, store, tg, ops, clock = self.arm_before_the_deadline(cfg=cfg)
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (0, 1))
        clock.now = at(14, 22, 5)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("No video from channel default", tg.texts()[-1])

    def test_a_held_alert_that_no_longer_applies_is_dropped_not_sent_late(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(17, 22))
        engine, store, tg, ops, clock = self.arm_before_the_deadline(cfg=cfg)
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        engine.tick()
        ops.sync.tables["videos"].append(made("late", at(14, 19, 30)))           # the video arrived during the quiet window
        clock.now = at(14, 22, 5)
        heartbeat(ops, clock)
        before = len(tg.sent())
        engine.tick()
        self.assertEqual(len(tg.sent()), before)

    def test_mute_silences_the_kind_and_marks_it_seen(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        alerts.mute(store, "pipeline", clock.now)
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (0, 1))
        self.assertEqual(alerts.mute(store, "bogus", clock.now), None)

    def test_two_channels_are_two_alerts_in_one_message(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline(
            channels=[channel("default"), channel("second", hour=14)])
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        ops.sync.tables["videos"] = YESTERDAY_OK + [video("o2", cid="second", held=at(13, 14, 30))]
        rep = engine.tick()
        self.assertEqual(rep.sent, 2)
        self.assertEqual(tg.texts()[-1].count("• No video from channel"), 2)

    def test_one_broken_alert_source_never_stops_the_pass(self):
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        ops.sync.tables["render_jobs"] = [{"id": 5, "channel_id": "default", "kind": "daily", "status": "failed",
                                           "attempts": 3, "max_attempts": 3, "finished_at": ts(30, clock.now),
                                           "created_at": ts(50, clock.now), "heartbeat_at": None, "started_at": None}]
        with patch.object(reliability, "deadman", side_effect=RuntimeError("boom")):
            rep = engine.tick()
        self.assertEqual(rep.sent, 1)                                          # the render failure still went out
        self.assertIn("Render job #5", tg.texts()[-1])

    def test_a_detector_that_fails_logs_once_not_every_pass(self):
        reliability._logged.discard("deadman")
        engine, store, tg, ops, clock = self.arm_before_the_deadline()
        with patch.object(reliability, "deadman", side_effect=RuntimeError("boom")):
            with self.assertLogs("modules.operator_bot.reliability", level="WARNING") as cm:
                for _ in range(3):
                    clock.advance(minutes=5)
                    heartbeat(ops, clock)
                    engine.tick()
        self.assertEqual(len([m for m in cm.output if "deadman skipped" in m]), 1)


class RecoveredTestCase(unittest.TestCase):
    def setUp(self):
        reliability._logged.clear()
        self.engine, self.store, self.tg, self.ops, self.clock = make(now=at(14, 12, 0))
        self.engine.tick()                                                   # baseline
        self.clock.now = at(14, 18, 0)
        heartbeat(self.ops, self.clock)
        self.assertEqual(self.engine.tick().sent, 1)                         # the dead-man alert

    def test_a_delivered_alert_is_followed_once_by_a_recovered_note(self):
        self.ops.sync.tables["videos"].append(made("late", at(14, 19, 30)))
        self.clock.now = at(14, 20, 0)
        heartbeat(self.ops, self.clock)
        rep = self.engine.tick()
        self.assertEqual(rep.sent, 1)
        self.assertIn("INFO — video pipeline", self.tg.texts()[-1])
        self.assertIn("Recovered: channel default", self.tg.texts()[-1])
        for _ in range(3):
            self.clock.advance(minutes=30)
            heartbeat(self.ops, self.clock)
            self.assertEqual(self.engine.tick().sent, 0)

    def test_no_note_while_it_is_still_broken(self):
        for _ in range(3):
            self.clock.advance(minutes=30)
            heartbeat(self.ops, self.clock)
            self.assertEqual(self.engine.tick().sent, 0)

    def test_no_note_when_the_evidence_cannot_be_read(self):
        self.ops.sync.tables["videos"].append(made("late", at(14, 19, 30)))
        self.ops.sync.fail = {"system_events"}                               # unknown is not recovered ... (videos proves it)
        self.clock.now = at(14, 20, 0)
        heartbeat(self.ops, self.clock)
        self.assertEqual(self.engine.tick().sent, 1)                         # ... but a read video IS proof
        engine2, _, tg2, ops2, clock2 = make(now=at(14, 12, 0))
        engine2.tick()
        clock2.now = at(14, 18, 0)
        heartbeat(ops2, clock2)
        engine2.tick()
        ops2.sync.fail = {"videos", "system_events"}
        clock2.now = at(14, 20, 0)
        heartbeat(ops2, clock2)
        self.assertEqual(engine2.tick().sent, 0)

    def test_an_alert_that_was_muted_gets_no_recovered_note(self):
        engine, store, tg, ops, clock = make(now=at(14, 12, 0))
        engine.tick()
        alerts.mute(store, "pipeline", clock.now)
        clock.now = at(14, 18, 0)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().muted, 1)
        ops.sync.tables["videos"].append(made("late", at(14, 19, 30)))
        clock.now = at(14, 20, 0)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_recovery_after_a_restart_is_still_said_once(self):
        self.ops.sync.tables["videos"].append(made("late", at(14, 19, 30)))
        self.clock.now = at(14, 20, 0)
        heartbeat(self.ops, self.clock)
        reborn = alerts.AlertEngine(self.ops, self.store, self.engine.control, self.engine.cfg, low_credits=15000)
        self.assertEqual(reborn.tick().sent, 1)
        self.assertEqual(self.engine.tick().sent, 0)


class WorkflowFailureTestCase(unittest.TestCase):
    def failed(self, http, **kw):
        found = run_detect(http=http, **kw)[0]
        return [a for a in found if a.key.startswith("wf:daily:")]

    def test_a_failed_scheduled_run_names_the_channel_and_the_step(self):
        http = {**daily(gh_run(90, conclusion="failure", number=57, created=at(14, 15, 1), updated=at(14, 15, 40))),
                **jobs(90, {"name": "resolve", "conclusion": "success", "steps": []},
                       {"name": "make-video (default)", "conclusion": "failure",
                        "steps": [{"name": "Set up Python 3.11", "conclusion": "success"},
                                  {"name": "Run Chronos bot", "conclusion": "failure"}]})}
        found = self.failed(http, now=at(14, 16, 0))
        self.assertEqual([(a.kind, a.key, a.severity, a.channel_id) for a in found],
                         [("pipeline", "wf:daily:2026-10-14:make-video-run-chronos-bot", "warn", "default")])
        self.assertIn("#57", found[0].line)
        self.assertIn("(schedule)", found[0].line)
        self.assertIn("default", found[0].line)
        self.assertIn("Run Chronos bot", found[0].line)
        self.assertIn("abcdef1", found[0].line)

    def test_a_manual_dispatch_that_failed_is_an_alert_too(self):
        found = self.failed(daily(gh_run(91, event_="workflow_dispatch", conclusion="timed_out", updated=at(14, 15, 40))),
                            now=at(14, 16, 0))
        self.assertEqual(len(found), 1)
        self.assertIn("(workflow_dispatch)", found[0].line)
        self.assertIn("timed_out", found[0].line)

    def test_without_the_job_list_the_alert_still_goes_out(self):
        found = self.failed(daily(gh_run(92, conclusion="failure", updated=at(14, 15, 40))), now=at(14, 16, 0))
        self.assertEqual(len(found), 1)
        self.assertNotIn("step", found[0].line)

    def test_runs_that_did_not_fail_or_are_not_the_schedules_are_not_alerts(self):
        runs = [gh_run(1, conclusion="success"), gh_run(2, conclusion="cancelled"),
                gh_run(3, conclusion="skipped"), gh_run(4, status="in_progress", conclusion=None),
                gh_run(5, event_="pull_request", conclusion="failure")]
        self.assertEqual(self.failed(daily(*runs), now=at(14, 16, 0)), [])

    def test_an_old_failure_is_not_news(self):
        old = gh_run(6, conclusion="failure", created=at(13, 15, 1), updated=at(13, 15, 40))
        self.assertEqual(self.failed(daily(old), now=at(14, 16, 0)), [])

    def test_only_the_names_of_the_workflow_reach_the_alert(self):
        http = {**daily(gh_run(93, conclusion="failure", updated=at(14, 15, 40))),
                **jobs(93, {"name": "make-video (default)", "conclusion": "failure",
                            "steps": [{"name": "Run <script>alert(1)</script> $TOKEN", "conclusion": "failure"}]})}
        line = self.failed(http, now=at(14, 16, 0))[0].line
        self.assertNotIn("<script>", line)

    def test_a_run_that_failed_before_the_bot_was_armed_is_history_and_a_new_day_is_a_new_alert(self):
        engine, store, tg, ops, clock = make(now=at(14, 14, 0), channels=[],
                                             http=daily(gh_run(94, conclusion="failure", created=at(14, 13, 1),
                                                               updated=at(14, 13, 20))))
        engine.tick()
        clock.now = at(14, 14, 30)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)
        ops.http_get = FakeHttp({**site_ok(), **github_ok(), **daily(
            gh_run(95, conclusion="failure", created=at(15, 9, 31), updated=at(15, 9, 45)))})
        clock.now = at(15, 9, 50)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        clock.now = at(15, 10, 0)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)

    def test_eleven_failed_runs_are_one_alert_that_counts_them(self):
        runs = [gh_run(100 + i, conclusion="failure", created=at(14, 4, 1) + timedelta(hours=i),
                       updated=at(14, 4, 20) + timedelta(hours=i)) for i in range(11)]
        found = self.failed(daily(*runs), now=at(14, 15, 0))
        self.assertEqual([a.key for a in found], ["wf:daily:2026-10-14:run"])
        self.assertIn("+10 more failed runs", found[0].line)

    def test_eleven_identical_failures_with_a_job_list_are_still_one_alert(self):
        runs = [gh_run(300 + i, conclusion="failure", created=at(14, 4, 1) + timedelta(hours=i),
                       updated=at(14, 4, 20) + timedelta(hours=i)) for i in range(11)]
        http = daily(*runs)
        for r in runs:
            http.update(jobs(r["id"], {"name": "make-video (default)", "conclusion": "failure",
                                       "steps": [{"name": "Run Chronos bot", "conclusion": "failure"}]}))
        found = self.failed(http, now=at(14, 15, 0))
        self.assertEqual([a.key for a in found], ["wf:daily:2026-10-14:make-video-run-chronos-bot"])
        self.assertIn("+10 more", found[0].line)

    def test_a_different_failure_later_the_same_day_is_its_own_alert(self):
        glitch = gh_run(400, conclusion="failure", created=at(14, 10, 1), updated=at(14, 10, 20))
        other = gh_run(401, conclusion="failure", created=at(14, 19, 1), updated=at(14, 19, 20))
        http = {**daily(other, glitch),
                **jobs(400, {"name": "make-video (default)", "conclusion": "failure",
                             "steps": [{"name": "Install system dependencies", "conclusion": "failure"}]}),
                **jobs(401, {"name": "make-video (default)", "conclusion": "failure",
                             "steps": [{"name": "Run Chronos bot", "conclusion": "failure"}]})}
        engine, store, tg, ops, clock = make(now=at(14, 10, 30), channels=[], http=http)
        found_1 = alerts.detect(ops, 15000)
        self.assertEqual(keys(found_1, "wf:daily:"), ["wf:daily:2026-10-14:make-video-install-system-dependenc"])
        engine.tick()                                                          # armed with the glitch seen
        clock.now = at(14, 19, 30)
        heartbeat(ops, clock)
        ops._cache.clear()
        found_2 = alerts.detect(ops, 15000)
        self.assertEqual(sorted(keys(found_2, "wf:daily:")),
                         ["wf:daily:2026-10-14:make-video-install-system-dependenc",
                          "wf:daily:2026-10-14:make-video-run-chronos-bot"])
        self.assertEqual(engine.tick().sent, 1)                                # only the new cause is new

    def test_a_broken_hourly_schedule_does_not_page_every_hour(self):
        engine, store, tg, ops, clock = make(now=at(14, 4, 0), channels=[])
        engine.tick()
        sent = 0
        for hour in range(5, 20):
            runs = [gh_run(200 + h, conclusion="failure", created=at(14, h, 1), updated=at(14, h, 20))
                    for h in range(5, hour)]
            ops.http_get = FakeHttp({**site_ok(), **github_ok(), **daily(*runs)})
            ops._cache.clear()
            clock.now = at(14, hour, 30)
            heartbeat(ops, clock)
            sent += engine.tick().sent
        self.assertEqual(sent, 1)

    def test_a_channel_that_is_not_the_operators_is_named_only_as_a_customer_channel(self):
        http = {**daily(gh_run(96, conclusion="failure", updated=at(14, 15, 40))),
                **jobs(96, {"name": "make-video (their-channel)", "conclusion": "failure",
                            "steps": [{"name": "Run Chronos bot", "conclusion": "failure"}]})}
        found = self.failed(http, now=at(14, 16, 0))
        self.assertIn("a customer channel", found[0].line)
        self.assertNotIn("their-channel", found[0].line)
        self.assertIsNone(found[0].channel_id)


class VideoEventsTestCase(unittest.TestCase):
    def found(self, videos=(), events=(), **kw):
        found = run_detect(videos=list(videos), events=list(events), now=at(14, 16, 0), **kw)[0]
        return [a for a in found if a.key.startswith("video:")]

    def test_a_blocked_video_a_failed_upload_and_a_held_video(self):
        found = self.found(videos=[
            video("run-aaaa", state="blocked", held=at(14, 15, 30)),
            video("run-bbbb", state="held", held=at(14, 15, 31)),
            video("run-cccc", state="held", held=at(14, 15, 32), detail={"reason": "held", "cause": "upload_failed"})])
        by_kind = sorted((a.key.split(":")[1], a.kind, a.severity) for a in found)
        self.assertEqual(by_kind, [("blocked", "pipeline", "warn"), ("held", "approval", "info"),
                                   ("upload_failed", "pipeline", "warn")])
        lines = {a.key.split(":")[1]: a.line for a in found}
        self.assertIn("run-aaaa", lines["blocked"])
        self.assertIn("run-bbbb", lines["held"])
        self.assertIn("run-cccc", lines["upload_failed"])

    def test_a_failed_upload_is_heard_even_though_the_workflow_run_ended_green(self):
        # main.py records a held row (cause upload_failed) and the job still succeeds: the row is the only sign
        engine, store, tg, ops, clock = make(now=at(14, 14, 0), http=daily(gh_run(1, conclusion="success")))
        engine.tick()
        ops.sync.tables["videos"].append(video("run-zzzz", state="held", held=at(14, 14, 20),
                                               detail={"cause": "upload_failed", "gate": {"allowed": True}}))
        clock.now = at(14, 14, 30)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("Upload failed", tg.texts()[-1])
        self.assertEqual(engine.tick().sent, 0)

    def test_every_hold_cause_has_its_own_alert_in_every_language(self):
        # "Out of quota today" is not "the connection is broken": each cause word is a different
        # alert (own key, own sentence), so the owner can tell them apart from the page.
        from modules import held_video
        from modules.operator_bot.i18n import t
        from modules.operator_bot.reliability import _HOLD_ALERT_COPY
        self.assertEqual(set(_HOLD_ALERT_COPY), set(held_video.HOLD_CAUSES))
        lines = {}
        for cause in held_video.HOLD_CAUSES:
            found = self.found(videos=[video("run-cccc", state="held", held=at(14, 15, 32),
                                             detail={"reason": "held", "cause": cause})])
            self.assertEqual([(a.key.split(":")[1], a.kind, a.severity) for a in found],
                             [(cause, "pipeline", "warn")])
            self.assertIn("run-cccc", found[0].line)
            lines[cause] = found[0].line
        self.assertEqual(len(set(lines.values())), len(lines))
        for lang in ("en", "ru", "uz"):
            texts = {t(lang, key, channel="news", video="run-1") for key in _HOLD_ALERT_COPY.values()}
            self.assertEqual(len(texts), len(_HOLD_ALERT_COPY))
            self.assertTrue(all("{" not in x for x in texts))

    def test_the_hold_causes_the_bot_knows_are_the_pipelines(self):
        from modules import held_video
        from modules.operator_bot import sources
        self.assertEqual(sources.HOLD_CAUSES, held_video.HOLD_CAUSES)

    def test_only_a_fixed_word_survives_as_the_cause_of_a_hold(self):
        engine, _, _, ops, _ = make(now=at(14, 16, 0))
        ops.sync.tables["videos"].append(video("run-hhhh", state="held", held=at(14, 15, 30),
                                               detail={"cause": "<b>free text</b>"}))
        ops.sync.tables["videos"].append(video("run-iiii", state="held", held=at(14, 15, 31),
                                               detail={"cause": "upload_failed"}))
        rows = {r["video_id"]: r for r in ops.recent_videos(at(14, 0, 0), ["default"]).data}
        self.assertIsNone(rows["run-hhhh"]["hold_cause"])                        # not a fixed word: dropped
        self.assertEqual(rows["run-iiii"]["hold_cause"], "upload_failed")
        self.assertNotIn("hold_detail", rows["run-hhhh"])

    def test_the_gate_verdict_is_never_selected_and_a_refused_path_select_costs_only_the_cause(self):
        class RefusesPaths(FakeSync):
            def select_strict(self, table, params=None):
                if "->>" in str((params or {}).get("select", "")):
                    from modules.supabase_sync import SupabaseReadError
                    raise SupabaseReadError(table, 400, "bad select")
                return super().select_strict(table, params)

        sync = RefusesPaths({"videos": [video("run-jjjj", state="held", held=at(14, 15, 30),
                                              detail={"cause": "upload_failed"})]})
        from modules.operator_bot.sources import OperatorSources
        ops = OperatorSources(sync, FakeHttp(), OperatorConfig(), now=lambda: T)
        sec = ops.recent_videos(at(14, 0, 0), ["default"])
        self.assertTrue(sec.ok)                                                   # the evidence still reads
        self.assertEqual(sec.data[0]["video_id"], "run-jjjj")
        for _table, params in sync.reads:
            self.assertNotIn("hold_detail,", params["select"] + ",")             # the whole JSON is never asked for
            self.assertNotIn("hold_detail", params["select"].replace("hold_detail->>cause", "").replace("hold_detail->>stage", ""))

    def test_repurposed_shorts_are_neither_alerts_nor_slot_evidence(self):
        shorts = [video(f"short{i}", state="held", held=at(14, 15, 30), fmt="short", parent="master1") for i in range(20)]
        shorts.append(video("short-up", state="uploaded", published=at(14, 15, 40), fmt="short", parent="master1"))
        # a Short whose parent link is missing is still a Short by its format
        shorts.append(video("short-orphan", state="held", held=at(14, 15, 41), fmt="short"))
        self.assertEqual(self.found(videos=shorts), [])
        found = run_detect(videos=shorts, now=at(14, 19, 0))[0]
        self.assertEqual(keys(found, "deadman:default:2026-10-14"), ["deadman:default:2026-10-14"])   # still no master
        self.assertEqual(keys(found, "video:"), [])

    def test_a_row_with_a_parent_is_not_a_master_whatever_its_format_says(self):
        self.assertFalse(reliability.is_master(video("x", fmt="long", parent="m")))
        self.assertFalse(reliability.is_master(video("x", fmt="short")))
        self.assertTrue(reliability.is_master(video("x", fmt=None)))                    # a row from before 0003
        self.assertTrue(reliability.is_master(video("x", fmt="long")))
        a_long_row_with_a_parent = video("y", state="held", held=at(14, 15, 30), fmt="long", parent="m")
        self.assertEqual(self.found(videos=[a_long_row_with_a_parent]), [])

    def test_a_scene_repair_updates_the_masters_row_in_place_so_it_stays_slot_evidence_but_is_not_announced(self):
        repaired = video("run-rrrr", state="repaired_awaiting_review", held=at(14, 15, 30))
        self.assertEqual(self.found(videos=[repaired]), [])                      # no held / blocked alert
        found = run_detect(videos=[repaired], now=at(14, 19, 0))[0]
        self.assertEqual(keys(found, "deadman:default:2026-10-14"), [])          # and no false "No video"
        self.assertTrue(reliability.is_master(repaired))

    def test_masters_whose_parent_is_an_empty_string_still_count(self):
        # StateStore.record_video defaults parent_video_id to '' and the daily mirror upserts it over NULL
        masters = [video("m1", state="uploaded", published=at(14, 15, 30), parent=""),
                   video("m2", state="held", held=at(14, 15, 31), parent="")]
        self.assertTrue(all(reliability.is_master(m) for m in masters))
        found = run_detect(videos=masters, now=at(14, 19, 0))[0]
        self.assertEqual(keys(found, "deadman:default:2026-10-14"), [])
        self.assertEqual(sorted(a.key for a in found if a.key.startswith("video:")), ["video:held:m2"])

    def test_a_format_other_than_short_is_a_master(self):
        self.assertTrue(reliability.is_master(video("x", fmt="shorts_compilation")))
        self.assertFalse(reliability.is_master(video("x", fmt="short")))

    def test_a_video_is_announced_once_however_often_it_is_held_again(self):
        engine, store, tg, ops, clock = make(now=at(14, 14, 0))
        engine.tick()
        ops.sync.tables["videos"].append(video("run-kkkk", state="held", held=at(14, 14, 10)))
        clock.now = at(14, 14, 20)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        ops.sync.tables["videos"][-1]["held_at"] = iso(at(14, 14, 40))         # the resumed run holds it again
        clock.now = at(14, 14, 50)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_video_already_uploaded_is_not_still_held(self):
        done = video("run-cccc", state="held", held=at(14, 15, 30), published=at(14, 15, 50))
        self.assertEqual(self.found(videos=[done]), [])

    def test_only_the_operators_channels_are_announced(self):
        theirs = video("run-dddd", cid="their-channel", state="blocked", held=at(14, 15, 30))
        self.assertEqual(self.found(videos=[theirs]), [])

    def test_the_event_log_is_not_the_source_of_a_video_alert(self):
        # the log is mirrored a day late; a failed upload is announced from the video's own row
        self.assertEqual(self.found(events=[event("upload.failed", at(14, 15, 45))]), [])

    def test_old_rows_are_not_news(self):
        old = video("run-eeee", state="blocked", held=at(14, 2, 0))
        self.assertEqual(self.found(videos=[old]), [])

    def test_a_held_video_is_not_in_the_mail_kinds(self):
        from modules.operator_bot import owner_mail
        held = [a for a in self.found(videos=[video("run-ffff", state="held", held=at(14, 15, 30))])][0]
        self.assertEqual(held.kind, "approval")
        self.assertNotIn("approval", owner_mail.DEFAULT_KINDS)

    def test_no_title_topic_or_error_text_is_read_or_shown(self):
        rows = [video("run-gggg", state="blocked", held=at(14, 15, 30)) | {"title": "SECRET TITLE", "topic": "SECRET TOPIC",
                                                                         "hold_detail": {"reason": "SECRET REASON"}}]
        ev = [event("upload.failed", at(14, 15, 45)) | {"metadata": {"title": "SECRET TITLE", "error": "SECRET ERROR"}}]
        found = self.found(videos=rows, events=ev)
        self.assertEqual(len(found), 1)
        for a in found:
            self.assertNotIn("SECRET", a.line)


class DoctorTestCase(unittest.TestCase):
    NOW = at(14, 12, 0)

    def rows(self, *items):
        return [{"at": iso(self.NOW - timedelta(hours=h)), "title": title, "body": body, "kind": "operator.doctor",
                 "channel_id": None} for h, title, body in items]

    def found(self, rows, now=None):
        engine, _, _, ops, clock = make(now=now or self.NOW, channels=[], tables={"alert_events": rows})
        return [a for a in alerts.detect(ops, 15000) if a.key.startswith("doctor:")]

    def test_each_failing_check_is_one_alert_per_day_naming_the_check(self):
        found = self.found(self.rows((1, "fail", "youtube/operator channel token,providers/elevenlabs")))
        self.assertEqual(sorted(a.key for a in found),
                         ["doctor:check:providers-elevenlabs:2026-10-14",
                          "doctor:check:youtube-operator-channel-token:2026-10-14"])
        self.assertTrue(all((a.kind, a.severity) == ("health", "warn") for a in found))
        self.assertIn("youtube-operator-channel-token", " ".join(a.line for a in found))

    def test_one_transient_failure_is_not_an_alert_but_two_in_a_row_are(self):
        self.assertEqual(self.found(self.rows((1, "fail", "~providers/elevenlabs"))), [])
        self.assertEqual(self.found(self.rows((1, "fail", "~providers/elevenlabs"), (7, "ok", ""))), [])
        again = self.found(self.rows((1, "fail", "~providers/elevenlabs"), (7, "fail", "~providers/elevenlabs")))
        self.assertEqual([a.key for a in again], ["doctor:check:providers-elevenlabs:2026-10-14"])

    def test_a_permanent_failure_is_said_at_once(self):
        found = self.found(self.rows((1, "fail", "youtube/operator channel token")))
        self.assertEqual(len(found), 1)

    def test_a_transient_failure_after_a_clean_check_stays_quiet_and_is_never_recovered(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"alert_events": []})
        engine.tick()
        ops.sync.tables["alert_events"] = self.rows((1, "fail", "~providers/pexels"), (7, "ok", ""))
        self.assertEqual(engine.tick().sent, 0)
        ops.sync.tables["alert_events"] = [{"at": iso(clock.now), "title": "ok", "body": "", "kind": "operator.doctor",
                                            "channel_id": None}]
        self.assertEqual(engine.tick().sent, 0)                                # nothing was said, so nothing recovers

    def test_failures_that_did_not_fit_the_row_still_count(self):
        found = self.found(self.rows((1, "fail", "keys/GEMINI_API_KEY,+3")))
        self.assertEqual(sorted(a.key.split(":")[2] for a in found), ["keys-gemini-api-key", "more-checks"])

    def test_a_passing_check_is_silent_and_so_is_a_check_that_never_reported(self):
        self.assertEqual(self.found(self.rows((1, "ok", ""))), [])
        self.assertEqual(self.found([]), [])

    def test_the_newest_row_decides(self):
        rows = self.rows((10, "fail", "providers/pexels"), (1, "ok", ""))
        self.assertEqual(self.found(rows), [])

    def test_a_check_that_stops_reporting_is_an_alert_of_its_own(self):
        found = self.found(self.rows((31, "ok", "")))
        self.assertEqual([a.key for a in found], ["doctor:stale:2026-10-14"])
        self.assertEqual(self.found(self.rows((29, "ok", ""))), [])
        self.assertEqual(self.found(self.rows((31, "fail", "providers/pexels"))) and
                         [a.key for a in self.found(self.rows((31, "fail", "providers/pexels")))],
                         ["doctor:stale:2026-10-14"])                        # an old FAIL says nothing about today

    def test_a_row_that_carries_a_channel_is_not_the_bots(self):
        forged = self.rows((1, "fail", "providers/pexels"))
        forged[0]["channel_id"] = "some-channel"
        self.assertEqual(self.found(forged), [])

    def test_a_future_dated_row_does_not_pin_the_verdict(self):
        rows = self.rows((-5, "fail", "providers/pexels"), (1, "ok", ""))
        self.assertEqual(self.found(rows), [])

    def test_a_fail_goes_out_once_then_recovers_once(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"alert_events": []})
        engine.tick()
        ops.sync.tables["alert_events"] = self.rows((1, "fail", "youtube/operator channel token"))
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("WARN — tokens and providers", tg.texts()[-1])
        clock.advance(minutes=30)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)
        ops.sync.tables["alert_events"] = [{"at": iso(clock.now), "title": "ok", "body": "", "kind": "operator.doctor",
                                            "channel_id": None}]
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("Recovered: readiness check youtube-operator-channel-token", tg.texts()[-1])
        clock.advance(minutes=30)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_failure_that_lasts_days_recovers_once_not_once_per_day(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"alert_events": []})
        engine.tick()
        for day in (14, 15):
            clock.now = at(day, 12, 0)
            heartbeat(ops, clock)
            ops.sync.tables["alert_events"] = [{"at": iso(clock.now), "title": "fail", "body": "providers/pexels",
                                                "kind": "operator.doctor", "channel_id": None}]
            self.assertEqual(engine.tick().sent, 1, day)
        clock.now = at(15, 18, 0)
        heartbeat(ops, clock)
        ops.sync.tables["alert_events"] = [{"at": iso(clock.now), "title": "ok", "body": "", "kind": "operator.doctor",
                                            "channel_id": None}]
        self.assertEqual(engine.tick().sent, 1)

    def test_a_failure_still_standing_the_next_day_is_not_called_recovered(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"alert_events": []})
        engine.tick()
        ops.sync.tables["alert_events"] = self.rows((1, "fail", "providers/pexels"))
        engine.tick()
        clock.now = at(15, 12, 0)
        heartbeat(ops, clock)
        ops.sync.tables["alert_events"] = [{"at": iso(clock.now), "title": "fail", "body": "providers/pexels",
                                            "kind": "operator.doctor", "channel_id": None}]
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)                                          # today's reminder
        self.assertNotIn("Recovered", tg.texts()[-1])


class ProviderTestCase(unittest.TestCase):
    NOW = at(14, 12, 0)

    def bal(self, provider="leonardo", metric="api_tokens", remaining=500, hours_ago=1):
        return {"provider": provider, "metric": metric, "remaining": remaining, "total": None, "unit": "tokens",
                "tier": None, "resets_at": None, "checked_at": iso(self.NOW - timedelta(hours=hours_ago))}

    def found(self, *rows, now=None):
        engine, _, _, ops, _ = make(now=now or self.NOW, channels=[], tables={"provider_balances": list(rows)})
        return [a for a in alerts.detect(ops, 15000) if a.key.startswith("provider:")]

    def test_a_snapshot_that_stopped_refreshing_is_an_alert(self):
        found = self.found(self.bal(hours_ago=31))
        self.assertEqual([(a.kind, a.key) for a in found], [("health", "provider:stale:leonardo:2026-10-14")])
        self.assertEqual(self.found(self.bal(hours_ago=29)), [])

    def test_a_provider_retired_long_ago_is_not_a_daily_ping(self):
        self.assertEqual(self.found(self.bal(hours_ago=24 * 8)), [])

    def test_a_balance_at_zero_is_an_alert_but_a_positive_one_is_not_and_elevenlabs_has_its_own(self):
        zero = self.found(self.bal(remaining=0))
        self.assertEqual([(a.kind, a.key) for a in zero], [("balance", "provider:zero:leonardo:api_tokens:2026-10-14")])
        self.assertEqual(self.found(self.bal(remaining=3)), [])
        eleven = self.found(self.bal("elevenlabs", "credits", 0))
        self.assertEqual(eleven, [])                                           # the existing "low" alert covers it
        self.assertEqual(self.found(self.bal(remaining=None)), [])             # unknown is not zero

    def test_stale_goes_out_once_and_recovers_once(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"provider_balances": [self.bal(hours_ago=1)]})
        engine.tick()
        ops.sync.tables["provider_balances"] = [self.bal(hours_ago=31)]
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("WARN — tokens and providers", tg.texts()[-1])
        self.assertEqual(engine.tick().sent, 0)
        ops.sync.tables["provider_balances"] = [self.bal(hours_ago=0)]
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("Recovered: the leonardo balance is refreshed again", tg.texts()[-1])

    def test_a_provider_that_disappears_is_not_called_recovered(self):
        engine, store, tg, ops, clock = make(now=self.NOW, channels=[], tables={"provider_balances": [self.bal(hours_ago=1)]})
        engine.tick()
        ops.sync.tables["provider_balances"] = [self.bal(hours_ago=31)]
        engine.tick()
        ops.sync.tables["provider_balances"] = []
        self.assertEqual(engine.tick().sent, 0)


class DigestTestCase(unittest.TestCase):
    def lines(self, now, **kw):
        engine, _, _, ops, _ = make(now=now, **kw)
        return reliability.digest_lines(ops, "en")

    def test_expected_against_made_for_yesterday_and_today(self):
        lines = self.lines(at(14, 12, 0), videos=[])
        self.assertEqual(len(lines), 1)
        self.assertIn("default: yesterday 1/1 · today 0/1, due 15:00", lines[0])

    def test_a_missing_video_is_said_plainly_after_the_deadline(self):
        lines = self.lines(at(14, 19, 0), videos=[])
        self.assertIn("MISSING", lines[0])
        done = self.lines(at(14, 19, 0), videos=[video("v", held=at(14, 15, 30))])
        self.assertIn("today 1/1", done[0])
        self.assertNotIn("MISSING", done[0])

    def test_with_the_switch_off_no_cell_says_missing(self):
        off = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", deadman_hours=None)
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[], cfg=off)
        text = reliability.digest_lines(ops, "en")[0]
        self.assertNotIn("MISSING", text)
        self.assertIn("0/1", text)

    def test_a_run_without_a_video_is_not_missing_but_not_made(self):
        lines = self.lines(at(14, 19, 0), videos=[], events=[event("system.started", at(14, 15, 5))])
        self.assertIn("a run started, no video", lines[0])
        self.assertNotIn("MISSING", lines[0])

    def test_a_storyboard_waiting_for_a_person_is_a_run_that_made_no_video_yet(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[])
        ops.sync.tables["storyboards"] = [storyboard(at(14, 15, 20))]
        text = reliability.digest_lines(ops, "en")[0]
        self.assertIn("a run started, no video", text)
        self.assertNotIn("MISSING", text)

    def test_an_unreadable_source_reads_unknown_never_zero_or_missing(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[])
        ops.sync.fail = {"videos"}
        text = reliability.digest_lines(ops, "en")[0]
        self.assertIn("unknown", text)
        self.assertNotIn("0/1", text)
        engine, _, _, ops, _ = make(now=at(14, 19, 0))
        ops.sync.fail = {"channels"}
        self.assertIn("unknown", reliability.digest_lines(ops, "en")[0])

    def test_no_scheduled_channel_means_no_line(self):
        self.assertEqual(self.lines(at(14, 19, 0), channels=[channel(status="PAUSED")]), [])
        self.assertEqual(self.lines(at(14, 19, 0), channels=[]), [])

    def test_the_line_reaches_the_telegram_digest_and_the_owner_mail_digest(self):
        engine, _, _, ops, _ = make(now=at(14, 19, 0), videos=[])
        self.assertIn("Videos expected vs made", views.view_digest(ops, [], "en").text)
        self.assertIn("Videos expected vs made", views.view_today(ops, "en").text)
        digest = owner_digest.build(ops, "en", [])
        self.assertTrue(any("Videos expected vs made" in line for line in digest.lines))

    def test_every_language_has_the_words(self):
        for lang in LANGUAGES:
            for key in ("rel.cell", "rel.cell_due", "rel.cell_ran", "rel.cell_missing", "rel.cell_unknown",
                        "rel.cell_none", "digest.expected", "digest.expected_unknown"):
                self.assertIn(key, table(lang), (lang, key))


class ReadOnlyTestCase(unittest.TestCase):
    """This change reads. It starts, retries, repairs, spends and publishes nothing, and writes nothing of its own
    (the engine's alert memory is the only write, and it is not this module's)."""

    SOURCE = (Path(__file__).resolve().parent.parent / "modules" / "operator_bot" / "reliability.py").read_text()

    def test_the_module_contains_no_write_call(self):
        code = "\n".join(l for l in self.SOURCE.splitlines() if not l.lstrip().startswith("#"))
        for needle in ("upsert", "insert", "rpc_strict", "subprocess", "os.system", "requests.", ".post(", ".put(",
                       ".patch(", ".delete(", "workflow_dispatch(", "actions_run_trigger", "record_alert", "record_mute"):
            self.assertNotIn(needle, code, needle)

    def test_a_pass_and_a_digest_make_no_write_and_only_get_github(self):
        class NoWrite(FakeSync):
            def upsert(self, *a, **k):
                raise AssertionError("a reliability read must not write")

        clock = Clock(T)
        tables = healthy_tables(T) | {"channels": [channel()], "videos": [], "system_events": [], "storyboards": []}
        sync = NoWrite(tables)
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
        http = FakeHttp({**site_ok(), **github_ok(), **daily(gh_run(1, conclusion="failure"))})
        from modules.operator_bot.sources import OperatorSources
        ops = OperatorSources(sync, http, cfg, now=clock)
        self.assertTrue(alerts.detect(ops, 15000))
        reliability.digest_lines(ops, "en")
        self.assertEqual(sync.upserts, [])
        for url, _headers in http.calls:
            self.assertTrue(url.startswith(("https://api.github.com/repos/owner/repo/actions/", "https://app.example.test")), url)


class MailKindsTestCase(unittest.TestCase):
    def test_problems_are_e_mailed_but_recovered_and_blind_notes_stay_in_telegram(self):
        from modules.operator_bot import owner_mail
        from modules.operator_bot.alerts import Alert
        wants = owner_mail.OwnerMail.wants
        sink = type("S", (), {"kinds": frozenset(owner_mail.DEFAULT_KINDS)})()
        self.assertTrue(wants(sink, Alert("pipeline", "deadman:x:d", "warn", "l")))
        self.assertTrue(wants(sink, Alert("health", "doctor:check:x:d", "warn", "l")))
        self.assertFalse(wants(sink, Alert("pipeline", "ok:deadman:x:d", "info", "l")))
        self.assertFalse(wants(sink, Alert("health", "blind:videos:d", "info", "l")))
        self.assertTrue(wants(sink, Alert("payment", "payment:x:paid", "info", "l")))


class CopyTestCase(unittest.TestCase):
    def test_the_hint_family_and_the_kinds_exist_in_every_language(self):
        for lang in LANGUAGES:
            for state in ("none", "waiting", "failed", "empty", "unknown", "old"):
                self.assertIn(f"alert.deadman_hint_{state}", table(lang), (lang, state))
            for kind in ("pipeline", "health"):
                self.assertIn(f"kind.{kind}", table(lang))
                self.assertIn(f"ownermail.subject_{kind}", table(lang))
        for kind in ("pipeline", "health"):
            self.assertIn(kind, views.ALERT_KINDS)
            self.assertIn(views.KIND_COMMAND[kind], dict(views.COMMANDS))

    def test_every_state_the_detector_can_name_has_a_hint(self):
        for state in ("none", "waiting", "failed", "empty", "unknown", "old"):
            self.assertNotEqual(table("en")[f"alert.deadman_hint_{state}"], "")
        runs = reliability.Section(False)
        self.assertEqual(reliability._run_view(runs, T, T)[0], "unknown")
        self.assertEqual(reliability._run_view(reliability.Section(True, []), T, T)[0], "none")


if __name__ == "__main__":
    unittest.main()
