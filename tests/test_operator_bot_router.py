"""The operator bot's authorization matrix, run against EVERY command and EVERY
button: an unknown sender, a group member off the allow-list, another chat, a
channel post, a forwarded or edited message, a bot, a callback from elsewhere —
each is refused silently or with a neutral line, and none of them reaches data,
the alert memory, or an intent. Then the authorized behaviour: replies,
keyboards, buttons, mute, rate limit, no raw exception text."""

import unittest
from unittest.mock import patch

from modules.operator_bot import router, views
from modules.operator_bot.store import MemoryAlertStore
from tests.operator_bot_fakes import (
    FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok,
    update_callback, update_message,
)

READ = [c for c in views.READ_COMMANDS if c != "alerts"]
EVERY_COMMAND = (list(views.READ_COMMANDS) + ["status", "channels", "pending", "help", "menu", "start",
                                              "mute run", "unmute all", "publish v1", "pause finance",
                                              "resume finance"])
EVERY_BUTTON = (["c:" + c for c in list(views.READ_COMMANDS) + ["status", "channels", "pending", "menu", "help"]]
                + ["a:mute:run", "a:unmute:all", "a:mute:all"] + ["d:" + k for k in views.ALERT_KINDS])


class Deps:
    def __init__(self):
        self.calls = []

    def status_summary(self):
        self.calls.append("status")
        return "Nightshift: 3 video(s) in the library."

    def list_channels(self):
        self.calls.append("channels")
        return [{"channel_id": "default", "status": "ACTIVE", "auto_publish": True}]

    def pending_review(self):
        self.calls.append("pending")
        return [{"video_id": "v1", "title": "T"}]


def build(chat="100", admins="", tables=None, http=None, cfg=None, clock=None):
    tg = FakeTelegram()
    control = make_control(tg, chat=chat, admins=admins)
    t = healthy_tables()
    t.update(tables or {})
    ops, sync = make_ops(t, FakeHttp({**site_ok(), **github_ok(), **(http or {})}), cfg)
    store = MemoryAlertStore(lambda: NOW)
    deps = Deps()
    bot = router.OperatorBot(control, deps, ops, store, ops.cfg, clock=clock or (lambda: NOW.timestamp()))
    return bot, tg, sync, store, deps


def untouched(case, sync, store, deps):
    case.assertEqual(sync.reads, [], "data was read for a refused sender")
    case.assertEqual(sync.upserts, [], "something was written for a refused sender")
    case.assertEqual(store.rows, [], "alert memory was written for a refused sender")
    case.assertEqual(deps.calls, [], "legacy data was read for a refused sender")


class RefusedSendersTestCase(unittest.TestCase):
    """Every refused kind of update, against every command and every button."""

    def check_messages(self, make_update, chat="100", admins="", allow_neutral_reply=True):
        for command in EVERY_COMMAND:
            with self.subTest(command=command):
                bot, tg, sync, store, deps = build(chat=chat, admins=admins)
                with patch("modules.event_log.emit") as emit:
                    bot.handle_update(make_update("/" + command))
                emit.assert_not_called()
                untouched(self, sync, store, deps)
                for text in tg.texts():
                    self.assertEqual(text, router.NOT_AUTHORIZED)

    def check_callbacks(self, make_update, chat="100", admins=""):
        for data in EVERY_BUTTON:
            with self.subTest(button=data):
                bot, tg, sync, store, deps = build(chat=chat, admins=admins)
                bot.handle_update(make_update(data))
                untouched(self, sync, store, deps)
                self.assertEqual(tg.texts(), [], "a refused button press produced a message")

    def test_unknown_sender_in_the_admin_private_chat(self):
        self.check_messages(lambda t: update_message(t, chat=100, user=999))

    def test_group_member_off_the_allow_list(self):
        self.check_messages(lambda t: update_message(t, chat=-100, user=77, chat_type="group"),
                            chat="-100", admins="42")

    def test_group_without_an_allow_list_authorises_nobody(self):
        self.check_messages(lambda t: update_message(t, chat=-100, user=42, chat_type="group"), chat="-100")

    def test_allow_listed_user_in_another_chat(self):
        self.check_messages(lambda t: update_message(t, chat=555, user=100))

    def test_message_with_no_sender(self):
        def no_sender(t):
            u = update_message(t)
            del u["message"]["from"]
            return u
        self.check_messages(no_sender)

    def test_message_from_a_bot(self):
        def from_bot(t):
            u = update_message(t)
            u["message"]["from"]["is_bot"] = True
            return u
        self.check_messages(from_bot)

    def test_anonymous_group_admin_and_channel_senders(self):
        def anon(t):
            u = update_message(t, chat=-100, user=42, chat_type="supergroup")
            u["message"]["sender_chat"] = {"id": -100, "type": "supergroup"}
            return u
        self.check_messages(anon, chat="-100", admins="42")

    def test_channel_post(self):
        self.check_messages(lambda t: {"update_id": 1, "channel_post": {
            "text": t, "chat": {"id": 100, "type": "channel"}, "from": {"id": 100}}})

    def test_edited_message_from_the_admin(self):
        def edited(t):
            m = update_message(t)["message"]
            return {"update_id": 1, "edited_message": m}
        self.check_messages(edited)

    def test_message_via_a_bot(self):
        self.check_messages(lambda t: update_message(t, via_bot={"id": 5, "is_bot": True}))

    def test_other_update_kinds_and_garbage(self):
        for upd in ({"update_id": 1, "my_chat_member": {}}, {"update_id": 2, "inline_query": {"id": "x"}},
                    {"update_id": 3}, {}, "text", None, 5, []):
            bot, tg, sync, store, deps = build()
            bot.handle_update(upd)
            untouched(self, sync, store, deps)
            self.assertEqual(tg.calls, [])

    def test_a_forwarded_message_from_the_admin_is_refused_even_though_the_sender_is_allowed(self):
        for key, value in (("forward_origin", {"type": "user"}), ("forward_from", {"id": 5}),
                           ("forward_from_chat", {"id": -1}), ("forward_date", 1), ("forward_sender_name", "x"),
                           ("forward_signature", "s")):
            for command in ("/health", "/publish v1", "/mute all", "/status"):
                with self.subTest(key=key, command=command):
                    bot, tg, sync, store, deps = build()
                    with patch("modules.event_log.emit") as emit:
                        bot.handle_update(update_message(command, **{key: value}))
                    emit.assert_not_called()
                    untouched(self, sync, store, deps)
                    self.assertEqual(len(tg.texts()), 1)
                    self.assertIn("Forwarded messages are not accepted", tg.texts()[0])

    def test_callback_from_a_non_allow_listed_user(self):
        self.check_callbacks(lambda d: update_callback(d, chat=100, user=999))

    def test_callback_from_another_chat(self):
        self.check_callbacks(lambda d: update_callback(d, chat=555, user=100))

    def test_callback_from_a_group_member_off_the_allow_list(self):
        self.check_callbacks(lambda d: update_callback(d, chat=-100, user=77), chat="-100", admins="42")

    def test_callback_with_no_message_attached(self):
        self.check_callbacks(lambda d: update_callback(d, with_message=False))

    def test_callback_from_a_bot(self):
        def from_bot(d):
            u = update_callback(d)
            u["callback_query"]["from"]["is_bot"] = True
            return u
        self.check_callbacks(from_bot)

    def test_a_refused_button_is_still_answered_with_a_neutral_toast(self):
        bot, tg, *_ = build()
        bot.handle_update(update_callback("c:health", chat=555, user=100))
        self.assertEqual(len(tg.answers()), 1)
        self.assertEqual(tg.answers()[0]["text"], "Not authorized")

    def test_strangers_get_one_neutral_reply_per_window_and_nothing_for_plain_text(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("hello there", chat=999))
        self.assertEqual(tg.calls, [])
        for _ in range(5):
            bot.handle_update(update_message("/status", chat=999))
        self.assertEqual(tg.texts(), [router.NOT_AUTHORIZED])


class AuthorizedTestCase(unittest.TestCase):
    def test_every_read_command_replies_with_html_and_a_keyboard(self):
        for command in READ + ["menu", "help"]:
            with self.subTest(command=command):
                bot, tg, *_ = build()
                bot.handle_update(update_message("/" + command))
                self.assertEqual(len(tg.sent()), 1)
                payload = tg.sent()[0]
                self.assertEqual(payload["chat_id"], "100")
                self.assertEqual(payload["parse_mode"], "HTML")
                self.assertIn("inline_keyboard", payload["reply_markup"])

    def test_every_button_runs_its_command_and_stops_the_spinner(self):
        for data in EVERY_BUTTON:
            if data.startswith("a:") or data.startswith("c:refresh"):
                continue
            with self.subTest(button=data):
                bot, tg, *_ = build()
                bot.handle_update(update_callback(data))
                self.assertEqual(len(tg.answers()), 1)
                self.assertEqual(len(tg.sent()), 1)

    def test_bot_name_suffix_and_case_are_handled(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/Health@NightshiftAiStudio_bot"))
        self.assertIn("Health", tg.texts()[0])

    def test_a_command_addressed_to_another_bot_is_ignored(self):
        for command in ("/health@OtherBot", "/publish@OtherBot v1", "/mute@OtherBot all", "/status@someone_else"):
            bot, tg, sync, store, deps = build()
            with patch("modules.event_log.emit") as emit:
                bot.handle_update(update_message(command))
            emit.assert_not_called()
            self.assertEqual(tg.sent(), [], command)
            untouched(self, sync, store, deps)

    def test_a_command_with_this_bots_own_name_is_served_and_the_name_is_asked_once(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/health@NightshiftAiStudio_bot"))
        bot.handle_update(update_message("/queue@nightshiftaistudio_bot"))
        self.assertEqual(len(tg.sent()), 2)
        self.assertEqual([m for m, _ in tg.calls].count("getMe"), 1)

    def test_when_the_bots_name_cannot_be_learned_a_suffixed_command_is_ignored(self):
        bot, tg, *_ = build()
        tg.status = 500
        bot.handle_update(update_message("/health@NightshiftAiStudio_bot"))
        self.assertEqual(tg.sent(), [])
        bot.handle_update(update_message("/help"))              # a plain command still needs no name
        self.assertEqual(len(tg.sent()), 1)

    def test_legacy_commands_still_answer_in_plain_text(self):
        bot, tg, _, _, deps = build()
        bot.handle_update(update_message("/status"))
        self.assertEqual(tg.sent()[0]["text"], "Nightshift: 3 video(s) in the library.")
        self.assertNotIn("parse_mode", tg.sent()[0])
        self.assertEqual(deps.calls, ["status"])

    def test_plain_text_from_the_admin_gets_the_hint(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("hello"))
        self.assertIn("/help", tg.texts()[0])

    def test_unknown_command(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/frobnicate<b>"))
        self.assertIn("Unknown command", tg.texts()[0])
        self.assertNotIn("<b>", tg.texts()[0])

    def test_group_chat_admin_on_the_allow_list_is_served(self):
        bot, tg, *_ = build(chat="-100", admins="42")
        bot.handle_update(update_message("/health", chat=-100, user=42, chat_type="supergroup"))
        self.assertEqual(len(tg.sent()), 1)

    def test_an_unknown_button_payload_does_no_work(self):
        for data in ("", "x", "c:", "c:health;drop", "a:mute:", "c:" + "a" * 80, "c:../etc", "d:unknown_kind_zzzzzzzz"):
            with self.subTest(data=data):
                bot, tg, sync, store, deps = build()
                bot.handle_update(update_callback(data))
                untouched(self, sync, store, deps)
                self.assertEqual(tg.sent(), [])

    def test_long_output_is_split_under_the_limit(self):
        many = [{"id": i, "channel_id": "c" * 60, "kind": "daily", "status": "failed", "attempts": 1,
                 "max_attempts": 3, "finished_at": "2026-10-14T11:30:00Z", "created_at": "2026-10-14T11:00:00Z"}
                for i in range(400)]
        bot, tg, *_ = build(tables={"render_jobs": many})
        bot.handle_update(update_message("/errors"))
        for payload in tg.sent():
            self.assertLessEqual(len(payload["text"]), 4096)

    def test_outgoing_text_is_scrubbed_of_secret_shapes(self):
        bot, tg, *_ = build()
        bot.control.send(100, "token sk-abcdefghijklmnopqrstuvwxyz mail a@b.co", parse_mode="HTML")
        text = tg.texts()[0]
        self.assertNotIn("sk-abcdef", text)
        self.assertNotIn("a@b.co", text)

    def test_a_failing_source_never_puts_exception_text_in_the_chat(self):
        bot, tg, sync, *_ = build()
        boom = RuntimeError("password=hunter2 https://api.telegram.org/bot123456:ABCDEF_secret/x")
        with patch.object(views, "view_health", side_effect=boom):
            bot.handle_update(update_message("/health"))
        self.assertEqual(tg.texts(), [router.FAILED_REPLY])
        bot, tg, *_ = build()
        with patch.object(views, "view_queue", side_effect=boom):
            bot.handle_update(update_callback("c:queue"))
        self.assertNotIn("hunter2", repr(tg.calls))
        self.assertEqual(tg.answers()[-1].get("text", "Could not do that right now") != "", True)

    def test_a_table_that_is_missing_reads_as_not_set_up_not_as_zero(self):
        bot, tg, *_ = build()
        bot.ops.sync.fail = {"render_jobs"}
        bot.handle_update(update_message("/queue"))
        self.assertIn("Render jobs: unknown (unavailable)", tg.texts()[0])

    def test_no_data_source_says_so(self):
        bot, tg, *_ = build()
        bot.ops = None
        bot.handle_update(update_message("/health"))
        self.assertEqual(tg.texts(), ["No data source available."])


class RateLimitTestCase(unittest.TestCase):
    def test_a_sender_is_limited_per_minute_with_one_notice(self):
        t = [1000.0]
        bot, tg, *_ = build(clock=lambda: t[0])
        for _ in range(router.RATE_MAX + 5):
            bot.handle_update(update_message("/help"))
        self.assertEqual(len(tg.sent()), router.RATE_MAX + 1)          # the replies + one "Slow down"
        self.assertEqual(tg.texts()[-1], router.SLOW_DOWN)
        t[0] += router.RATE_WINDOW_S + 1
        bot.handle_update(update_message("/help"))
        self.assertNotEqual(tg.texts()[-1], router.SLOW_DOWN)

    def test_the_limit_covers_button_presses_too(self):
        t = [1000.0]
        bot, tg, *_ = build(clock=lambda: t[0])
        for i in range(router.RATE_MAX + 4):
            bot.handle_update(update_callback("c:help", cb_id=f"cb{i}"))
        self.assertEqual(len(tg.answers()), router.RATE_MAX + 4)        # every press is answered
        self.assertEqual(len(tg.sent()), router.RATE_MAX)

    def test_limits_are_per_sender(self):
        t = [1000.0]
        bot, tg, *_ = build(chat="-100", admins="42,43", clock=lambda: t[0])
        for _ in range(router.RATE_MAX + 3):
            bot.handle_update(update_message("/help", chat=-100, user=42, chat_type="group"))
        n = len(tg.sent())
        bot.handle_update(update_message("/help", chat=-100, user=43, chat_type="group"))
        self.assertEqual(len(tg.sent()), n + 1)

    def test_limiter_forgets_idle_keys(self):
        t = [0.0]
        lim = router.SlidingLimiter(1, 10, lambda: t[0])
        lim.allow("a")
        t[0] = 100
        lim.prune()
        self.assertEqual(lim._hits, {})


class MuteTestCase(unittest.TestCase):
    def test_typed_mute_and_unmute(self):
        bot, tg, sync, store, _ = build()
        bot.handle_update(update_message("/mute run"))
        self.assertIn("Muted", tg.texts()[-1])
        self.assertEqual([r["kind"] for r in store.rows], ["operator.mute"])
        bot.handle_update(update_message("/unmute run"))
        self.assertIn("Unmuted", tg.texts()[-1])

    def test_mute_without_a_kind_shows_usage_and_writes_nothing(self):
        bot, tg, sync, store, _ = build()
        bot.handle_update(update_message("/mute"))
        self.assertIn("Usage", tg.texts()[0])
        self.assertEqual(store.rows, [])

    def test_mute_all_says_critical_alerts_still_come_through(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/mute all"))
        self.assertIn("Critical alerts still come through", tg.texts()[-1])
        bot.handle_update(update_message("/mute run"))
        self.assertNotIn("Critical alerts still come through", tg.texts()[-1])

    def test_mute_button_writes_a_24_hour_mute_and_offers_unmute(self):
        bot, tg, sync, store, _ = build()
        bot.handle_update(update_callback("a:mute:worker"))
        self.assertEqual(store.rows[0]["title"], "worker")
        self.assertEqual(store.rows[0]["body"], "2026-10-15T12:00:00Z")
        self.assertEqual(tg.answers()[0]["text"], "Muted")
        data = [b["callback_data"] for row in tg.sent()[0]["reply_markup"]["inline_keyboard"] for b in row]
        self.assertIn("a:unmute:worker", data)

    def test_an_unknown_kind_is_refused(self):
        bot, tg, sync, store, _ = build()
        bot.handle_update(update_message("/mute bogus"))
        self.assertIn("Could not mute", tg.texts()[0])
        self.assertEqual(store.rows, [])

    def test_alerts_view_shows_mutes(self):
        bot, tg, *_ = build()
        bot.handle_update(update_message("/mute all"))
        bot.handle_update(update_message("/alerts"))
        self.assertIn("Muted: all until", tg.texts()[-1])

    def test_details_button_opens_the_command_for_that_alert(self):
        for kind, command in views.KIND_COMMAND.items():
            bot, tg, *_ = build()
            bot.handle_update(update_callback(f"d:{kind}"))
            self.assertEqual(len(tg.sent()), 1, kind)


class ActionIntentsTestCase(unittest.TestCase):
    """/publish /pause /resume are unchanged: an INTENT through the old path."""

    def test_intent_is_recorded_not_executed(self):
        bot, tg, *_ = build()
        with patch("modules.event_log.emit") as emit:
            bot.handle_update(update_message("/pause finance"))
        emit.assert_called_once()
        self.assertEqual(emit.call_args.kwargs["metadata"], {"action": "pause", "target": "finance"})
        self.assertIn("Requested: pause finance", tg.texts()[0])

    def test_publish_reply_keeps_the_gate_sentence(self):
        bot, tg, *_ = build()
        with patch("modules.event_log.emit"):
            bot.handle_update(update_message("/publish v1"))
        self.assertIn("publish gate still decides", tg.texts()[0])

    def test_not_durable_and_too_old_are_refused_without_an_event(self):
        bot, tg, *_ = build()
        with patch("modules.event_log.emit") as emit:
            bot.handle_update(update_message("/publish v1"), durable=False)
            bot.handle_update(update_message("/publish v1", date=int(NOW.timestamp()) - 7 * 3600))
        emit.assert_not_called()
        self.assertIn("could not be recorded durably", tg.texts()[0])
        self.assertIn("more than 6 hours old", tg.texts()[1])

    def test_there_is_no_button_or_command_that_publishes_spends_or_approves(self):
        self.assertTrue(all(not c.startswith(("publish", "approve", "pay", "buy", "delete", "grant", "price"))
                            for c, _ in views.COMMANDS))
        for data in EVERY_BUTTON:
            # "spend" is a read view (what was spent), not an action that spends.
            self.assertNotRegex(data, r"publish|approve|pay|delete|grant|price|role")
            self.assertRegex(data, r"^(c:[a-z]+|a:(mute|unmute):[a-z]+|d:[a-z]+)$")
        bot, tg, sync, store, deps = build()
        for data in ("c:publish", "c:approve", "a:approve:run", "c:delete", "a:publish:all"):
            bot.handle_update(update_callback(data))
        with patch("modules.event_log.emit") as emit:
            for command in ("/approve p1", "/delete v1", "/grant x", "/setprice 1", "/buy"):
                bot.handle_update(update_message(command))
        emit.assert_not_called()
        self.assertEqual(sync.upserts, [])
        self.assertEqual(store.rows, [])

    def test_a_plain_stranger_cannot_use_the_intent_path(self):
        bot, tg, *_ = build()
        with patch("modules.event_log.emit") as emit:
            bot.handle_update(update_message("/publish v1", chat=999))
        emit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
