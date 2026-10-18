"""The operator bot's INFORMATION-ONLY marketing channel: the `marketing` alert kind and /marketing.

Fakes only (tests/operator_bot_fakes.py): Telegram, Supabase and the clock; nothing touches the network.

What is pinned here is what would hurt:
  * a post's words, link, media or a chat id reaching the owner's chat, even if the database function were changed to
    return them (the bot keeps only closed vocabularies);
  * an alert announced twice, or never, or into quiet hours; the usual restraint (mute, hourly limit) applying;
  * a database without migration 0109 crashing the bot or silencing its other alerts;
  * ANY way for the bot to approve, edit, reject, send or resend a post: it has no write path, and this file proves
    it from three sides (behaviour on a fake that records every call, the code's own calls, the buttons it can draw).
"""

import json
import re
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from modules.operator_bot import alerts, analysis, router, views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import LANGUAGES, placeholders, t, table
from modules.operator_bot.store import MemoryAlertStore
from tests.operator_bot_fakes import (
    FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, ts,
    update_callback, update_message,
)
from tests.test_operator_bot_alerts import arm, build as build_engine, heartbeat

ROOT = Path(__file__).resolve().parent.parent
FN = "operator_marketing_summary"

# Everything a post says. None of it may ever appear in a message.
POST_WORDS = ("Secret-en-words", "Секретный-ru-текст", "Maxfiy-uz-sozlar", "/leak-link-path",
              "showcase/leak-media-file.mp4", "-1001234567890", "news:leak-key", "pr:#777")


def stamp(minutes_ago):
    return ts(minutes_ago)


def counts(**over):
    base = {"draft": 0, "approved": 0, "sending": 0, "sent": 0, "failed": 0, "dead": 0, "rejected": 0, "expired": 0}
    base.update(over)
    return base


def summary(minutes_ago_sent=None, sent_kind="news", failure=None, enabled=False, used=0, cap=2, **count_over):
    """What operator_marketing_summary() answers (migration 0109)."""
    return {
        "ok": True, "counts": counts(**count_over), "used_7d": used, "max_per_7d": cap, "enabled": enabled,
        "last_sent_at": stamp(minutes_ago_sent) if minutes_ago_sent is not None else None,
        "last_sent_kind": sent_kind if minutes_ago_sent is not None else None,
        "last_failure": failure,
    }


def failure(status="failed", code="blocked", kind="news", minutes_ago=30):
    return {"status": status, "last_error_code": code, "kind": kind, "at": stamp(minutes_ago)}


def ops_with(answer=None, **kw):
    tables = healthy_tables()
    rpcs = {FN: answer} if answer is not None else {}
    return make_ops(tables, FakeHttp({**site_ok(), **github_ok()}), rpcs=rpcs, **kw)


def engine_with(answer=None, **kw):
    engine, store, tg, ops, clock = build_engine(**kw)
    if answer is not None:
        ops.sync.rpcs[FN] = answer
    return engine, store, tg, ops, clock


def bot_with(answer=None, chat="100"):
    tg = FakeTelegram()
    ops, sync = ops_with(answer)
    store = MemoryAlertStore(lambda: NOW)
    bot = router.OperatorBot(make_control(tg, chat=chat), None, ops, store, ops.cfg, clock=lambda: NOW.timestamp())
    return bot, tg, sync, store


def detect(answer, lang="en"):
    _, _, _, ops, _ = engine_with(answer)
    return [a for a in alerts.detect(ops, 15000, lang) if a.kind == "marketing"]


# -- the read ---------------------------------------------------------------

class SourceTestCase(unittest.TestCase):
    def test_it_calls_the_one_function_with_no_arguments_and_caches_the_answer_for_a_pass(self):
        ops, sync = ops_with(summary(draft=1))
        self.assertTrue(ops.marketing_summary().ok)
        ops.marketing_summary()
        self.assertEqual(sync.rpc_calls, [(FN, {})])
        ops.reset()
        ops.marketing_summary()
        self.assertEqual(len(sync.rpc_calls), 2)

    def test_a_database_without_the_function_is_not_set_up_yet_not_an_error(self):
        ops, sync = ops_with(None)
        sec = ops.marketing_summary()
        self.assertEqual((sec.ok, sec.note), (False, "not set up yet"))

    def test_a_failing_or_malformed_answer_is_unavailable_never_a_number(self):
        for answer in ({"ok": False}, [], "x", 5, {"counts": {}}):
            ops, _ = ops_with(answer)
            sec = ops.marketing_summary()
            self.assertEqual((sec.ok, sec.note), (False, "unavailable"), answer)
        ops, sync = ops_with(summary())
        sync.rpc_fail.add(FN)
        self.assertEqual(ops.marketing_summary().note, "unavailable")

    def test_a_client_without_rpc_or_without_a_key_does_not_crash(self):
        class NoRpc:
            enabled = True

        ops, _ = ops_with(summary())
        ops.sync = NoRpc()
        self.assertEqual(ops.marketing_summary().note, "unavailable")
        ops.reset()
        ops.sync = None
        self.assertEqual(ops.marketing_summary().note, "not configured")

    def test_the_bot_calls_only_its_allow_listed_read_functions(self):
        from modules.operator_bot.sources import _READ_FUNCTIONS

        self.assertEqual(_READ_FUNCTIONS, {FN})
        ops, sync = ops_with(summary())
        sync.rpcs["owner_marketing_kill"] = {"ok": True}
        for name in ("owner_marketing_kill", "claim_marketing_post", "x/../y", ""):
            sec = ops._rpc(name)
            self.assertEqual((sec.ok, sec.note), (False, "unavailable"), name)
        self.assertEqual(sync.rpc_calls, [])                         # refused before any request

    def test_the_client_refuses_a_function_name_that_is_not_a_plain_name(self):
        from modules.supabase_sync import SupabaseSync

        sync = SupabaseSync(url="https://x.supabase.test", service_key="service-key-value")
        with patch("modules.supabase_sync.requests.post") as post:
            for name in ("", "A", "a-b", "a/b", "../x", "a b", "a?x=1", "1a", None):
                with self.assertRaises(ValueError, msg=name):
                    sync.rpc_strict(name)
        post.assert_not_called()

    def test_the_client_names_a_missing_function_and_never_logs_a_body(self):
        from modules.supabase_sync import SupabaseReadError

        self.assertTrue(SupabaseReadError(FN, 404, "PGRST202").function_missing)
        self.assertTrue(SupabaseReadError(FN, 404, "42883").function_missing)
        self.assertFalse(SupabaseReadError(FN, 500, "").function_missing)
        self.assertFalse(SupabaseReadError(FN, 404, "PGRST202").table_missing)       # the table check is unchanged


class NormaliserTestCase(unittest.TestCase):
    def test_only_closed_vocabularies_survive(self):
        dirty = summary(sent_kind="<script>", failure={"status": "failed", "last_error_code": "sk-abcdef free text",
                                                       "kind": "Secret-en-words", "at": stamp(5)}, minutes_ago_sent=5)
        dirty["counts"]["Secret-en-words"] = 9
        dirty["texts"] = {"en": "Secret-en-words"}
        st = analysis.marketing_state(dirty)
        self.assertEqual(set(st), {"counts", "used", "cap", "enabled", "sent_at", "sent_kind", "failure"})
        self.assertEqual(set(st["counts"]), set(analysis.MARKETING_STATUSES))
        self.assertIsNone(st["sent_kind"])
        self.assertEqual((st["failure"]["code"], st["failure"]["kind"]), (None, None))
        self.assertNotIn("Secret", json.dumps(st, default=str))

    def test_a_count_that_is_not_a_number_is_unknown_not_zero(self):
        st = analysis.marketing_state({"ok": True, "counts": {"draft": "x", "sent": -1, "dead": 1.5, "failed": True,
                                                              "approved": 3}, "enabled": "yes", "used_7d": None})
        self.assertEqual(st["counts"]["approved"], 3)
        for k in ("draft", "sent", "dead", "failed", "sending", "rejected", "expired"):
            self.assertIsNone(st["counts"][k], k)
        self.assertIsNone(st["enabled"])
        self.assertIsNone(st["used"])

    def test_the_last_result_is_the_newer_of_sent_and_failed(self):
        newer_fail = analysis.marketing_state(summary(minutes_ago_sent=90, failure=failure("dead", "unconfirmed", minutes_ago=10)))
        self.assertEqual(analysis.marketing_last_result(newer_fail)["status"], "dead")
        newer_sent = analysis.marketing_state(summary(minutes_ago_sent=5, failure=failure(minutes_ago=60)))
        self.assertEqual(analysis.marketing_last_result(newer_sent)["status"], "sent")
        self.assertIsNone(analysis.marketing_last_result(analysis.marketing_state(summary())))


# -- /marketing -------------------------------------------------------------

class CommandTestCase(unittest.TestCase):
    def view(self, answer, lang="en"):
        ops, _ = ops_with(answer)
        return views.view_marketing(ops, lang)

    def test_counts_week_switch_and_the_last_result(self):
        r = self.view(summary(minutes_ago_sent=125, sent_kind="price", enabled=True, used=1, cap=2,
                              draft=2, approved=1, sent=3, dead=1, expired=4))
        self.assertEqual(r.text.split("\n"), [
            "<b>Marketing posts</b>",
            "Poster switch: on",
            "Posts in the last 7 days: 1 of 2",
            "draft 2 · approved 1 · sending 0 · sent 3 · failed 0 · dead 1 · rejected 0 · expired 4",
            "Last result: <code>sent</code> (price) · 2h 5m ago",
            "Counts only: no texts, links or channel ids. Deciding happens in the app; nothing here approves, edits or sends."])

    def test_the_last_failure_shows_its_code_age_and_named_fix(self):
        text = self.view(summary(failure=failure("failed", "blocked", minutes_ago=30))).text
        self.assertIn("Last result: failed (<code>blocked</code>) · 30m ago — the bot is not an administrator", text)
        text = self.view(summary(failure=failure("dead", "unconfirmed", minutes_ago=7))).text
        self.assertIn("dead (<code>unconfirmed</code>) · 7m ago — check the channel, do not resend", text)

    def test_nothing_sent_yet_and_switch_off_are_said_plainly(self):
        text = self.view(summary()).text
        self.assertIn("Poster switch: off", text)
        self.assertIn("Last result: nothing sent yet", text)

    def test_an_unknown_is_never_a_number(self):
        bad = summary()
        bad["enabled"], bad["used_7d"], bad["max_per_7d"], bad["counts"]["sent"] = None, None, None, "n/a"
        text = self.view(bad).text
        self.assertIn("Poster switch: unknown", text)
        self.assertIn("Posts in the last 7 days: unknown of unknown", text)
        self.assertIn("sent unknown", text)

    def test_without_the_migration_it_says_not_available_yet(self):
        r = self.view(None)
        self.assertIn("not available yet", r.text)
        self.assertIn("migration 0109", r.text)
        self.assertNotIn("Poster switch", r.text)
        self.assertEqual(self.view({"ok": False}).text.split("\n")[1], "Marketing summary: unknown (unavailable)")

    def test_the_buttons_are_open_refresh_menu_and_a_way_to_the_approvals_list(self):
        r = self.view(summary())
        flat = [b for row in r.keyboard for b in row]
        self.assertIn("https://app.example.test/all-channels/marketing", [b.get("url") for b in flat])
        self.assertIn("c:marketing", [b.get("callback_data") for b in flat])
        self.assertIn("c:menu", [b.get("callback_data") for b in flat])

    def test_every_language_reads_the_same_facts_with_no_missing_key(self):
        answer = summary(minutes_ago_sent=3, failure=failure("failed", "bad_request", minutes_ago=1), enabled=True,
                         used=2, draft=1)
        for lang in LANGUAGES:
            for a in (answer, None, {"ok": False}, summary()):
                text = self.view(a, lang).text
                self.assertNotRegex(text, r"\b(marketing|mk|mkfix|mkst)\.[a-z_0-9]+")
                self.assertLessEqual(len(text), 4096)
        ru = self.view(answer, "ru").text
        self.assertIn("Постов за последние 7 дней: 2 из 2", ru)
        self.assertIn("Пост отклонён", ru)
        self.assertIn("Marketing postlari", self.view(answer, "uz").text)

    def test_it_is_in_help_the_menu_buttons_and_the_alert_kinds(self):
        self.assertIn("marketing", views.READ_COMMANDS)
        self.assertIn("marketing", views.ALERT_KINDS)
        self.assertEqual(views.KIND_COMMAND["marketing"], "marketing")
        for lang in LANGUAGES:
            self.assertIn("/marketing —", views.view_help(lang).text)
            self.assertIn("c:marketing", [b["callback_data"] for row in views.view_menu(OperatorConfig(), lang).keyboard
                                          for b in row])
            self.assertNotEqual(views.kind_label(lang, "marketing"), "marketing")
            self.assertTrue(t(lang, "cmd.marketing") and t(lang, "cmddesc.marketing") and t(lang, "btn.open_marketing"))

    def test_the_router_answers_the_command_and_the_buttons(self):
        for send in (lambda b: b.handle_update(update_message("/marketing")),
                     lambda b: b.handle_update(update_callback("c:marketing")),
                     lambda b: b.handle_update(update_callback("d:marketing"))):
            bot, tg, sync, store = bot_with(summary(draft=2))
            send(bot)
            self.assertIn("Marketing posts", tg.texts()[-1])
            self.assertIn("draft 2", tg.texts()[-1])
        bot, tg, sync, store = bot_with(summary())
        bot.handle_update(update_message("/mute marketing"))
        self.assertTrue(store.load(NOW).is_muted("marketing", "info"))

    def test_without_the_migration_the_whole_bot_still_answers(self):
        bot, tg, sync, store = bot_with(None)
        for text in ("/marketing", "/health", "/approvals", "/alerts", "/help", "/menu"):
            bot.handle_update(update_message(text))
        self.assertEqual(len(tg.texts()), 6)
        self.assertIn("not available yet", tg.texts()[0])
        self.assertNotIn(router.FAILED_REPLY, tg.texts())


# -- the alerts -------------------------------------------------------------

class AlertDetectionTestCase(unittest.TestCase):
    def test_a_healthy_unmigrated_or_quiet_system_has_nothing_to_say(self):
        self.assertEqual(detect(None), [])
        self.assertEqual(detect(summary(sent=5, expired=2, rejected=1)), [])
        self.assertEqual(detect({"ok": False}), [])

    def test_drafts_waiting_are_a_count_and_nothing_else(self):
        (one,) = detect(summary(draft=1))
        self.assertEqual((one.kind, one.key, one.severity, one.channel_id), ("marketing", "marketing:drafts:1", "info", None))
        self.assertEqual(one.line, "1 post is waiting for your approval — decide in the app")
        (two,) = detect(summary(draft=2))
        self.assertEqual(two.line, "2 posts are waiting for your approval — decide in the app")
        self.assertEqual(two.key, "marketing:drafts:2")
        self.assertEqual(two.cooldown_min, 0)           # the engine's rising-count gate decides, not a timer

    def test_a_dead_post_says_check_the_channel_and_do_not_resend(self):
        (a,) = detect(summary(failure=failure("dead", "unconfirmed", "price", minutes_ago=20)))
        self.assertEqual((a.kind, a.severity), ("marketing", "critical"))   # may be live: quiet hours must not hold it
        self.assertTrue(a.key.startswith("marketing:dead:"))
        self.assertEqual(a.line, f"A price post ended unconfirmed ({views.marketing_time(NOW - timedelta(minutes=20))}): "
                                 "check the channel, do not resend")

    def test_a_failed_post_names_its_closed_code_and_the_fix(self):
        fixes = {"blocked": "not an administrator", "bad_request": "The post was refused: check the channel setting and the text",
                 "not_configured": "replace it in the server settings", "rate_limited": "retries ran out",
                 "network": "retries ran out", "http_5xx": "do not resend", "unconfirmed": "do not resend"}
        self.assertEqual(set(fixes), set(analysis.MARKETING_ERROR_CODES))
        for code, words in fixes.items():
            (a,) = detect(summary(failure=failure("failed", code, "news", 15)))
            self.assertTrue(a.key.startswith("marketing:failed:"), a.key)
            self.assertIn(f"A news post failed (<code>{code}</code>", a.line)
            self.assertIn(words, a.line, code)

    def test_a_code_outside_the_closed_list_gets_no_invented_advice(self):
        (a,) = detect(summary(failure=failure("failed", "something_new", "news", 15)))
        self.assertIn("<code>?</code>", a.line)
        self.assertTrue(a.line.endswith("see the app"))

    def test_a_sent_post_is_one_line_with_kind_and_time(self):
        (a,) = detect(summary(minutes_ago_sent=4, sent_kind="showcase"))
        self.assertEqual((a.kind, a.severity, a.cooldown_min), ("marketing", "info", 0))
        self.assertEqual(a.line, f"A showcase post was sent ({views.marketing_time(NOW - timedelta(minutes=4))})")

    def test_a_result_older_than_a_day_is_history_not_news(self):
        self.assertEqual(detect(summary(minutes_ago_sent=60 * 25, failure=failure("dead", "unconfirmed", minutes_ago=60 * 26))), [])

    def test_the_keys_do_not_depend_on_the_language(self):
        answer = summary(draft=3, minutes_ago_sent=4, failure=failure("failed", "blocked", minutes_ago=9))
        self.assertEqual(len({tuple(sorted(a.key for a in detect(answer, lang))) for lang in LANGUAGES}), 1)
        for lang in LANGUAGES:
            for a in detect(answer, lang):
                self.assertNotIn("alert.marketing", a.line)
                self.assertNotRegex(a.line, r"\b(mk|mkfix|mkst)\.")

    def test_a_malformed_answer_cannot_end_the_pass_or_silence_other_alerts(self):
        engine, store, tg, ops, clock = engine_with(summary(draft=1))
        arm(engine)
        ops.sync.rpcs[FN] = {"ok": True, "counts": "garbage", "last_failure": 7, "last_sent_at": 12345}
        ops.sync.tables["render_jobs"] = [
            {"id": 7, "channel_id": "default", "kind": "daily", "status": "failed", "attempts": 3, "max_attempts": 3,
             "finished_at": ts(30), "created_at": ts(50)}]
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        self.assertIn("Render job #7", " ".join(tg.texts()))


class AlertDeliveryTestCase(unittest.TestCase):
    def tick_with(self, engine, ops, clock, n, minutes=10):
        clock.advance(minutes=minutes)
        heartbeat(ops, clock)
        ops.sync.rpcs[FN] = summary(draft=n)
        return engine.tick()

    def test_drafts_waiting_go_out_once_with_an_open_button_to_the_app_page(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        ops.sync.rpcs[FN] = summary(draft=2)
        self.assertEqual(engine.tick().sent, 1)
        text = tg.texts()[-1]
        self.assertIn("INFO — marketing posts", text)
        self.assertIn("2 posts are waiting for your approval", text)
        row = tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b.get("url") or b.get("callback_data") for b in row],
                         ["https://app.example.test/all-channels/marketing", "a:mute:marketing", "d:marketing"])

    def test_the_same_count_is_not_repeated_however_long_it_stands(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 1)
        for _ in range(5):
            self.assertEqual(self.tick_with(engine, ops, clock, 2, minutes=30 * 60 // 5).sent, 0)
        self.assertEqual(len(tg.texts()), 2)                         # the arming note and the one alert

    def test_a_fall_is_the_owners_own_action_and_says_nothing(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 1)
        self.assertEqual(self.tick_with(engine, ops, clock, 1).sent, 0)        # approved one of two
        self.assertEqual(len(tg.texts()), 2)
        # ... but the next NEW draft (1 -> 2) is news, because the fall was remembered
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 1)
        self.assertIn("2 posts are waiting", tg.texts()[-1])

    def test_zero_clears_the_memory_so_a_new_draft_within_a_day_is_announced(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        self.assertEqual(self.tick_with(engine, ops, clock, 1).sent, 1)
        self.assertEqual(self.tick_with(engine, ops, clock, 0).sent, 0)
        self.assertEqual(self.tick_with(engine, ops, clock, 1).sent, 1)        # 1 -> 0 -> 1 inside 24 hours
        self.assertIn("1 post is waiting", tg.texts()[-1])
        self.assertEqual(self.tick_with(engine, ops, clock, 1).sent, 0)

    def test_zero_to_one_and_one_to_three_are_announced(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        self.assertEqual(self.tick_with(engine, ops, clock, 0).sent, 0)
        self.assertEqual(self.tick_with(engine, ops, clock, 1).sent, 1)
        self.assertEqual(self.tick_with(engine, ops, clock, 3).sent, 1)
        self.assertIn("3 posts are waiting", tg.texts()[-1])

    def test_an_unreadable_summary_neither_announces_nor_forgets(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 1)
        ops.sync.rpc_fail.add(FN)
        clock.advance(minutes=10)
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 0)
        ops.sync.rpc_fail.clear()
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 0)        # the count is still the one announced

    def test_a_muted_rise_is_remembered_and_not_replayed_when_the_mute_ends(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        alerts.mute(store, "marketing", clock())
        rep = self.tick_with(engine, ops, clock, 2)
        self.assertEqual((rep.sent, rep.muted), (0, 1))
        clock.advance(hours=25)
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 0)

    def test_a_rise_held_by_quiet_hours_goes_out_after_them_unless_it_fell_back(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        engine, store, tg, ops, clock = engine_with(None, cfg=cfg)
        arm(engine)
        rep = self.tick_with(engine, ops, clock, 1)
        self.assertEqual((rep.sent, rep.quiet_held), (0, 1))
        self.assertEqual(self.tick_with(engine, ops, clock, 1, minutes=180).sent, 1)

    def test_the_count_that_exists_when_the_bot_is_first_switched_on_is_the_baseline(self):
        engine, store, tg, ops, clock = engine_with(summary(draft=2))
        self.assertTrue(engine.tick().baseline)
        self.assertEqual(self.tick_with(engine, ops, clock, 2).sent, 0)
        self.assertEqual(self.tick_with(engine, ops, clock, 3).sent, 1)

    def test_a_result_is_announced_once(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        ops.sync.rpcs[FN] = summary(minutes_ago_sent=3, failure=failure("dead", "unconfirmed", minutes_ago=2))
        self.assertEqual(engine.tick().sent, 2)
        self.assertEqual(len(tg.texts()), 2)                       # the arming note and ONE merged message
        for _ in range(3):
            clock.advance(minutes=5)
            heartbeat(ops, clock)
            self.assertEqual(engine.tick().sent, 0)

    def test_what_already_exists_when_the_bot_is_first_switched_on_is_not_announced(self):
        engine, store, tg, ops, clock = engine_with(summary(draft=2, minutes_ago_sent=3))
        self.assertTrue(engine.tick().baseline)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_mute_silences_the_kind_and_does_not_become_a_flood_when_it_ends(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        alerts.mute(store, "marketing", clock())
        ops.sync.rpcs[FN] = summary(draft=1, minutes_ago_sent=2)
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (0, 2))
        clock.advance(hours=25)
        heartbeat(ops, clock)
        ops.sync.rpcs[FN] = summary(draft=1, minutes_ago_sent=60 * 22)
        self.assertEqual(engine.tick().sent, 0)                    # the muted count is remembered: nothing replayed
        self.assertEqual(engine.tick().sent, 0)

    def test_quiet_hours_hold_it_and_the_hourly_limit_applies(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        engine, store, tg, ops, clock = engine_with(None, cfg=cfg)
        arm(engine)
        ops.sync.rpcs[FN] = summary(draft=1)
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (0, 1))
        clock.advance(hours=3)                                     # the window is over: it goes out, once
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)

    def test_a_dead_post_is_not_held_by_quiet_hours_or_a_mute_of_all(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        engine, store, tg, ops, clock = engine_with(None, cfg=cfg)
        arm(engine)
        alerts.mute(store, "all", clock())
        ops.sync.rpcs[FN] = summary(draft=1, failure=failure("dead", "unconfirmed", minutes_ago=2))
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        self.assertIn("do not resend", tg.texts()[-1])
        self.assertIn("CRITICAL", tg.texts()[-1])
        # a failed one is only a warning: held by the quiet window, muted by "all"
        engine, store, tg, ops, clock = engine_with(None, cfg=cfg)
        arm(engine)
        ops.sync.rpcs[FN] = summary(failure=failure("failed", "blocked", minutes_ago=2))
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (0, 1))

    def test_the_alerts_page_lists_a_mute_button_for_the_kind(self):
        bot, tg, sync, store = bot_with(summary())
        bot.handle_update(update_message("/alerts"))
        data = [b.get("callback_data") for row in tg.sent()[-1]["reply_markup"]["inline_keyboard"] for b in row]
        self.assertIn("a:mute:marketing", data)

    def test_the_missing_function_sends_nothing_and_the_other_alerts_still_go(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        ops.sync.tables["render_jobs"] = [
            {"id": 9, "channel_id": "default", "kind": "daily", "status": "failed", "attempts": 3, "max_attempts": 3,
             "finished_at": ts(30), "created_at": ts(50)}]
        rep = engine.tick()
        self.assertEqual(rep.sent, 1)
        self.assertNotIn("marketing", " ".join(tg.texts()).lower())

    def test_there_is_no_link_without_an_app_url(self):
        cfg = OperatorConfig(app_url=None, github_repo="owner/repo")
        engine, store, tg, ops, clock = engine_with(None, cfg=cfg)
        arm(engine)
        ops.sync.rpcs[FN] = summary(draft=1)
        engine.tick()
        row = tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]
        self.assertTrue(all("url" not in b for b in row))


# -- no post body anywhere ----------------------------------------------------

class NoPostBodyTestCase(unittest.TestCase):
    """A hostile or changed database function must not be able to put a post, its link, its media or a chat in a message."""

    def tainted(self):
        s = summary(draft=2, minutes_ago_sent=5, sent_kind="news", enabled=True, used=1,
                    failure={"status": "dead", "last_error_code": "unconfirmed", "kind": "news", "at": stamp(3),
                             "texts": {"en": POST_WORDS[0], "ru": POST_WORDS[1], "uz": POST_WORDS[2]},
                             "link": POST_WORDS[3], "media_path": POST_WORDS[4], "chat_id": POST_WORDS[5],
                             "idempotency_key": POST_WORDS[6], "source_ref": POST_WORDS[7]})
        s.update({"texts": {"en": POST_WORDS[0]}, "link": POST_WORDS[3], "media_path": POST_WORDS[4],
                  "chat_id": POST_WORDS[5], "posts": [{"texts": POST_WORDS[1], "id": "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"}],
                  "last_sent_kind": "news"})
        s["counts"]["note"] = POST_WORDS[2]
        return s

    def assert_clean(self, text, where):
        for word in POST_WORDS:
            self.assertNotIn(word, text, where)
        self.assertNotRegex(text, r"[0-9a-f]{8}-[0-9a-f]{4}-", where)

    def test_the_command_alerts_and_buttons_carry_no_post_text_in_any_language(self):
        answer = self.tainted()
        for lang in LANGUAGES:
            ops, _ = ops_with(answer)
            reply = views.view_marketing(ops, lang)
            self.assert_clean(reply.text + json.dumps(reply.keyboard, ensure_ascii=False), f"view {lang}")
            _, _, _, ops2, _ = engine_with(answer)
            found = alerts.detect(ops2, 15000, lang)
            self.assertTrue([a for a in found if a.kind == "marketing"])
            for a in found:
                self.assert_clean(a.line + a.key, f"alert {lang}")
            composed = alerts.compose("marketing", [a for a in found if a.kind == "marketing"], ops2.cfg, lang=lang)
            self.assert_clean(composed.text + json.dumps(composed.keyboard, ensure_ascii=False), f"compose {lang}")

    def test_the_whole_delivery_path_sends_none_of_it(self):
        engine, store, tg, ops, clock = engine_with(None)
        arm(engine)
        ops.sync.rpcs[FN] = self.tainted()
        engine.tick()
        sent = json.dumps(tg.sent(), ensure_ascii=False)
        self.assert_clean(sent, "telegram payloads")
        self.assertIn("waiting for your approval", sent)
        # nor does the alert memory (rows of alert_events) keep any of it
        self.assert_clean(json.dumps(store.rows, ensure_ascii=False), "alert memory")

    def test_the_bot_never_reads_the_posts_tables(self):
        bot, tg, sync, store = bot_with(self.tainted())
        sync.tables["marketing_posts"] = [{"texts": {"en": POST_WORDS[0]}, "link": POST_WORDS[3]}]
        for text in ("/marketing", "/health", "/digest", "/status", "/approvals", "/alerts"):
            bot.handle_update(update_message(text))
        engine, store2, tg2, ops2, clock = engine_with(self.tainted())
        ops2.sync.tables["marketing_posts"] = sync.tables["marketing_posts"]
        arm(engine)
        engine.tick()
        for reads in (sync.reads, ops2.sync.reads):
            self.assertEqual([r for r in reads if "marketing" in r[0] or "showcase" in r[0]], [])
        self.assert_clean(" ".join(tg.texts() + tg2.texts()), "all messages")

    def test_the_copy_has_no_slot_that_could_hold_a_post_body(self):
        # the placeholders the marketing messages take are numbers, closed words, codes and times: never a field
        allowed = {"n", "kind", "code", "fix", "when", "why", "used", "cap", "status",
                   "draft", "approved", "sending", "sent", "failed", "dead", "rejected", "expired"}
        for lang in LANGUAGES:
            for key, template in table(lang).items():
                if key.startswith(("marketing.", "alert.marketing", "mk.", "mkst.", "mkfix.")):
                    self.assertLessEqual(placeholders(template), allowed, (lang, key))


# -- the bot cannot decide for the owner ---------------------------------------

BOT_SOURCES = sorted(list((ROOT / "modules" / "operator_bot").glob("*.py"))
                     + [ROOT / "tools" / n for n in ("operator_bot_service.py", "operator_bot_server.py", "run_operator_alerts.py",
                                                     "run_telegram_control.py")]
                     + [ROOT / "modules" / "telegram_control.py", ROOT / "modules" / "tg_text.py"])


class NoWritePathTestCase(unittest.TestCase):
    """The poster is approved in the app behind the password and the authenticator code. An Approve in Telegram would
    reduce that to whoever holds the allow-listed Telegram account, so the bot has no way to approve, edit, reject,
    send or resend a post. Proved three ways: by what the code calls, by what it can be asked, by what it draws."""

    def test_the_code_calls_exactly_one_database_function_and_writes_only_its_own_memory(self):
        called = set()
        for path in BOT_SOURCES:
            text = path.read_text(encoding="utf-8")
            called |= set(re.findall(r"""rpc(?:_strict)?\(\s*["']([a-z_0-9]+)["']""", text))
            called |= set(re.findall(r"""_rpc\(\s*["']([a-z_0-9]+)["']""", text))
            for name in ("owner_marketing_", "claim_marketing_post", "complete_marketing_post", "marketing_draft_upsert",
                         "marketing_posts", "marketing_settings", "showcase_assets", "marketing_cap_used"):
                self.assertNotIn(name, text, f"{path.name} names {name}")
        self.assertEqual(called, {FN})

    def test_only_the_alert_memory_ever_writes(self):
        # sync writes (upsert / insert_new / update) in the bot: the store (alert_events rows, the language, the digest)
        # and the update-id claim of a webhook or poll; never the router, the views, the sources or the alert detector
        writers = {}
        for path in BOT_SOURCES:
            hits = re.findall(r"\.(?:upsert|insert_new|update)\(", path.read_text(encoding="utf-8"))
            if hits:
                writers[path.name] = len(hits)
        self.assertLessEqual(set(writers), {"store.py", "webhook.py", "operator_bot_service.py", "run_telegram_control.py",
                                            "operator_bot_server.py"}, writers)

    def test_no_command_or_button_can_decide_a_post(self):
        for word in ("approve", "reject", "edit", "send", "resend", "retry", "publish", "post", "draft", "kill", "enable"):
            bot, tg, sync, store = bot_with(summary(draft=2, enabled=True))
            for text in (f"/{word}", f"/{word} 1", f"/marketing {word}", f"/marketing {word} 1234abcd"):
                bot.handle_update(update_message(text))
            for data in (f"c:{word}", f"d:{word}", f"a:{word}:marketing", f"a:mute:{word}"):
                bot.handle_update(update_callback(data))
            self.assertEqual([c for c in sync.rpc_calls if c[0] != FN], [], word)
            self.assertEqual([tbl for tbl, _ in sync.upserts if tbl != "alert_events"], [], word)
            self.assertEqual([r for r in sync.reads if "marketing" in r[0]], [], word)
        # what a typed /marketing does is read the summary, and nothing else
        bot, tg, sync, store = bot_with(summary(draft=2))
        bot.handle_update(update_message("/marketing approve 1234abcd"))
        self.assertEqual(sync.rpc_calls, [(FN, {})])
        self.assertEqual(sync.upserts, [])

    def test_the_callback_grammar_has_no_verb_for_a_post(self):
        pattern = router._CALLBACK
        for data in ("c:marketing", "d:marketing", "a:mute:marketing", "a:unmute:marketing"):
            self.assertTrue(pattern.match(data), data)
        for data in ("a:approve:1234abcd", "a:reject:12", "m:approve:1", "p:send:1", "a:send:marketing"):
            self.assertIsNone(pattern.match(data), data)
        self.assertEqual(set(re.findall(r"a:\(\?:([a-z|]+)\)", pattern.pattern)[0].split("|")), {"mute", "unmute"})

    def test_every_button_the_marketing_messages_draw_is_navigation_or_mute(self):
        verbs = re.compile(r"approv|reject|edit|send|resend|retry|publish", re.I)
        allowed = re.compile(r"^(c:(marketing|approvals|menu)|d:marketing|a:mute:marketing|a:unmute:marketing)$")
        for lang in LANGUAGES:
            ops, _ = ops_with(summary(draft=2, minutes_ago_sent=5, failure=failure("dead", "unconfirmed", minutes_ago=3)))
            found = [a for a in alerts.detect(ops, 15000, lang) if a.kind == "marketing"]
            for reply in (views.view_marketing(ops, lang), alerts.compose("marketing", found, ops.cfg, lang=lang)):
                for button in (b for row in reply.keyboard for b in row):
                    # a button either opens a page of the app (a URL) or runs a read-only command of this bot
                    if "callback_data" in button:
                        self.assertRegex(button["callback_data"], allowed)
                    else:
                        self.assertTrue(button["url"].startswith("https://app.example.test/"), button)
                    # /approvals is the bot's old read-only list, labelled "Approvals" (a noun, not a verb)
                    if lang == "en" and button.get("callback_data") != "c:approvals":
                        self.assertIsNone(verbs.search(button["text"]), button)

    def test_help_and_menu_promise_no_decision_in_any_language(self):
        for lang in LANGUAGES:
            help_text = views.view_help(lang).text
            self.assertNotRegex(help_text, r"/(approve|reject|resend|send|edit|publish)\b")
            self.assertIn(t(lang, "help.viewonly"), help_text)
        self.assertIn("nothing here approves, edits or sends", t("en", "marketing.footer"))


class DocsTestCase(unittest.TestCase):
    DOCS = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")

    def test_the_docs_name_the_command_the_kind_the_function_and_the_limit(self):
        for needle in ("/marketing", "`marketing`", "operator_marketing_summary", "0109", "information only",
                       "rollback_0109_operator_marketing_summary.sql", "not available yet"):
            self.assertIn(needle, self.DOCS)
        self.assertRegex(self.DOCS, r"\| `/marketing` \| Marketing \| Маркетинг \| Marketing \|")

    def test_the_marketing_copy_has_the_same_keys_and_placeholders_in_every_language(self):
        keys = [k for k in table("en") if k.startswith(("marketing.", "alert.marketing", "mk.", "mkst.", "mkfix."))
                or k in ("cmd.marketing", "cmddesc.marketing", "kind.marketing", "btn.open_marketing")]
        self.assertGreaterEqual(len(keys), 30)
        for lang in LANGUAGES:
            for k in keys:
                self.assertIn(k, table(lang), (lang, k))
                self.assertEqual(placeholders(table(lang)[k]), placeholders(table("en")[k]), (lang, k))



# -- kinds from a newer database -------------------------------------------

class UnknownKindTestCase(unittest.TestCase):
    """The database learns a new kind (migration 0110) before this code does. The bot must neither crash nor hide the
    post: counts per status already cover every kind, and the kind is named ``other`` (never the database's word)."""

    def test_a_clean_unknown_kind_is_other_and_a_dirty_one_is_unknown(self):
        for kind in ("promo", "custom", "x" * 24, "some_new_kind"):
            self.assertEqual(analysis.marketing_kind(kind), "other", kind)
        for kind in ("news", "showcase", "price"):
            self.assertEqual(analysis.marketing_kind(kind), kind)
        for kind in (None, "", 7, ["promo"], {"a": 1}, "Promo", "p2", "a-b", "x" * 25, "<script>", " promo"):
            self.assertIsNone(analysis.marketing_kind(kind), repr(kind))

    def test_the_state_names_an_unknown_kind_other_and_never_keeps_the_word(self):
        st = analysis.marketing_state(summary(minutes_ago_sent=5, sent_kind="promo", draft=1,
                                              failure=failure("failed", "blocked", "custom", 9)))
        self.assertEqual((st["sent_kind"], st["failure"]["kind"]), ("other", "other"))
        self.assertNotIn("promo", json.dumps(st, default=str))
        self.assertNotIn("custom", json.dumps(st, default=str))

    def test_counts_cover_posts_of_every_kind_and_unknown_fields_or_statuses_are_ignored(self):
        answer = summary(draft=3, sent=2)
        answer["counts"]["brand_new_status"] = 5
        answer["by_kind"] = {"promo": 3}
        answer["targets"] = [{"target": "instagram"}]
        answer["last_failure"] = {**failure("failed", "token_expired", "promo", 9), "target": "instagram", "payload": {"x": 1}}
        st = analysis.marketing_state(answer)
        self.assertEqual((st["counts"]["draft"], st["counts"]["sent"]), (3, 2))
        self.assertEqual(set(st["counts"]), set(analysis.MARKETING_STATUSES))
        self.assertEqual((st["failure"]["code"], st["failure"]["kind"]), (None, "other"))

    def test_the_command_says_other_for_the_last_send_and_does_not_crash(self):
        expect = {"en": "newer-kind", "ru": "новый вид", "uz": "yangi tur"}
        for lang in LANGUAGES:
            ops, _ = ops_with(summary(minutes_ago_sent=30, sent_kind="promo", enabled=True, used=1, draft=2))
            text = views.view_marketing(ops, lang).text
            self.assertIn(expect[lang], text, lang)
            self.assertNotIn("promo", text)
            ops, _ = ops_with(summary(failure=failure("dead", "unconfirmed", "promo", 20)))    # names no kind: must still render
            self.assertIn("unconfirmed", views.view_marketing(ops, lang).text, lang)

    def test_a_kind_that_is_not_a_clean_code_still_reads_unknown(self):
        self.assertEqual(views.marketing_kind_word("en", "<script>"), t("en", "unknown_word"))
        self.assertEqual(views.marketing_kind_word("en", None), t("en", "unknown_word"))
        self.assertEqual(views.marketing_kind_word("en", "other"), t("en", "mk.other"))

    def test_the_alerts_for_an_unknown_kind_are_raised_not_hidden(self):
        (a,) = detect(summary(failure=failure("dead", "unconfirmed", "promo", minutes_ago=20)))
        self.assertEqual(a.line, f"A newer-kind post ended unconfirmed ({views.marketing_time(NOW - timedelta(minutes=20))}): "
                                 "check the channel, do not resend")
        (a,) = detect(summary(minutes_ago_sent=4, sent_kind="custom"))
        self.assertEqual(a.line, f"A newer-kind post was sent ({views.marketing_time(NOW - timedelta(minutes=4))})")
        (a,) = detect(summary(draft=2, failure=None))
        self.assertEqual(a.key, "marketing:drafts:2")


if __name__ == "__main__":
    unittest.main()
