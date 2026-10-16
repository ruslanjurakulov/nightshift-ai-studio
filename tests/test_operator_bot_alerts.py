"""Proactive alerts: what is detected, and the restraint around sending it —
dedupe, the hourly limit, quiet hours, mute, the silent first run, and "no
memory, no message". A fake Telegram records every send; the alert memory is
in-process. Nothing touches the network."""

import unittest
from datetime import timedelta

from modules.operator_bot import alerts
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.store import MemoryAlertStore, SupabaseAlertStore
from tests.operator_bot_fakes import (
    FakeHttp, FakeSync, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, ts,
)


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


def build(tables=None, http=None, cfg=None, clock=None, store=None, session=None):
    clock = clock or Clock()
    t = healthy_tables(clock.now)
    t.update(tables or {})
    cfg = cfg or OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo")
    h = FakeHttp({**site_ok(), **github_ok(), **(http or {})})
    ops, sync = make_ops(t, h, cfg, now=clock.now)
    ops._now = clock
    session = session or FakeTelegram()
    control = make_control(session)
    store = store or MemoryAlertStore(clock)
    engine = alerts.AlertEngine(ops, store, control, cfg, low_credits=15000)
    return engine, store, session, ops, clock


def failed_job(i, minutes_ago=30, channel="default"):
    return {"id": i, "channel_id": channel, "kind": "daily", "status": "failed", "attempts": 3, "max_attempts": 3,
            "finished_at": ts(minutes_ago), "created_at": ts(minutes_ago + 20), "heartbeat_at": None, "started_at": None}


def heartbeat(ops, clock):
    """Keep the one worker reporting as time moves (the fixtures are fixed in time)."""
    ops.sync.tables["worker_status"] = [healthy_tables(clock.now)["worker_status"][0]]


def arm(engine):
    """The first pass is a silent baseline; most tests start after it."""
    rep = engine.tick()
    assert rep.baseline, rep
    engine.ops.sync.tables.setdefault("render_jobs", [])
    return rep


class DetectionTestCase(unittest.TestCase):
    def detect(self, tables=None, http=None, **kw):
        engine, _, _, ops, _ = build(tables, http, **kw)
        return alerts.detect(ops, 15000)

    def test_a_healthy_system_has_nothing_to_say(self):
        self.assertEqual(self.detect(), [])

    def test_a_failed_render_job(self):
        a = self.detect({"render_jobs": [failed_job(5)]})
        self.assertEqual([(x.kind, x.key, x.severity) for x in a], [("run", "run:5", "warn")])
        self.assertIn("Render job #5 failed", a[0].line)
        self.assertIn("default", a[0].line)

    def test_a_failure_older_than_the_event_window_is_not_news(self):
        self.assertEqual(self.detect({"render_jobs": [failed_job(5, minutes_ago=60 * 13)]}), [])

    def test_the_failure_text_never_reaches_the_alert(self):
        job = failed_job(5) | {"error": "exit 1: someone@example.com sk-abcdefghijklmnopqrstuvwxyz topic: secret"}
        line = self.detect({"render_jobs": [job]})[0].line
        for leak in ("someone@", "sk-", "secret", "exit 1"):
            self.assertNotIn(leak, line)

    def test_stuck_running_and_queued_jobs(self):
        a = self.detect({"render_jobs": [
            {"id": 1, "channel_id": "default", "status": "running", "heartbeat_at": ts(30), "started_at": ts(60),
             "created_at": ts(70)},
            {"id": 2, "channel_id": "default", "status": "queued", "created_at": ts(45)},
            {"id": 3, "channel_id": "default", "status": "running", "heartbeat_at": ts(1), "started_at": ts(5),
             "created_at": ts(6)}]})
        self.assertEqual(sorted(x.key for x in a), ["stuck:1", "stuck:2"])
        self.assertTrue(all(x.cooldown_min > 0 for x in a))

    def test_creative_failures_alert_only_as_a_burst(self):
        few = [{"id": str(i), "status": "failed", "finished_at": ts(5), "error_code": "provider_error"} for i in range(2)]
        many = few + [{"id": "z", "status": "failed", "finished_at": ts(4), "error_code": "provider_error"}]
        self.assertEqual(self.detect({"creative_jobs": few}), [])
        a = self.detect({"creative_jobs": many})
        self.assertEqual([x.key for x in a], ["creative:provider_error"])
        self.assertIn("3 creative jobs failed", a[0].line)

    def test_low_elevenlabs_balance_uses_the_existing_threshold_only(self):
        low = [{"provider": "elevenlabs", "metric": "credits", "remaining": 100, "total": 1000, "unit": "credits",
                "checked_at": ts(5)},
               {"provider": "leonardo", "metric": "api_tokens", "remaining": 1, "total": None, "unit": "tokens",
                "checked_at": ts(5)}]
        a = self.detect({"provider_balances": low})
        self.assertEqual([x.key for x in a], ["balance:elevenlabs"])
        self.assertIn("threshold 15,000", a[0].line)

    def test_failed_deploy_and_failed_ci_on_main(self):
        a = self.detect(http=github_ok(deploy="failure", tests="failure"))
        self.assertEqual(sorted(x.key for x in a), ["ci:tests:12", "deploy:11"])
        self.assertTrue(all(x.kind == "deploy" for x in a))

    def test_an_in_progress_run_is_not_a_verdict(self):
        http = github_ok()
        key = "https://api.github.com/repos/owner/repo/actions/workflows/deploy_web.yml"
        http[key] = (200, {"workflow_runs": [{"id": 99, "status": "in_progress", "conclusion": None, "head_sha": "abc",
                                              "updated_at": ts(1)}]})
        self.assertEqual([x for x in self.detect(http=http) if x.kind == "deploy"], [])

    def test_a_silent_worker_is_critical(self):
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
        a = self.detect({"worker_status": [w]})
        self.assertEqual([(x.kind, x.severity, x.key) for x in a], [("worker", "critical", "worker:nightshift-01")])

    def test_an_old_container_row_is_not_lost_when_a_fresh_worker_of_that_kind_runs(self):
        old = healthy_tables()["worker_status"][0] | {"worker_id": "nightshift-old", "updated_at": ts(120)}
        self.assertEqual(self.detect({"worker_status": healthy_tables()["worker_status"] + [old]}), [])

    def test_a_long_gone_worker_is_gone_not_lost(self):
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(60 * 48)}
        self.assertEqual(self.detect({"worker_status": [w]}), [])

    def test_a_stopped_worker_is_not_an_alert(self):
        w = healthy_tables()["worker_status"][0] | {"state": "stopped", "updated_at": ts(600)}
        self.assertEqual(self.detect({"worker_status": [w]}), [])

    def test_a_failed_worker_is_critical(self):
        w = healthy_tables()["worker_status"][0] | {"state": "failed", "detail": "ffmpeg missing", "updated_at": ts(2)}
        a = self.detect({"worker_status": [w]})
        self.assertEqual([(x.severity, x.key) for x in a], [("critical", "worker:nightshift-01:failed")])
        self.assertNotIn("ffmpeg", a[0].line)

    def test_new_pending_approval(self):
        a = self.detect({"publish_approvals": [{"id": "p1", "channel_id": "finance", "status": "pending",
                                                "requested_at": ts(5)}]})
        self.assertEqual([(x.kind, x.severity, x.channel_id) for x in a], [("approval", "info", "finance")])

    def test_security_events_from_the_audit_log_are_critical_and_exclude_actors(self):
        a = self.detect({"app_audit_log": [
            {"id": "7", "at": ts(10), "action": "secret.write", "target": "GEMINI_API_KEY", "channel_id": None,
             "actor_email": "boss@example.com"},
            {"id": "8", "at": ts(10), "action": "scene.regenerate", "target": "v", "channel_id": "default"}]})
        self.assertEqual([(x.kind, x.severity, x.key) for x in a], [("audit", "critical", "audit:7")])
        self.assertNotIn("boss@", a[0].line)

    def test_customer_triggered_actions_are_not_security_alerts(self):
        rows = [{"id": str(i), "at": ts(5), "action": act, "target": "org", "channel_id": None}
                for i, act in enumerate(("api_key.create", "api_key.revoke", "api_key.access", "mcp.connect",
                                         "mcp.disconnect", "api.activate", "channel.youtube.disconnect"))]
        self.assertEqual(self.detect({"app_audit_log": rows}), [])

    def test_an_operator_action_row_about_a_customers_channel_is_ignored(self):
        self.assertEqual(self.detect({"app_audit_log": [
            {"id": "1", "at": ts(5), "action": "secret.write", "target": "x", "channel_id": "their-channel"}]}), [])

    def test_an_unreadable_source_is_no_alert(self):
        engine, _, _, ops, _ = build(tables={"render_jobs": [failed_job(5)]})
        ops.sync.fail = {"render_jobs", "worker_status", "provider_balances", "creative_jobs", "publish_approvals",
                         "app_audit_log"}
        self.assertEqual(alerts.detect(ops, 15000), [])


class DeliveryTestCase(unittest.TestCase):
    def test_the_first_pass_is_a_silent_baseline_that_announces_itself_once(self):
        engine, store, tg, _, _ = build({"render_jobs": [failed_job(5)]})
        rep = engine.tick()
        self.assertTrue(rep.baseline)
        self.assertEqual(len(tg.sent()), 1)
        self.assertIn("alerts are on", tg.texts()[0])
        self.assertIn("1 existing item", tg.texts()[0])
        again = engine.tick()                       # armed now: the old failure is not announced
        self.assertFalse(again.baseline)
        self.assertEqual(again.sent, 0)
        self.assertEqual(len(tg.sent()), 1)

    def test_a_failed_baseline_send_is_retried_not_skipped(self):
        engine, store, tg, _, _ = build({"render_jobs": [failed_job(5)]}, session=FakeTelegram(status=500))
        engine.tick()
        self.assertEqual(store.rows, [])
        engine.control._session.status = 200
        self.assertTrue(engine.tick().baseline)

    def test_a_new_failure_is_sent_once_with_the_three_buttons(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        payload = tg.sent()[-1]
        self.assertEqual(payload["parse_mode"], "HTML")
        self.assertIn("WARN — failed runs", payload["text"])
        row = payload["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in row], ["Open", "Mute 24h", "Details"])
        self.assertEqual(row[0]["url"], "https://app.example.test/default/errors")
        self.assertEqual(row[1]["callback_data"], "a:mute:run")
        self.assertEqual(row[2]["callback_data"], "d:run")
        clock.advance(minutes=10)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)      # the same failure is not repeated
        self.assertEqual(engine.tick().deduped, 1)

    def test_open_button_is_dropped_when_there_is_no_app_url(self):
        engine, _, tg, ops, _ = build(cfg=OperatorConfig(github_repo="owner/repo"))
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        engine.tick()
        row = tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b["text"] for b in row], ["Mute 24h", "Details"])

    def test_alerts_of_one_kind_are_merged_into_one_message(self):
        engine, _, tg, ops, _ = build()
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(1), failed_job(2), failed_job(3)]
        before = len(tg.sent())
        rep = engine.tick()
        self.assertEqual(rep.sent, 3)
        self.assertEqual(len(tg.sent()) - before, 1)
        self.assertEqual(tg.texts()[-1].count("• Render job"), 3)

    def test_a_standing_condition_repeats_only_after_its_cooldown(self):
        w = healthy_tables()["worker_status"][0]
        engine, _, tg, ops, clock = build()
        arm(engine)
        ops.sync.tables["worker_status"] = [w | {"updated_at": ts(30)}]
        self.assertEqual(engine.tick().sent, 1)
        clock.advance(minutes=60)
        ops.sync.tables["worker_status"] = [w | {"updated_at": ts(90, clock.now)}]
        self.assertEqual(engine.tick().sent, 0)
        clock.advance(minutes=130)                    # past the 3 hour cooldown
        ops.sync.tables["worker_status"] = [w | {"updated_at": ts(220, clock.now)}]
        self.assertEqual(engine.tick().sent, 1)

    def test_the_hourly_limit_holds_back_the_rest_and_says_so(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=2)
        engine, store, tg, ops, clock = build(cfg=cfg)
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(i) for i in range(1, 6)]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.rate_held), (2, 3))
        self.assertIn("3 further alert(s) held back", tg.texts()[-1])
        self.assertEqual(engine.tick().sent, 0)       # budget is spent for this hour
        clock.advance(minutes=61)
        heartbeat(ops, clock)
        for job in ops.sync.tables["render_jobs"]:
            job["finished_at"] = ts(30, clock.now)
        self.assertEqual(engine.tick().sent, 2)       # next hour: the held ones go out

    def test_critical_alerts_ignore_the_hourly_limit(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=1)
        engine, _, tg, ops, _ = build(cfg=cfg)
        arm(engine)
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
        ops.sync.tables["worker_status"] = [w]
        ops.sync.tables["render_jobs"] = [failed_job(1), failed_job(2)]
        rep = engine.tick()
        self.assertEqual(rep.sent, 2)                 # the worker alert + one of the two failures
        self.assertEqual(rep.rate_held, 1)

    def test_quiet_hours_hold_non_critical_alerts_and_release_them_after(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        engine, store, tg, ops, clock = build(cfg=cfg)            # NOW is 12:00 UTC: inside
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        w = healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}
        ops.sync.tables["worker_status"] = [w]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (1, 1))      # only the critical one
        self.assertIn("CRITICAL", tg.texts()[-1])
        clock.advance(hours=3)                                    # 15:00: quiet is over
        ops.sync.tables["worker_status"] = [w | {"updated_at": ts(0.1, clock.now)}]
        ops.sync.tables["render_jobs"][0]["finished_at"] = ts(30, clock.now)
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)                             # the held failure is delivered now
        self.assertIn("Render job #9", tg.texts()[-1])

    def test_quiet_hours_follow_the_configured_timezone(self):
        from zoneinfo import ZoneInfo
        cfg = OperatorConfig(tz=ZoneInfo("Asia/Tashkent"), quiet_hours=(22, 7))
        self.assertFalse(cfg.in_quiet_hours(NOW))                 # 17:00 there
        self.assertTrue(cfg.in_quiet_hours(NOW.replace(hour=18)))  # 23:00 there
        self.assertTrue(cfg.in_quiet_hours(NOW.replace(hour=1)))   # 06:00 there
        self.assertFalse(cfg.in_quiet_hours(NOW.replace(hour=2)))  # 07:00 there

    def test_mute_silences_a_kind_for_a_day_and_does_not_flood_afterwards(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        self.assertIsNotNone(alerts.mute(store, "run", clock.now))
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (0, 1))
        clock.advance(hours=25)
        ops.sync.tables["render_jobs"] = [failed_job(9, minutes_ago=600)]
        self.assertEqual(engine.tick().sent, 0)                   # recorded as seen while muted

    def test_mute_all_and_unmute(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        alerts.mute(store, "all", clock.now)
        ops.sync.tables["render_jobs"] = [failed_job(1)]
        self.assertEqual(engine.tick().muted, 1)
        self.assertTrue(alerts.unmute(store, "all"))
        ops.sync.tables["render_jobs"] = [failed_job(2)]
        self.assertEqual(engine.tick().sent, 1)

    def test_mute_all_does_not_silence_critical_alerts_but_a_kind_mute_does(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        alerts.mute(store, "all", clock.now)
        ops.sync.tables["worker_status"] = [healthy_tables()["worker_status"][0] | {"updated_at": ts(30)}]
        ops.sync.tables["render_jobs"] = [failed_job(1)]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (1, 1))             # the worker alert came through
        self.assertIn("CRITICAL", tg.texts()[-1])
        alerts.mute(store, "worker", clock.now)
        clock.advance(hours=4)                                      # past the repeat time
        ops.sync.tables["worker_status"] = [healthy_tables()["worker_status"][0] | {"updated_at": ts(300, clock.now)}]
        before = len(tg.sent())
        engine.tick()
        self.assertEqual(len(tg.sent()), before)

    def test_mute_refuses_an_unknown_kind(self):
        store = MemoryAlertStore()
        self.assertIsNone(alerts.mute(store, "bogus", NOW))
        self.assertFalse(alerts.unmute(store, "bogus"))
        self.assertEqual(store.rows, [])

    def test_no_alert_memory_means_no_message(self):
        engine, store, tg, ops, _ = build({"render_jobs": [failed_job(1)]})
        store.fail_load = True
        rep = engine.tick()
        self.assertEqual(rep.state, "no_state")
        self.assertEqual(tg.calls, [])

    def test_a_failed_send_is_retried_on_the_next_pass(self):
        engine, store, tg, ops, _ = build()
        arm(engine)
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        tg.status = 500
        self.assertEqual(engine.tick().send_failed, 1)
        tg.status = 200
        self.assertEqual(engine.tick().sent, 1)

    def test_disabled_telegram_does_nothing(self):
        engine, _, tg, _, _ = build()
        engine.control = make_control(tg, chat="")
        self.assertEqual(engine.tick().state, "not_configured")
        self.assertEqual(tg.calls, [])


class FloodTestCase(unittest.TestCase):
    """Critical and ordinary alerts have separate budgets; neither starves the
    other and neither is unlimited."""

    def run_hours(self, hours, jobs, audits):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=6)
        engine, store, tg, ops, clock = build(cfg=cfg)
        arm(engine)
        sent = {"warn": 0, "critical": 0}
        for step in range(hours * 6):                       # a pass every 10 minutes
            heartbeat(ops, clock)
            ops.sync.tables["render_jobs"] = [failed_job(f"{step}-{i}", minutes_ago=5) | {"finished_at": ts(5, clock.now)}
                                              for i in range(jobs)]
            ops.sync.tables["app_audit_log"] = [
                {"id": f"a{step}-{i}", "at": ts(5, clock.now), "action": "secret.write", "target": "x",
                 "channel_id": None} for i in range(audits)]
            before = [r for r in store.rows if r["kind"] == "operator.alert" and r["delivered"]]
            engine.tick()
            after = [r for r in store.rows if r["kind"] == "operator.alert" and r["delivered"]]
            for r in after[len(before):]:
                sent["critical" if r["severity"] == "critical" else "warn"] += 1
            clock.advance(minutes=10)
        return sent

    def test_critical_alerts_do_not_starve_warnings(self):
        without = self.run_hours(2, jobs=40, audits=0)
        with_audits = self.run_hours(2, jobs=40, audits=40)
        self.assertEqual(with_audits["warn"], without["warn"])
        self.assertGreater(with_audits["warn"], 0)

    def test_critical_alerts_are_capped_per_hour(self):
        sent = self.run_hours(3, jobs=0, audits=40)
        self.assertLessEqual(sent["critical"], alerts.MAX_CRITICAL_PER_HOUR * 3 + 1)
        self.assertGreater(sent["critical"], 0)
        self.assertLess(sent["critical"], 40 * 18)

    def test_the_stores_budget_counts_each_kind_separately(self):
        from modules.operator_bot.store import replay
        rows = [{"at": ts(5), "kind": "operator.alert", "title": f"k{i}", "body": "run", "delivered": True,
                 "severity": "critical" if i < 3 else "warn"} for i in range(5)]
        state = replay(rows, NOW)
        hour = NOW - timedelta(hours=1)
        self.assertEqual((state.delivered_since(hour, critical=True), state.delivered_since(hour, critical=False)), (3, 2))


class WriteFailureTestCase(unittest.TestCase):
    """The alert feed is the memory of record. When a write to it fails (Supabase
    down for a while), an always-on process must not send the same alert on every
    pass, nor lift the hourly cap: it remembers what it sent in memory."""

    def test_a_failed_write_does_not_repeat_the_alert_every_pass(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        store.fail_write = True
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        self.assertEqual(engine.tick().sent, 1)
        for _ in range(6):                               # six more 5-minute passes
            clock.advance(minutes=5)
            heartbeat(ops, clock)
            rep = engine.tick()
            self.assertEqual(rep.sent, 0)
            self.assertEqual(rep.deduped, 1)
        self.assertEqual(len([t for t in tg.texts() if "failed runs" in t]), 1)
        self.assertEqual(store.rows[-1]["kind"], "operator.alert")       # nothing was written meanwhile
        self.assertEqual(len([r for r in store.rows if r["title"] == "run:9"]), 0)

    def test_the_hourly_cap_still_applies_when_nothing_can_be_written(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", max_alerts_per_hour=2)
        engine, store, tg, ops, clock = build(cfg=cfg)
        arm(engine)
        store.fail_write = True
        total = 0
        for step in range(10):                           # ten passes inside one hour, a new failure each time
            heartbeat(ops, clock)
            ops.sync.tables["render_jobs"] = [failed_job(f"n{step}", minutes_ago=2) | {"finished_at": ts(2, clock.now)}]
            total += engine.tick().sent
            clock.advance(minutes=5)
        self.assertEqual(total, 2)                       # exactly the cap, however many passes
        self.assertGreaterEqual(total, 1)

    def test_a_failed_digest_record_does_not_send_it_again_the_same_day(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=12)
        engine, store, tg, ops, clock = build(cfg=cfg)
        arm(engine)
        store.fail_write = True
        self.assertTrue(engine.tick().digest_sent)
        for _ in range(5):
            clock.advance(minutes=5)
            heartbeat(ops, clock)
            self.assertFalse(engine.tick().digest_sent)
        self.assertEqual(len([t for t in tg.texts() if "Daily digest" in t]), 1)
        clock.advance(days=1)
        heartbeat(ops, clock)
        self.assertTrue(engine.tick().digest_sent)       # a new date is a new digest

    def test_the_arming_notice_is_not_repeated_when_its_marker_cannot_be_written(self):
        engine, store, tg, ops, clock = build({"render_jobs": [failed_job(5)]})
        store.fail_write = True
        self.assertTrue(engine.tick().baseline)
        for _ in range(4):
            clock.advance(minutes=5)
            heartbeat(ops, clock)
            rep = engine.tick()
            self.assertFalse(rep.baseline)
            self.assertEqual(rep.sent, 0)                # the item that existed at arming is not announced either
        self.assertEqual(len(tg.sent()), 1)

    def test_once_the_store_takes_writes_again_its_rows_are_the_memory(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        store.fail_write = True
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        engine.tick()
        store.fail_write = False
        clock.advance(minutes=5)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)
        ops.sync.tables["render_jobs"] = [failed_job(9), failed_job(10)]
        clock.advance(minutes=5)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)          # only the new one
        self.assertEqual(len(engine._unrecorded), 1)

    def test_the_in_memory_list_is_bounded(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        store.fail_write = True
        for i in range(alerts.MAX_UNRECORDED + 50):
            fake = type("A", (), dict(key=f"k{i}", kind="run", severity="warn", channel_id=None))()
            engine._record(fake, True, clock.now)
        self.assertEqual(len(engine._unrecorded), alerts.MAX_UNRECORDED)


class DigestTestCase(unittest.TestCase):
    def cfg(self, **kw):
        return OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", digest_hour=12, **kw)

    def test_digest_goes_out_once_a_day_at_the_chosen_hour(self):
        engine, store, tg, _, clock = build(cfg=self.cfg())
        arm(engine)
        rep = engine.tick()
        self.assertTrue(rep.digest_sent)
        self.assertIn("Daily digest — 2026-10-14", tg.texts()[-1])
        clock.advance(minutes=10)
        self.assertFalse(engine.tick().digest_sent)
        clock.advance(days=1)
        self.assertTrue(engine.tick().digest_sent)

    def test_not_before_the_hour_but_any_time_after_it_that_day(self):
        for hour, expected in ((11, False), (12, True), (14, True), (20, True)):
            engine, _, _, _, clock = build(cfg=self.cfg(), clock=Clock(NOW.replace(hour=hour)))
            arm(engine)
            self.assertEqual(engine.tick().digest_sent, expected, hour)

    def test_off_without_a_digest_hour(self):
        engine, _, _, _, _ = build()
        arm(engine)
        self.assertFalse(engine.tick().digest_sent)

    def test_not_sent_inside_quiet_hours_but_sent_when_they_end(self):
        engine, _, _, _, clock = build(cfg=self.cfg(quiet_hours=(10, 18)))     # the digest hour is inside the window
        arm(engine)
        self.assertFalse(engine.tick().digest_sent)
        clock.advance(hours=7)                                                 # 19:00, same day
        heartbeat(engine.ops, clock)
        self.assertTrue(engine.tick().digest_sent)

    def test_mute_all_does_not_stop_the_digest(self):
        engine, store, _, _, clock = build(cfg=self.cfg())
        arm(engine)
        alerts.mute(store, "all", clock.now)
        self.assertTrue(engine.tick().digest_sent)


class SupabaseStoreTestCase(unittest.TestCase):
    """The durable memory is rows of the existing alert feed; no migration."""

    def test_rows_round_trip_through_the_alert_feed(self):
        sync = FakeSync({"alert_events": []})
        store = SupabaseAlertStore(sync)
        self.assertTrue(store.record_alert("run:5", "run", True, "warn", "default"))
        self.assertTrue(store.record_mute("run", NOW + timedelta(hours=24)))
        self.assertTrue(store.record_digest("2026-10-14"))
        for table, rows in sync.upserts:
            self.assertEqual(table, "alert_events")
            self.assertTrue(rows[0]["kind"].startswith("operator."))
            self.assertEqual(set(rows[0]) - {"kind", "severity", "title", "body", "delivered", "channel_id"}, set())
        for row in sync.tables["alert_events"]:
            row.setdefault("at", ts(1))
        state = store.load(NOW)
        self.assertEqual(state.last_seen("run:5") is not None, True)
        self.assertTrue(state.is_muted("run"))
        self.assertIn("2026-10-14", state.digest_dates)

    def test_the_bots_own_rows_are_never_written_with_a_channel(self):
        sync = FakeSync({"alert_events": []})
        store = SupabaseAlertStore(sync)
        store.record_alert("run:5", "run", True, "warn", "their-channel")
        store.record_mute("run", NOW + timedelta(hours=1))
        store.record_unmute("run")
        store.record_digest("2026-10-14")
        for _table, rows in sync.upserts:
            self.assertNotIn("channel_id", rows[0])

    def test_a_tenants_forged_rows_change_nothing_the_bot_believes(self):
        """alert_events_insert lets anyone who can view a channel insert rows with
        that channel_id and any kind, title and body."""
        forged = [
            {"at": ts(1), "kind": "operator.mute", "title": "all", "body": "9999-01-01T00:00:00Z",
             "channel_id": "their-channel", "delivered": False},
            {"at": ts(1), "kind": "operator.alert", "title": "run:77", "body": "run", "delivered": True,
             "channel_id": "their-channel", "severity": "warn"},
            {"at": ts(1), "kind": "operator.digest", "title": "2026-10-14", "body": "", "channel_id": "their-channel"},
            {"at": ts(1), "kind": "operator.alert", "title": "baseline", "body": "baseline", "delivered": False,
             "channel_id": "their-channel"},
        ]
        sync = FakeSync({"alert_events": forged})
        state = SupabaseAlertStore(sync).load(NOW)
        self.assertFalse(state.is_muted("run"))
        self.assertFalse(state.is_muted("worker", "critical"))
        self.assertIsNone(state.last_seen("run:77"))
        self.assertEqual(state.digest_dates, set())
        self.assertFalse(state.armed)
        self.assertEqual(sync.reads[0][1]["channel_id"], "is.null")        # asked of the database too

    def test_replay_itself_ignores_rows_that_carry_a_channel(self):
        """Even if a source ignored the channel filter, replay does not believe them."""
        from modules.operator_bot.store import replay
        state = replay([
            {"at": ts(1), "kind": "operator.mute", "title": "all", "body": ts(-60), "channel_id": "x"},
            {"at": ts(1), "kind": "operator.alert", "title": "run:77", "body": "run", "delivered": True,
             "channel_id": "x", "severity": "warn"}], NOW)
        self.assertEqual((state.mutes, state.alerts), ({}, []))

    def test_a_forged_row_cannot_suppress_a_real_alert_end_to_end(self):
        engine, store, tg, ops, clock = build()
        arm(engine)
        sync = FakeSync({"alert_events": list(store.rows) + [
            {"at": ts(1), "kind": "operator.mute", "title": "all", "body": "9999-01-01T00:00:00Z",
             "channel_id": "their-channel"},
            {"at": ts(1), "kind": "operator.alert", "title": "run:9", "body": "run", "delivered": True,
             "channel_id": "their-channel", "severity": "warn"}]})
        engine.store = SupabaseAlertStore(sync)
        ops.sync.tables["render_jobs"] = [failed_job(9)]
        self.assertEqual(engine.tick().sent, 1)

    def test_a_far_future_or_malformed_mute_is_capped_or_ignored(self):
        from modules.operator_bot.store import replay
        rows = [
            {"at": ts(1), "kind": "operator.mute", "title": "run", "body": "9999-12-31T23:59:59Z"},
            {"at": ts(1), "kind": "operator.mute", "title": "stuck", "body": "not a date"},
            {"at": ts(1), "kind": "operator.mute", "title": "audit", "body": "99999-01-01"},
            {"at": "9999-12-31T23:59:59Z", "kind": "operator.mute", "title": "worker",
             "body": "9999-12-31T23:59:59Z"},
        ]
        state = replay(rows, NOW)
        self.assertEqual(set(state.mutes), {"run", "worker"})
        for until in state.mutes.values():
            self.assertLessEqual(until, NOW + timedelta(hours=24))
        # and the Alerts view can still render it (a year-9999 date once overflowed astimezone)
        from modules.operator_bot import views
        self.assertIn("Muted", views.view_alerts(OperatorConfig(), state, NOW).text)

    def test_state_beyond_the_pages_read_sends_nothing(self):
        rows = [{"at": ts(1), "kind": "operator.alert", "title": f"k{i}", "body": "run", "delivered": False}
                for i in range(5001)]
        self.assertIsNone(SupabaseAlertStore(FakeSync({"alert_events": rows})).load(NOW))

    def test_state_over_one_page_is_read_in_full(self):
        rows = [{"at": ts(1), "kind": "operator.alert", "title": f"k{i}", "body": "run", "delivered": False}
                for i in range(2500)]
        state = SupabaseAlertStore(FakeSync({"alert_events": rows})).load(NOW)
        self.assertEqual(len(state.alerts), 2500)

    def test_the_read_is_filtered_to_operator_rows_in_the_lookback_window(self):
        sync = FakeSync({"alert_events": []})
        SupabaseAlertStore(sync).load(NOW)
        table, params = sync.reads[0]
        self.assertEqual(table, "alert_events")
        self.assertEqual(params["kind"], "like.operator.*")
        self.assertIn("gte.", params["at"])

    def test_the_baseline_marker_is_remembered_beyond_the_lookback_window(self):
        old = ts(60 * 24 * 10)                      # ten days ago: outside the 48 hour read
        sync = FakeSync({"alert_events": [{"at": old, "kind": "operator.alert", "title": "baseline",
                                           "body": "baseline", "delivered": False}]})
        state = SupabaseAlertStore(sync).load(NOW)
        self.assertTrue(state.armed)
        self.assertFalse(SupabaseAlertStore(FakeSync({"alert_events": []})).load(NOW).armed)

    def test_unreadable_or_unconfigured_memory_is_none(self):
        self.assertIsNone(SupabaseAlertStore(FakeSync({}, fail={"alert_events"})).load(NOW))
        off = FakeSync({})
        off.enabled = False
        self.assertIsNone(SupabaseAlertStore(off).load(NOW))
        self.assertFalse(SupabaseAlertStore(off).record_alert("k", "run", True))

    def test_an_expired_mute_is_not_a_mute_and_unmute_clears_one(self):
        from modules.operator_bot.store import replay
        rows = [{"at": ts(60 * 30), "kind": "operator.mute", "title": "run", "body": ts(60 * 6)},
                {"at": ts(60), "kind": "operator.mute", "title": "stuck", "body": ts(-600)},
                {"at": ts(30), "kind": "operator.mute", "title": "audit", "body": ts(-600)},
                {"at": ts(20), "kind": "operator.unmute", "title": "audit", "body": ""}]
        state = replay(rows, NOW)
        self.assertEqual(set(state.mutes), {"stuck"})


if __name__ == "__main__":
    unittest.main()
