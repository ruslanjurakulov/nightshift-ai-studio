"""The ``film`` alert kind: Film Studio's switch-on gates G3 and G4 (docs/FILM_STUDIO.md, docs/studio/S2_GAPS.md).

What would break, and which test says so:

* a settle that left a charge uncaptured (``segment_settled`` with ``detail.not_captured`` > 0) reaching nobody, or being
  announced twice, or a zero / missing / non-numeric amount being called an incident;
* a segment the claim or the sweep skipped (``segment_skipped``, or 0171's ``security_events`` fallback
  ``film.segment_skipped``) reaching nobody;
* a segment queued with no claim, or holding a stale lease, going unseen; a fresh one being called stuck;
* the sweep's ``overdue`` read as fine when it is null (never recorded), or an alert raised for null (rule 5);
* a film source that cannot answer (0171 or 0212 not applied, a read refused) becoming an alert, or /health saying nothing;
* a prompt, the database's message text, a customer's e-mail or a full id reaching any line, in any language;
* the film worker's silence hidden by the e-mail worker's heartbeat (both are kind 'other'), or a switched-off film worker
  paging the owner as "lost".
"""

from __future__ import annotations

import unittest
from datetime import timedelta
from unittest import mock

from modules.operator_bot import alerts, analysis, views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import LANGUAGES
from modules.operator_bot.store import MemoryAlertStore
from tests.operator_bot_fakes import FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, ts

ORG = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8"
FILM = "f11f2e3d-4c5b-4a69-8877-665544332211"
SEG = "5e65a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b"
PROMPT = "PROMPT-TEXT a red fox at dawn in the style of someone"
MESSAGE = "duplicate key value violates unique constraint film_takes_pkey Key (id)=(secret-row)"
EMAIL = "customer@example.com"
KEY = "sk-live-abcdefghijklmnopqrstuvwxyz0123"


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


def settled(eid=101, not_captured="1.50", minutes_ago=5, **extra):
    row = {"id": eid, "film_id": FILM, "org_id": ORG, "event": "segment_settled", "created_at": ts(minutes_ago),
           "segment_id": SEG, "not_captured": not_captured, "call": None, "sqlstate": None,
           # columns a careless select could bring along: none may reach a line
           "message": MESSAGE, "prompt": PROMPT, "detail": {"message": MESSAGE, "prompt": PROMPT}}
    row.update(extra)
    return row


def skipped(eid=202, call="claim", sqlstate="40P01", minutes_ago=5, **extra):
    row = {"id": eid, "film_id": FILM, "org_id": ORG, "event": "segment_skipped", "created_at": ts(minutes_ago),
           "segment_id": SEG, "not_captured": None, "call": call, "sqlstate": sqlstate, "message": MESSAGE}
    row.update(extra)
    return row


def fallback(eid=303, call="sweep", sqlstate="23505", minutes_ago=5):
    return {"id": eid, "at": ts(minutes_ago), "kind": "film.segment_skipped", "target": SEG, "call": call,
            "sqlstate": sqlstate, "actor_email": EMAIL, "detail": {"message": MESSAGE}}


def segment(sid=SEG, status="queued", created=30, claimed=None, beat=None):
    return {"id": sid, "org_id": ORG, "status": status, "created_at": ts(created),
            "claimed_at": None if claimed is None else ts(claimed), "heartbeat_at": None if beat is None else ts(beat),
            "updated_at": ts(1)}


def sweep(overdue, last_minutes=None, open_n=2, **extra):
    data = {"runners": {"worker": None, "actions": None if last_minutes is None else {
        "last_at": ts(last_minutes), "last_settled": 0, "last_error": None, "last_error_at": None}, "pg_cron": None},
        "last_at": None if last_minutes is None else ts(last_minutes), "open_segments": open_n,
        "overdue_after_minutes": 20, "overdue": overdue, "at": ts(0)}
    data.update(extra)
    return data


def build(tables=None, rpcs=None, fail=(), clock=None, cfg=None, lang_store=None):
    clock = clock or Clock()
    t = healthy_tables(clock.now)
    t.update(tables or {})
    cfg = cfg or OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    ops, sync = make_ops(t, FakeHttp({**site_ok(), **github_ok()}), cfg, now=clock.now, fail=fail, rpcs=rpcs)
    ops._now = clock
    tg = FakeTelegram()
    store = MemoryAlertStore(clock)
    engine = alerts.AlertEngine(ops, store, make_control(tg), cfg, low_credits=15000)
    return engine, store, tg, ops, sync, clock


def film_alerts(tables=None, rpcs=None, fail=(), lang="en"):
    _e, _s, _t, ops, _sync, _c = build(tables, rpcs, fail)
    return [a for a in alerts.detect(ops, 15000, lang) if a.kind == "film"]


class NotCapturedTestCase(unittest.TestCase):
    def test_a_settle_that_could_not_capture_is_one_critical_alert_with_amount_org_and_film(self):
        a = film_alerts({"film_events": [settled()]})
        self.assertEqual([(x.kind, x.severity, x.key, x.cooldown_min) for x in a],
                         [("film", "critical", "film:not_captured:101", 0)])
        line = a[0].line
        self.assertIn("1.50 credits", line)
        self.assertIn(ORG[:8], line)
        self.assertIn(FILM[:8], line)
        self.assertNotIn(ORG, line)          # a short id, never the whole one
        self.assertNotIn(FILM, line)

    def test_zero_missing_negative_or_garbage_is_not_an_alert(self):
        for value in ("0", "0.00", None, "", "-3", "abc", "NaN", True):
            self.assertEqual(film_alerts({"film_events": [settled(not_captured=value)]}), [], value)

    def test_an_event_older_than_a_day_is_not_news(self):
        self.assertEqual(film_alerts({"film_events": [settled(minutes_ago=60 * 25)]}), [])

    def test_it_is_sent_once_and_never_again(self):
        engine, _s, tg, ops, sync, clock = build()
        self.assertTrue(engine.tick().baseline)
        sync.tables["film_events"] = [settled()]
        self.assertEqual(engine.tick().sent, 1)
        self.assertIn("NOT captured", tg.texts()[-1])
        for _ in range(3):
            clock.advance(hours=4)
            sync.tables["worker_status"] = healthy_tables(clock.now)["worker_status"]
            sync.tables["provider_balances"] = healthy_tables(clock.now)["provider_balances"]
            sync.tables["film_events"] = [settled(minutes_ago=5)]       # still inside the window, same event id
            self.assertGreaterEqual(engine.tick().deduped, 1)
        self.assertEqual(sum("NOT captured" in x for x in tg.texts()), 1)

    def test_a_critical_one_comes_through_quiet_hours(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(0, 23))
        engine, _s, tg, ops, sync, _c = build(cfg=cfg)
        engine.tick()
        sync.tables["film_events"] = [settled(), skipped()]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (1, 1))     # the skip (warn) waits for the window to end


class SkippedTestCase(unittest.TestCase):
    def test_a_skipped_segment_is_one_warning_with_the_call_and_the_sqlstate(self):
        a = film_alerts({"film_events": [skipped()]})
        self.assertEqual([(x.severity, x.key) for x in a], [("warn", "film:skipped:202")])
        for word in ("claim", "40P01", SEG[:8], ORG[:8], FILM[:8]):
            self.assertIn(word, a[0].line)

    def test_the_security_events_fallback_is_read_too(self):
        a = film_alerts({"security_events": [fallback(), fallback(304) | {"kind": "something.else"}]})
        self.assertEqual([(x.severity, x.key) for x in a], [("warn", "film:skipped:sec:303")])
        for word in ("sweep", "23505", SEG[:8], "security_events"):
            self.assertIn(word, a[0].line)

    def test_an_unexpected_call_or_sqlstate_prints_a_question_mark_not_the_value(self):
        a = film_alerts({"film_events": [skipped(call="<b>x</b>", sqlstate="drop table")]})
        self.assertIn("by the ? (?)", a[0].line)
        self.assertNotIn("drop table", a[0].line)

    def test_each_event_is_announced_once(self):
        engine, _s, tg, _ops, sync, _c = build()
        engine.tick()
        sync.tables["film_events"] = [skipped(), skipped(203, call="sweep")]
        self.assertEqual(engine.tick().sent, 2)
        self.assertEqual(engine.tick().sent, 0)
        self.assertEqual(len([x for x in tg.texts() if "skipped" in x]), 1)      # one message, two lines

    def test_the_settled_and_skipped_reads_never_select_the_message_or_the_actor(self):
        _e, _s, _t, ops, sync, _c = build({"film_events": [settled(), skipped()], "security_events": [fallback()]})
        alerts.detect(ops, 15000)
        reads = [(t, p) for t, p in sync.reads if t in ("film_events", "security_events", "film_segments")]
        self.assertEqual({t for t, _ in reads}, {"film_events", "security_events", "film_segments"})
        for table, params in reads:
            cols = params["select"].split(",")
            for col in cols:
                self.assertNotIn(col, ("*", "detail", "message", "actor_email", "actor_user_id", "film_id:detail"), table)
                self.assertFalse(col.endswith("->>message"), table)
        settled_read = [p for t, p in reads if t == "film_events" and p.get("event") == "eq.segment_settled"]
        self.assertEqual(settled_read[0]["detail->>not_captured"], "not.is.null")   # asked of the database, not cut by a limit


class StuckTestCase(unittest.TestCase):
    def keys(self, rows):
        return sorted(a.key for a in film_alerts({"film_segments": rows}))

    def test_queued_with_no_claim_past_fifteen_minutes(self):
        self.assertEqual(self.keys([segment(created=16)]), [f"film:stuck:{SEG}"])
        self.assertEqual(self.keys([segment(created=14)]), [])
        self.assertEqual(self.keys([segment(created=60, claimed=50, beat=1)]), [])   # claimed: not "no claim"

    def test_running_or_draining_with_a_heartbeat_older_than_twenty_minutes(self):
        self.assertEqual(self.keys([segment(status="running", created=60, claimed=50, beat=21)]), [f"film:stuck:{SEG}"])
        self.assertEqual(self.keys([segment(status="running", created=60, claimed=50, beat=19)]), [])
        self.assertEqual(self.keys([segment(status="draining", created=60, claimed=25)]), [f"film:stuck:{SEG}"])
        self.assertEqual(self.keys([segment(status="settled", created=600, claimed=500, beat=400)]), [])

    def test_a_stuck_line_is_a_warning_with_a_cooldown_and_names_the_fix(self):
        a = film_alerts({"film_segments": [segment(created=40)]})
        self.assertEqual((a[0].severity, a[0].cooldown_min), ("warn", alerts.STUCK_COOLDOWN))
        self.assertIn("NIGHTSHIFT_FILM_WORKER", a[0].line)
        self.assertIn("40m", a[0].line)
        self.assertIn(ORG[:8], a[0].line)
        a = film_alerts({"film_segments": [segment(status="running", created=90, claimed=80, beat=30)]})
        self.assertIn("last heartbeat 30m ago", a[0].line)

    def test_it_repeats_only_after_the_stuck_cooldown(self):
        engine, _s, _tg, _ops, sync, clock = build()
        engine.tick()
        sync.tables["film_segments"] = [segment(created=40)]
        self.assertEqual(engine.tick().sent, 1)

        def later(minutes):
            clock.advance(minutes=minutes)
            fresh = healthy_tables(clock.now)
            sync.tables["worker_status"], sync.tables["provider_balances"] = fresh["worker_status"], fresh["provider_balances"]
            sync.tables["film_segments"] = [segment(created=40) | {"created_at": ts(40 + 1, NOW)}]

        later(60)
        self.assertEqual(engine.tick().sent, 0)
        later(alerts.STUCK_COOLDOWN)
        self.assertEqual(engine.tick().sent, 1)


class SweepTestCase(unittest.TestCase):
    def test_overdue_true_is_one_critical_alert(self):
        a = film_alerts(rpcs={"film_sweep_status": sweep(True, last_minutes=45, open_n=3)})
        self.assertEqual([(x.severity, x.key, x.cooldown_min) for x in a],
                         [("critical", "film:sweep_overdue", alerts.FILM_SWEEP_COOLDOWN)])
        for word in ("OVERDUE", "20 min", "3 segment", "45m ago", "film_sweep"):
            self.assertIn(word, a[0].line)

    def test_overdue_with_no_completed_sweep_says_so(self):
        a = film_alerts(rpcs={"film_sweep_status": sweep(True, last_minutes=None)})
        self.assertIn("no sweep has completed yet", a[0].line)

    def test_false_null_missing_or_garbage_is_not_an_alert(self):
        for data in (sweep(False, last_minutes=3), sweep(None), {k: v for k, v in sweep(True).items() if k != "overdue"},
                     sweep("true"), sweep(1), {}):
            self.assertEqual(film_alerts(rpcs={"film_sweep_status": data}), [], data)

    def test_null_is_never_recorded_in_health_and_digest_never_fine(self):
        for fn in (views.view_health, views.view_digest):
            _e, _s, _t, ops, _sync, _c = build(rpcs={"film_sweep_status": sweep(None)})
            text = fn(ops).text
            self.assertIn("Film sweep: never recorded (unknown, not fine)", text, fn.__name__)
            self.assertNotIn("on time", text)

    def test_health_lines_for_each_answer(self):
        cases = ((sweep(False, last_minutes=4), "Film sweep: on time — last completed 4m ago"),
                 (sweep(True, last_minutes=40), "Film sweep: <b>OVERDUE</b> — last completed 40m ago"),
                 ({"runners": {}}, "Film sweep: unknown (its status did not say whether it is overdue)"),
                 (sweep("yes"), "Film sweep: unknown (its status did not say whether it is overdue)"))
        for data, want in cases:
            _e, _s, _t, ops, _sync, _c = build(rpcs={"film_sweep_status": data})
            self.assertIn(want, views.view_health(ops).text)

    def test_the_newest_runner_is_used_when_the_top_level_time_is_missing(self):
        data = sweep(False, last_minutes=None)
        data["runners"] = {"worker": {"last_at": ts(30)}, "actions": {"last_at": ts(7)}, "pg_cron": None}
        st = analysis.film_sweep_state(data)
        self.assertEqual(st["last_at"], NOW - timedelta(minutes=7))


class CannotAnswerTestCase(unittest.TestCase):
    def test_a_missing_function_or_unreadable_table_is_silence_and_health_says_why(self):
        rows = {"film_events": [settled(), skipped()], "security_events": [fallback()],
                "film_segments": [segment(created=90)]}
        # 0212 not applied: the RPC answers 404 (PGRST202) -> "not set up yet", no alert of its own
        a = film_alerts(rows)
        self.assertNotIn("film:sweep_overdue", [x.key for x in a])
        self.assertEqual(len(a), 4)                  # the other sources still answer
        _e, _s, _t, ops, sync, _c = build(rows, fail={"film_events", "security_events", "film_segments"},
                                          rpcs={"film_sweep_status": sweep(True)})
        sync.rpc_fail.add("film_sweep_status")
        self.assertEqual([x for x in alerts.detect(ops, 15000) if x.kind == "film"], [])
        text = views.view_health(ops).text
        self.assertIn("Film segments: unknown (unavailable", text)
        self.assertIn("Film sweep: unknown (unavailable", text)
        _e, _s, _t, ops, _sync, _c = build()
        self.assertIn("Film sweep: unknown (not set up yet", views.view_health(ops).text)

    def test_an_answer_that_is_not_an_object_cannot_answer(self):
        for data in ([], "overdue", None, 3):
            _e, _s, _t, ops, _sync, _c = build(rpcs={"film_sweep_status": data})
            self.assertFalse(ops.film_sweep_status().ok, data)

    def test_a_bad_row_in_one_film_source_costs_the_others_nothing(self):
        with self.assertLogs("modules.operator_bot.alerts", "WARNING") as logs, \
                mock.patch.object(analysis, "film_not_captured", side_effect=AttributeError("boom " + KEY)):
            a = film_alerts({"film_events": [settled()], "film_segments": [segment(created=90)]})
        self.assertEqual([x.key for x in a], [f"film:stuck:{SEG}"])
        self.assertIn("film events alerts skipped (AttributeError)", "\n".join(logs.output))
        self.assertNotIn(KEY, "\n".join(logs.output))              # the exception's name, never its text


class PrivacyAndLanguageTestCase(unittest.TestCase):
    ROWS = {"film_events": [settled(), skipped()], "security_events": [fallback()],
            "film_segments": [segment(created=90), segment("6e65a1b2-0000-4000-8000-000000000000", "running", 90, 80, 40)]}

    def every_line(self, lang):
        return [a.line for a in film_alerts(self.ROWS, {"film_sweep_status": sweep(True, last_minutes=50)}, lang=lang)]

    def test_no_secret_prompt_message_or_email_in_any_line_in_any_language(self):
        for lang in LANGUAGES:
            lines = self.every_line(lang)
            self.assertEqual(len(lines), 6, lang)
            for line in lines:
                for leak in (PROMPT, "red fox", MESSAGE[:20], "secret-row", EMAIL, KEY, ORG, FILM, SEG):
                    self.assertNotIn(leak, line, (lang, line))

    def test_the_dedupe_keys_do_not_depend_on_the_language(self):
        keys = {lang: sorted(a.key for a in film_alerts(self.ROWS, {"film_sweep_status": sweep(True)}, lang=lang))
                for lang in LANGUAGES}
        self.assertEqual(len({tuple(v) for v in keys.values()}), 1, keys)

    def test_the_words_really_change_between_languages(self):
        lines = {lang: self.every_line(lang) for lang in LANGUAGES}
        self.assertNotEqual(lines["en"], lines["ru"])
        self.assertNotEqual(lines["en"], lines["uz"])

    def test_film_is_a_kind_with_a_label_a_mute_and_a_details_command_but_no_guessed_page(self):
        self.assertIn("film", views.ALERT_KINDS)
        self.assertEqual(views.KIND_COMMAND["film"], "health")
        self.assertNotIn("film", views.KIND_PAGE)
        for lang in LANGUAGES:
            self.assertNotEqual(views.kind_label(lang, "film"), "film", lang)
        store = MemoryAlertStore(lambda: NOW)
        self.assertIsNotNone(alerts.mute(store, "film", NOW))
        a = film_alerts(self.ROWS)
        reply = alerts.compose("film", a, OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo"))
        datas = [b.get("callback_data") for row in reply.keyboard for b in row]
        self.assertEqual(datas, ["a:mute:film", "d:film"])          # no Open: no operator page lists customers' films


class WorkerLostTestCase(unittest.TestCase):
    """The film worker reports kind 'other' like the e-mail worker; the lost-worker alert must tell them apart."""

    def lost(self, rows):
        _e, _s, _t, ops, _sync, _c = build({"worker_status": healthy_tables()["worker_status"] + rows})
        return sorted(a.key for a in alerts.detect(ops, 15000) if a.kind == "worker")

    @staticmethod
    def w(wid, state="running", minutes=0.2):
        return {"worker_id": wid, "kind": "other", "state": state, "detail": None, "version": None,
                "started_at": ts(600), "updated_at": ts(minutes)}

    def test_a_silent_film_worker_is_lost_even_while_the_email_worker_beats(self):
        self.assertEqual(self.lost([self.w("email-host"), self.w("film-host-1", minutes=30)]), ["worker:film-host-1"])

    def test_a_silent_email_worker_is_not_hidden_by_a_beating_film_worker(self):
        self.assertEqual(self.lost([self.w("email-host", minutes=30), self.w("film-host-1")]), ["worker:email-host"])

    def test_an_old_film_container_is_not_lost_while_a_new_one_beats(self):
        self.assertEqual(self.lost([self.w("film-old-1", minutes=90), self.w("film-new-1")]), [])

    def test_switched_off_is_stopped_never_lost(self):
        self.assertEqual(self.lost([self.w("film-host-1", "stopped", minutes=600)]), [])
        # a crashed one, then restarted with the switch off: the later 'stopped' says a person acted on it
        self.assertEqual(self.lost([self.w("film-a-1", minutes=90), self.w("film-b-1", "stopped", minutes=60)]), [])
        # ... but a 'stopped' row OLDER than the silence does not excuse it
        self.assertEqual(self.lost([self.w("film-a-1", minutes=30), self.w("film-b-1", "stopped", minutes=60)]),
                         ["worker:film-a-1"])

    def test_the_bot_row_is_still_judged_on_its_own(self):
        self.assertEqual(self.lost([self.w("operator-bot", minutes=30), self.w("email-host"),
                                    self.w("operator-x", "stopped", minutes=1)]), ["worker:operator-bot"])

    def test_a_film_worker_that_refused_to_start_is_critical(self):
        _e, _s, _t, ops, _sync, _c = build({"worker_status": [self.w("film-host-1", "failed", minutes=2)
                                                              | {"detail": "NIGHTSHIFT_MEDIA_DIR must be the media library volume"}]})
        a = [x for x in alerts.detect(ops, 15000) if x.kind == "worker"]
        self.assertEqual([(x.severity, x.key) for x in a], [("critical", "worker:film-host-1:failed")])


if __name__ == "__main__":
    unittest.main()
