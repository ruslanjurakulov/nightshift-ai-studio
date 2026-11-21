"""Owner-view parity, read-only: /payments, the payment alert, the server-side
/status and /pending, the bot's own worker_status row, and the removed
/publish /pause /resume. Fakes only: Telegram, Supabase, GitHub and the clock
are in tests/operator_bot_fakes.py; nothing touches the network.

What is pinned here are the things that would hurt: a payment event's free text,
a customer's address or a full provider id reaching the chat; a payment problem
announced twice, or never; a stranger getting any of it; a flood."""

import re
import unittest
from pathlib import Path

from modules.operator_bot import alerts, router, views
from modules.operator_bot.config import OperatorConfig
from modules.operator_bot.i18n import LANGUAGES, t, table
from modules.operator_bot.sources import BOT_WORKER_ID
from modules.operator_bot.store import MemoryAlertStore
from tests.operator_bot_fakes import (
    FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, ts,
    update_callback, update_message,
)
from tests.test_operator_bot_alerts import arm, build as build_engine, heartbeat

ROOT = Path(__file__).resolve().parent.parent
EVT = "evt_01h83xenpcfjyhkzewa4pbkjv5"           # a provider event id: 30 characters, never shown whole
SECRET_DETAIL = "customer jane@example.com paid for Acme Org, txn_01h83abcdef; not credited"


def pay(event_id=EVT, status="rejected", etype="transaction.completed", minutes_ago=30, amount=1250, cur="USD", **extra):
    row = {"event_id": event_id, "event_type": etype, "status": status, "amount_minor": amount, "currency": cur,
           "received_at": ts(minutes_ago)}
    row.update(extra)                  # a real table has more columns; the code must not ask for them
    return row


def held(video="run-0123456789abcdef0123", state="held", minutes_ago=90, channel="default"):
    return {"video_id": video, "channel_id": channel, "publish_state": state, "held_at": ts(minutes_ago),
            "published_at": None}


def ops_with(tables=None):
    t_ = healthy_tables()
    t_.update(tables or {})
    return make_ops(t_, FakeHttp({**site_ok(), **github_ok()}))


def bot_with(tables=None, chat="100", admins=""):
    tg = FakeTelegram()
    ops, sync = ops_with(tables)
    store = MemoryAlertStore(lambda: NOW)
    bot = router.OperatorBot(make_control(tg, chat=chat, admins=admins), None, ops, store, ops.cfg,
                             clock=lambda: NOW.timestamp())
    return bot, tg, sync, store


class SourcesAskForLittleTestCase(unittest.TestCase):
    """Every new read selects ids, statuses and counts: never free text, never a person."""

    FORBIDDEN = ("detail", "email", "org_id", "transaction_id", "adjustment_id", "title", "topic", "hold_detail",
                 "name", "slug", "*")

    def test_no_new_read_selects_free_text_or_a_person(self):
        ops, sync = ops_with()
        ops.payment_events(NOW)
        ops.held_videos()
        ops.videos_published(NOW)
        reads = {name: params["select"] for name, params in sync.reads}
        self.assertEqual(set(reads), {"payment_events", "videos"})
        for name, select in reads.items():
            for column in select.split(","):
                self.assertNotIn(column.strip(), self.FORBIDDEN, f"{name} selects {column}")
        self.assertEqual(reads["payment_events"], "event_id,event_type,status,amount_minor,currency,received_at")

    def test_a_row_with_extra_columns_does_not_leak_them_into_the_view(self):
        ops, _ = ops_with({"payment_events": [pay(detail=SECRET_DETAIL, org_id="org-uuid-1",
                                                  transaction_id="txn_01h83abcdef", email="jane@example.com")]})
        text = views.view_payments(ops).text
        for leak in ("jane", "Acme", "txn_", "org-uuid", "customer"):
            self.assertNotIn(leak, text)


class PaymentsViewTestCase(unittest.TestCase):
    def view(self, rows, lang="en"):
        ops, _ = ops_with({"payment_events": rows})
        return views.view_payments(ops, lang)

    def test_counts_by_outcome_for_24_hours_and_7_days(self):
        rows = [pay("evt_a0000001", "processed", minutes_ago=10),
                pay("evt_a0000002", "processed", minutes_ago=60 * 30),
                pay("evt_a0000003", "rejected", minutes_ago=20),
                pay("evt_a0000004", "failed", minutes_ago=30),
                pay("evt_a0000005", "processed", "adjustment.updated", minutes_ago=40),
                pay("evt_a0000006", "processed", "transaction.completed", minutes_ago=60 * 24 * 9)]   # too old
        text = self.view(rows).text
        self.assertIn("Last 24 hours: paid 1 · rejected 1 · failed 1 · refunds/chargebacks 1", text)
        self.assertIn("Last 7 days: paid 2 · rejected 1 · failed 1 · refunds/chargebacks 1", text)

    def test_ids_are_shortened_and_never_whole(self):
        text = self.view([pay(EVT, "rejected")]).text
        self.assertIn("…" + EVT[-8:], text)
        self.assertNotIn(EVT, text)
        self.assertNotIn(EVT[:20], text)

    def test_the_latest_events_show_status_kind_amount_and_age(self):
        text = self.view([pay("evt_b0000001", "processed", amount=1250, cur="USD", minutes_ago=5),
                          pay("evt_b0000002", "rejected", "adjustment.created", amount=500, cur="EUR", minutes_ago=50),
                          pay("evt_b0000003", "duplicate", minutes_ago=3),
                          pay("evt_b0000004", "ignored", "subscription.updated", minutes_ago=2)]).text
        self.assertIn("payment · processed · 12.50 USD · 5m ago", text)
        self.assertIn("refund or chargeback · rejected · 5.00 EUR · 50m ago", text)
        self.assertNotIn("duplicate ·", text)            # no-ops are not listed
        self.assertNotIn("subscription ·", text)

    def test_money_formats(self):
        self.assertEqual(views.money("en", 1250, "usd"), "12.50 USD")
        self.assertEqual(views.money("en", 5, "EUR"), "0.05 EUR")
        self.assertEqual(views.money("en", 1234567, "USD"), "12,345.67 USD")
        self.assertEqual(views.money("en", 1500, "JPY"), "1,500 JPY")      # no cents in a zero-decimal currency
        for bad in ((None, "USD"), (100, None), ("x", "USD"), (-5, "USD"), (100, "")):
            self.assertEqual(views.money("en", *bad), "unknown")

    def test_no_events_is_said_and_an_unreadable_table_is_unknown_not_zero(self):
        self.assertIn("No payment events in the last 7 days", self.view([]).text)
        ops, _ = make_ops({**healthy_tables()}, FakeHttp(), fail=("payment_events",))
        text = views.view_payments(ops).text
        self.assertIn("unknown (unavailable)", text)
        self.assertNotIn("paid 0", text)

    def test_a_cut_read_says_so(self):
        rows = [pay(f"evt_c{i:07d}", "processed", minutes_ago=5) for i in range(ops_with()[0].PAYMENTS_LIMIT)]
        self.assertIn("list cut at 1000 rows", self.view(rows).text)

    def test_every_language_renders_the_same_facts_in_its_words(self):
        rows = [pay("evt_d0000001", "rejected"), pay("evt_d0000002", "failed", minutes_ago=40),
                pay("evt_d0000003", "processed", "adjustment.updated", minutes_ago=50)]
        seen = set()
        for lang in LANGUAGES:
            reply = self.view(rows, lang)
            self.assertLessEqual(len(reply.text), 4096)
            self.assertIn("…d0000001", reply.text)
            self.assertIn("12.50 USD", reply.text)
            self.assertNotIn("?", re.sub(r"https?://\S+", "", reply.text).replace("payments.", ""), lang)
            self.assertNotRegex(reply.text, r"\b(payments|pk|st)\.[a-z_]+")        # no missing key shown
            seen.add(reply.text)
        self.assertEqual(len(seen), len(LANGUAGES))


class StatusAndPendingTestCase(unittest.TestCase):
    TABLES = {"videos": [held("run-aaaaaaaaaaaaaaaaaaaa", "held", 10), held("run-bbbbbbbbbbbbbbbbbbbb", "awaiting_approval", 20),
                         held("run-cccccccccccccccccccc", "blocked", 30), held("ytid1234567", "repaired_awaiting_review", 40),
                         {"video_id": "uploaded1", "channel_id": "default", "publish_state": "uploaded", "held_at": None,
                          "published_at": ts(60 * 3)}]}

    def test_pending_lists_short_ids_channel_state_and_age_without_titles(self):
        ops, _ = ops_with(self.TABLES)
        ops.sync.tables["videos"][0]["title"] = "A SECRET TITLE"
        text = views.view_pending(ops).text
        self.assertIn("3 waiting: 1 held (auto-publish off), 1 awaiting approval, 1 repaired", text)
        self.assertIn("run-aaaaaaaa", text)
        self.assertNotIn("run-aaaaaaaaaaaaaaaaaaaa", text)        # clipped to 12 characters
        self.assertIn("default · held · 10m", text)
        self.assertIn("Blocked by the gate and kept: 1", text)
        self.assertNotIn("SECRET", text)
        self.assertNotIn("uploaded1", text)

    def test_status_counts_only(self):
        ops, _ = ops_with(self.TABLES)
        text = views.view_status(ops).text
        self.assertIn("Held for review: 3", text)
        self.assertIn("Blocked by the gate and kept: 1", text)
        self.assertIn("Published: 1 in 24 hours, 1 in 7 days", text)

    def test_unreadable_is_unknown_never_zero(self):
        ops, _ = make_ops(healthy_tables(), FakeHttp(), fail=("videos",))
        for text in (views.view_status(ops).text, views.view_pending(ops).text):
            self.assertIn("unknown (unavailable)", text)
            self.assertNotIn("Held for review: 0", text)
            self.assertNotIn("Nothing is held", text)

    def test_they_work_on_the_server_without_a_local_history_file(self):
        bot, tg, sync, store = bot_with(self.TABLES)
        bot.deps = None                  # the server has no chronos.db
        bot.handle_update(update_message("/pending"))
        bot.handle_update(update_message("/status"))
        self.assertIn("3 waiting", tg.texts()[0])
        self.assertIn("Held for review: 3", tg.texts()[1])
        self.assertNotIn("unavailable", " ".join(tg.texts()).lower())

    def test_approvals_and_digest_get_their_held_count_from_supabase(self):
        bot, tg, *_ = bot_with(self.TABLES)
        bot.deps = None
        bot.handle_update(update_message("/approvals"))
        self.assertIn("Held for review (auto-publish off): 3", tg.texts()[0])
        ops, _ = ops_with(self.TABLES)
        self.assertIn("Held for review: 3", alerts.send_digest_reply(ops).text)

    def test_every_language(self):
        ops, _ = ops_with(self.TABLES)
        for lang in LANGUAGES:
            for view in (views.view_status, views.view_pending):
                text = view(ops, lang).text
                self.assertNotRegex(text, r"\b(status|pending|st)\.[a-z_]+")
                self.assertLessEqual(len(text), 4096)


class PaymentAlertTestCase(unittest.TestCase):
    def detect(self, rows, lang="en"):
        _, _, _, ops, _ = build_engine({"payment_events": rows})
        return alerts.detect(ops, 15000, lang)

    def test_each_problem_outcome_is_one_alert_with_its_severity(self):
        found = self.detect([pay("evt_e0000001", "rejected"), pay("evt_e0000002", "failed"),
                             pay("evt_e0000003", "processed", "adjustment.updated"),
                             pay("evt_e0000004", "processed"),                 # a paid purchase is not a problem
                             pay("evt_e0000005", "ignored"), pay("evt_e0000006", "duplicate")])
        self.assertEqual(sorted((a.kind, a.key, a.severity) for a in found), [
            ("payment", "payment:e0000001:rejected", "critical"),
            ("payment", "payment:e0000002:failed", "warn"),
            ("payment", "payment:e0000003:refunds", "warn")])

    def test_the_alert_line_has_a_short_id_amount_and_nothing_else_of_the_row(self):
        rows = [pay(EVT, "rejected", detail=SECRET_DETAIL, org_id="org-1", transaction_id="txn_01h83abcdef")]
        line = self.detect(rows)[0].line
        self.assertEqual(line, f"Payment event …{EVT[-8:]} REJECTED (payment, 12.50 USD): not applied, needs a person")
        self.assertNotIn(EVT, line)
        key = self.detect(rows)[0].key
        self.assertNotIn(EVT, key)
        for leak in ("jane", "Acme", "txn_", "org-1"):
            self.assertNotIn(leak, line + key)

    def test_an_old_event_and_a_row_without_an_id_are_not_alerts(self):
        self.assertEqual(self.detect([pay("evt_f0000001", "rejected", minutes_ago=60 * 25), pay("", "rejected"),
                                      pay(None, "failed")]), [])

    def test_the_keys_do_not_depend_on_the_language(self):
        rows = [pay("evt_g0000001", "rejected")]
        self.assertEqual({self.detect(rows, lang)[0].key for lang in LANGUAGES}, {"payment:g0000001:rejected"})

    def test_a_problem_is_announced_once_and_not_again_next_pass(self):
        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        ops.sync.tables["payment_events"] = [pay("evt_h0000001", "rejected", minutes_ago=2)]
        first = engine.tick()
        self.assertEqual(first.sent, 1)
        self.assertIn("REJECTED", tg.texts()[-1])
        for _ in range(3):
            clock.advance(minutes=5)
            heartbeat(ops, clock)
            self.assertEqual(engine.tick().sent, 0)
        self.assertEqual(len(tg.texts()), 2)        # the arming note and the one alert
        # ... and the same event turning from failed to rejected is a new outcome, so it is said once more
        ops.sync.tables["payment_events"] = [pay("evt_h0000001", "failed", minutes_ago=2)]
        self.assertEqual(engine.tick().sent, 1)

    def test_events_that_already_exist_when_the_bot_is_first_switched_on_are_not_announced(self):
        engine, store, tg, ops, clock = build_engine({"payment_events": [pay("evt_i0000001", "rejected")]})
        rep = engine.tick()
        self.assertTrue(rep.baseline)
        self.assertEqual(len(tg.texts()), 1)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_payment_mute_silences_payment_alerts_but_a_mute_of_all_does_not_hide_a_rejection(self):
        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        alerts.mute(store, "payment", clock())
        ops.sync.tables["payment_events"] = [pay("evt_j0000001", "rejected"), pay("evt_j0000002", "failed")]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (0, 2))
        # a mute is not a flood waiting to happen: once it ends nothing is replayed
        clock.advance(hours=25)
        heartbeat(ops, clock)
        ops.sync.tables["payment_events"] = [pay("evt_j0000001", "rejected", minutes_ago=60 * 22)]
        self.assertEqual(engine.tick().sent, 0)

        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        alerts.mute(store, "all", clock())
        ops.sync.tables["payment_events"] = [pay("evt_k0000001", "rejected"), pay("evt_k0000002", "failed")]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.muted), (1, 1))           # critical comes through; the warning is muted
        self.assertIn("REJECTED", tg.texts()[-1])

    def test_quiet_hours_hold_a_failure_but_not_a_rejection(self):
        cfg = OperatorConfig(app_url="https://app.example.test", github_repo="owner/repo", quiet_hours=(10, 14))
        engine, store, tg, ops, clock = build_engine(cfg=cfg)
        self.assertTrue(cfg.in_quiet_hours(clock()))
        arm(engine)
        ops.sync.tables["payment_events"] = [pay("evt_l0000001", "rejected"), pay("evt_l0000002", "failed")]
        rep = engine.tick()
        self.assertEqual((rep.sent, rep.quiet_held), (1, 1))
        self.assertIn("REJECTED", tg.texts()[-1])
        clock.advance(hours=3)                          # the window is over: the held one goes out, once
        heartbeat(ops, clock)
        self.assertEqual(engine.tick().sent, 1)
        self.assertEqual(engine.tick().sent, 0)

    def test_a_burst_is_merged_into_one_message_and_capped(self):
        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        ops.sync.tables["payment_events"] = [pay(f"evt_m{i:07d}", "rejected", minutes_ago=i % 50 + 1) for i in range(60)]
        rep = engine.tick()
        self.assertEqual(rep.sent, alerts.MAX_CRITICAL_PER_HOUR)
        self.assertEqual(rep.rate_held, 40)
        self.assertEqual(len(tg.texts()), 2)                       # arming note + ONE merged message
        self.assertIn("+10 more", tg.texts()[-1])
        self.assertLess(len(tg.texts()[-1]), 4096)

    def test_the_message_has_mute_and_details_buttons_and_no_link_to_a_page_that_does_not_exist(self):
        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        ops.sync.tables["payment_events"] = [pay("evt_n0000001", "rejected")]
        engine.tick()
        row = tg.sent()[-1]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual([b.get("callback_data") for b in row], ["a:mute:payment", "d:payment"])
        self.assertTrue(all("url" not in b for b in row))

    def test_a_malformed_row_cannot_end_the_pass_or_silence_other_alerts(self):
        engine, store, tg, ops, clock = build_engine()
        arm(engine)
        ops.sync.tables["render_jobs"] = [
            {"id": 7, "channel_id": "default", "kind": "daily", "status": "failed", "attempts": 3, "max_attempts": 3,
             "finished_at": ts(30), "created_at": ts(50)}]
        ops.sync.tables["payment_events"] = [
            pay("evt_q0000001", "rejected", amount=float("inf")), pay("evt_q0000002", "rejected", amount="x", cur=5),
            {"event_id": 12345678901, "event_type": None, "status": "rejected", "received_at": "garbage"}]
        rep = engine.tick()
        self.assertGreaterEqual(rep.sent, 1)
        self.assertIn("Render job #7", " ".join(tg.texts()))

    def test_an_unreadable_payments_table_is_not_an_incident(self):
        _, _, _, ops, _ = build_engine()
        ops.sync.fail.add("payment_events")
        self.assertEqual(alerts.detect(ops, 15000), [])

    def test_the_alert_kind_is_everywhere_the_others_are(self):
        self.assertIn("payment", views.ALERT_KINDS)
        self.assertEqual(views.KIND_COMMAND["payment"], "payments")
        for lang in LANGUAGES:
            self.assertNotEqual(views.kind_label(lang, "payment"), "payment")
        bot, tg, sync, store = bot_with({"payment_events": [pay("evt_o0000001", "rejected")]})
        bot.handle_update(update_callback("d:payment"))
        self.assertIn("Payments", tg.texts()[-1])
        bot.handle_update(update_message("/mute payment"))
        self.assertTrue(store.load(NOW).is_muted("payment", "warn"))


class BotWorkerRowTestCase(unittest.TestCase):
    """The bot's own worker_status row is kind "other", like the e-mail worker's."""

    def row(self, wid, state="running", seconds_ago=5, kind="other"):
        return {"worker_id": wid, "kind": kind, "state": state, "detail": None, "version": None,
                "started_at": ts(600), "updated_at": ts(seconds_ago / 60)}

    def detect(self, rows):
        _, _, _, ops, _ = build_engine({"worker_status": rows})
        return [a for a in alerts.detect(ops, 15000) if a.kind == "worker"]

    def test_a_fresh_bot_does_not_hide_a_silent_email_worker(self):
        found = self.detect([self.row(BOT_WORKER_ID), self.row("email-box", seconds_ago=600),
                             self.row("nightshift-01", kind="pipeline")])
        self.assertEqual([a.key for a in found], ["worker:email-box"])

    def test_a_silent_bot_is_reported_even_when_another_other_worker_is_fine(self):
        found = self.detect([self.row(BOT_WORKER_ID, seconds_ago=600), self.row("email-box"),
                             self.row("nightshift-01", kind="pipeline")])
        self.assertEqual([(a.key, a.severity) for a in found], [("worker:operator-bot", "critical")])

    def test_a_stopped_bot_is_not_an_alarm(self):
        self.assertEqual(self.detect([self.row(BOT_WORKER_ID, state="stopped", seconds_ago=600),
                                      self.row("nightshift-01", kind="pipeline")]), [])

    def test_the_old_replacement_rule_for_other_workers_still_holds(self):
        # an e-mail worker restarted under a new id: the old row is stale, the kind is fresh: not an alarm
        self.assertEqual(self.detect([self.row("email-old", seconds_ago=600), self.row("email-new")]), [])

    def test_health_shows_the_bot_like_any_worker(self):
        ops, _ = ops_with({"worker_status": [self.row(BOT_WORKER_ID)]})
        self.assertIn("operator-bot", views.view_health(ops).text)


class OwnerOnlyTestCase(unittest.TestCase):
    """The allow-list is untouched: a non-owner gets nothing from any new command."""

    COMMANDS = ("/payments", "/status", "/pending", "/publish v1", "/pause x", "/resume x")
    TABLES = {"payment_events": [pay("evt_p0000001", "rejected")], "videos": [held()]}

    def check(self, update_for, chat="100", admins=""):
        for command in self.COMMANDS:
            with self.subTest(command=command):
                bot, tg, sync, store = bot_with(self.TABLES, chat, admins)
                bot.handle_update(update_for(command))
                self.assertEqual(sync.reads, [])
                self.assertEqual(sync.upserts, [])
                self.assertEqual(store.rows, [])
                for text in tg.texts():
                    self.assertEqual(text, router.NOT_AUTHORIZED)
                    self.assertNotIn("evt_", text)
        for data in ("c:payments", "c:status", "c:pending", "d:payment"):
            with self.subTest(button=data):
                bot, tg, sync, store = bot_with(self.TABLES, chat, admins)
                bot.handle_update(update_callback(data, chat=555, user=999))
                self.assertEqual(sync.reads, [])
                self.assertEqual(tg.texts(), [])

    def test_a_stranger_in_the_owners_chat(self):
        self.check(lambda c: update_message(c, chat=100, user=999))

    def test_the_owner_in_another_chat(self):
        self.check(lambda c: update_message(c, chat=555, user=100))

    def test_a_group_member_off_the_allow_list(self):
        self.check(lambda c: update_message(c, chat=-100, user=77, chat_type="group"), chat="-100", admins="42")

    def test_a_forwarded_command_is_refused_even_from_the_owner(self):
        for command in self.COMMANDS:
            bot, tg, sync, store = bot_with(self.TABLES)
            bot.handle_update(update_message(command, forward_origin={"type": "user"}))
            self.assertEqual(sync.reads, [])
            self.assertNotIn("evt_", " ".join(tg.texts()))

    def test_the_owner_is_served(self):
        bot, tg, sync, store = bot_with(self.TABLES)
        bot.handle_update(update_message("/payments"))
        self.assertIn("rejected 1", tg.texts()[0])
        self.assertEqual(sync.upserts, [])               # reading writes nothing


class CopyAndDocsTestCase(unittest.TestCase):
    DOCS = (ROOT / "docs" / "operator-bot.md").read_text(encoding="utf-8")

    def test_help_lists_the_new_commands_in_every_language(self):
        for lang in LANGUAGES:
            text = views.view_help(lang).text
            for name in ("payments", "status", "pending"):
                self.assertIn(f"/{name} —", text)
            self.assertNotRegex(text, r"/(publish|pause|resume)\b")
            self.assertIn(t(lang, "help.viewonly"), text)

    def test_every_new_key_exists_in_every_language_with_the_same_placeholders(self):
        keys = [k for k in table("en") if k.split(".")[0] in ("payments", "pk") or k.startswith(
            ("alert.payment", "status.", "pending.v_", "err.view_only", "help.viewonly", "kind.payment", "cmd.payments"))]
        self.assertGreater(len(keys), 30)
        for lang in LANGUAGES:
            for k in keys:
                self.assertIn(k, table(lang))

    def test_the_botfather_block_matches_the_command_list_in_every_language(self):
        for lang in LANGUAGES:
            m = re.search(rf"<!-- setcommands:{lang} -->\n```text\n(.*?)\n```", self.DOCS, re.S)
            self.assertIsNotNone(m, f"docs/operator-bot.md has no /setcommands block for {lang}")
            lines = m.group(1).split("\n")
            names = [ln.split(" - ")[0] for ln in lines]
            self.assertEqual(names, [n for n, _ in views.COMMANDS] + ["channels", "menu", "help", "language", "mute", "unmute"])
            for (name, key), line in zip(views.COMMANDS, lines):
                self.assertEqual(line.split(" - ", 1)[1], t(lang, key))
                self.assertLessEqual(len(line.split(" - ", 1)[1]), 256)
                self.assertNotIn("publish", line.split(" - ")[0])
            for line in lines:
                self.assertRegex(line, r"^[a-z]{2,32} - .{3,256}$")

    def test_the_docs_say_the_bot_is_view_only_and_name_the_new_things(self):
        for needle in ("/payments", "payment_events", "operator-bot", "worker_status", "view-only", "payment"):
            self.assertIn(needle, self.DOCS)
        self.assertNotRegex(self.DOCS, r"requests only, through the original intent path")


if __name__ == "__main__":
    unittest.main()
