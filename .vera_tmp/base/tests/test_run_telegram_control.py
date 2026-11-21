"""Telegram control-panel transport (tools/run_telegram_control.py).

The transport's job: pull updates, route each through the pure core, send the
reply back to whoever asked, and advance the offset. No network in these tests
— the requests session is a fake; the pure routing lives in
modules/telegram_control.py and is tested there."""

import json
import unittest
from unittest.mock import MagicMock, patch

from modules.telegram_control import TelegramControl
from tools import run_telegram_control as mod


def _updates_response(updates):
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"ok": True, "result": updates}
    return resp


NOW = 1_790_000_000


def _msg(update_id, chat_id, text, from_id=None, date=NOW - 60):
    """A message as Telegram sends it; in a private chat the sender's id is
    the chat's id."""
    return {"update_id": update_id, "message": {
        "text": text, "chat": {"id": chat_id}, "from": {"id": chat_id if from_id is None else from_id},
        "date": date}}


class _Claims:
    """The durable claim store (Supabase telegram_updates), in memory."""

    enabled = True

    def __init__(self):
        self.seen = set()
        self.fail = False

    def insert_new(self, table, rows, on_conflict):
        assert table == "telegram_updates" and on_conflict == "update_id"
        if self.fail:
            return None
        new = [r for r in rows if r["update_id"] not in self.seen]
        self.seen |= {r["update_id"] for r in new}
        return new


class _PollBase(unittest.TestCase):
    def setUp(self):
        # admin chat 100; token present so the transport is live
        self.control = TelegramControl(token="tok", chat_id="100", admin_user_ids="")
        self.control.send = MagicMock(return_value=True)   # capture replies, no network
        self.deps = MagicMock()
        self.deps.status_summary.return_value = "all good"
        self.claims = _Claims()

    def poll(self, session, offset=0):
        return mod.poll_once(self.control, self.deps, session=session, offset=offset, store=self.claims, now=NOW)


class PollOnceTestCase(_PollBase):
    def test_no_token_is_a_noop(self):
        control = TelegramControl(token="", chat_id="")
        session = MagicMock()
        self.assertEqual(mod.poll_once(control, self.deps, session=session, offset=5), 5)
        session.get.assert_not_called()

    def test_routes_query_and_replies_to_sender(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(7, 100, "/status")])
        new_offset = self.poll(session)
        self.assertEqual(new_offset, 8)   # max update_id + 1
        self.control.send.assert_called_once()
        chat_arg, text_arg = self.control.send.call_args.args
        self.assertEqual(chat_arg, 100)
        self.assertIn("all good", text_arg)

    def test_unauthorized_chat_gets_refusal_not_data(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(1, 999, "/status")])  # not admin
        self.poll(session)
        _, text_arg = self.control.send.call_args.args
        self.assertIn("Not authorized", text_arg)
        self.deps.status_summary.assert_not_called()

    def test_a_removed_action_command_emits_nothing_and_says_view_only(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(3, 100, "/pause finance")])
        with patch("modules.event_log.emit") as emit:
            self.poll(session)
        emit.assert_not_called()
        self.assertIn("view-only", self.control.send.call_args.args[1])

    def test_getupdates_failure_keeps_offset(self):
        session = MagicMock()
        session.get.side_effect = RuntimeError("network down")
        self.assertEqual(self.poll(session, offset=42), 42)
        self.control.send.assert_not_called()

    def test_non_text_update_is_skipped(self):
        session = MagicMock()
        session.get.return_value = _updates_response([{"update_id": 9, "message": {"chat": {"id": 100}}}])
        new_offset = self.poll(session)
        self.assertEqual(new_offset, 10)   # offset still advances past it
        self.control.send.assert_not_called()


class ReplayTestCase(_PollBase):
    """P8: the offset lives in an evictable cache, so Telegram can deliver the
    same updates again. A replay must not repeat an action or a reply."""

    def test_a_replayed_batch_is_skipped(self):
        batch = [_msg(3, 100, "/pause finance"), _msg(4, 100, "/status")]
        session = MagicMock()
        session.get.return_value = _updates_response(batch)
        self.assertEqual(self.poll(session), 5)
        # The cache was evicted: the offset is back to 0 and Telegram
        # hands the same updates over again.
        self.assertEqual(self.poll(session, offset=0), 5)
        self.assertEqual(self.control.send.call_count, 2)

    def test_no_durable_store_answers_queries_and_records_no_action(self):
        self.claims.fail = True
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(5, 100, "/publish v1"), _msg(6, 100, "/status")])
        with patch("modules.event_log.emit") as emit:
            self.poll(session)
        emit.assert_not_called()
        replies = [c.args[1] for c in self.control.send.call_args_list]
        self.assertIn("view-only", replies[0])
        self.assertIn("all good", replies[1])

    def test_an_old_action_is_not_requested_either(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(7, 100, "/publish v1", date=NOW - 7 * 3600)])
        with patch("modules.event_log.emit") as emit:
            self.poll(session)
        emit.assert_not_called()
        self.assertIn("view-only", self.control.send.call_args.args[1])

    def test_an_edited_command_is_ignored(self):
        edited = {"update_id": 8, "edited_message": {"text": "/publish v1", "chat": {"id": 100},
                                                     "from": {"id": 100}, "date": NOW - 60}}
        session = MagicMock()
        session.get.return_value = _updates_response([edited])
        with patch("modules.event_log.emit") as emit:
            self.assertEqual(self.poll(session), 9)
        emit.assert_not_called()
        self.control.send.assert_not_called()

    def test_group_member_off_the_allow_list_cannot_act(self):
        self.control = TelegramControl(token="tok", chat_id="-100", admin_user_ids="42")
        self.control.send = MagicMock(return_value=True)
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(9, -100, "/pause finance", from_id=77)])
        with patch("modules.event_log.emit") as emit:
            self.poll(session)
        emit.assert_not_called()
        self.assertIn("Not authorized", self.control.send.call_args.args[1])


class OperatorBotThroughPollTestCase(_PollBase):
    """The poller hands every update to the operator router: buttons, the new
    views, and the authorization matrix hold on this transport as well."""

    def test_only_message_and_callback_updates_are_requested(self):
        session = MagicMock()
        session.get.return_value = _updates_response([])
        self.poll(session)
        params = session.get.call_args.kwargs["params"]
        self.assertEqual(json.loads(params["allowed_updates"]), ["message", "callback_query"])

    def test_a_button_press_is_answered_and_claimed_once(self):
        self.control.answer_callback = MagicMock(return_value=True)
        cb = {"update_id": 12, "callback_query": {"id": "c1", "from": {"id": 100}, "data": "c:help",
                                                  "message": {"chat": {"id": 100}}}}
        session = MagicMock()
        session.get.return_value = _updates_response([cb])
        self.assertEqual(self.poll(session), 13)
        self.assertEqual(self.poll(session), 13)           # replayed: skipped
        self.control.answer_callback.assert_called_once()
        self.assertEqual(self.control.send.call_count, 1)

    def test_a_button_from_another_chat_does_nothing(self):
        self.control.answer_callback = MagicMock(return_value=True)
        cb = {"update_id": 13, "callback_query": {"id": "c2", "from": {"id": 100}, "data": "c:help",
                                                  "message": {"chat": {"id": 555}}}}
        session = MagicMock()
        session.get.return_value = _updates_response([cb])
        self.poll(session)
        self.control.send.assert_not_called()
        self.assertEqual(self.control.answer_callback.call_args.args[1], "Not authorized")

    def test_a_strangers_update_is_never_claimed_so_it_costs_no_database_write(self):
        session = MagicMock()
        session.get.return_value = _updates_response([
            _msg(20, 999, "/status"), _msg(21, 100, "/menu"),
            {"update_id": 22, "channel_post": {"text": "/status", "chat": {"id": 100, "type": "channel"}}}])
        self.assertEqual(self.poll(session), 23)
        self.assertEqual(self.claims.seen, {21})            # only the allow-listed sender's update

    def test_a_poll_with_nothing_from_the_admin_never_touches_the_store(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(30, 999, "/status")])
        self.claims.fail = True                             # would be refused if it were asked
        with patch.object(mod, "_default_store", side_effect=AssertionError("store used")):
            mod.poll_once(self.control, self.deps, session=session, offset=0, store=None, now=NOW)
        self.assertIn("Not authorized", self.control.send.call_args.args[1])

    def test_a_new_command_replies_with_html_and_buttons(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(14, 100, "/menu")])
        self.poll(session)
        self.assertEqual(self.control.send.call_args.kwargs["parse_mode"], "HTML")
        self.assertIn("inline_keyboard", self.control.send.call_args.kwargs["reply_markup"])


class LongPollLoopTestCase(unittest.TestCase):
    """--duration: keep polling until the deadline, persist the offset, and do not spin on errors."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = tempfile.TemporaryDirectory()
        self.patch = patch.object(mod, "_OFFSET_FILE", Path(self.tmp.name) / "offset.json")
        self.patch.start()
        self.control = TelegramControl(token="tok", chat_id="100", admin_user_ids="")

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def clock(self):
        t = {"now": 0.0}
        return t, (lambda: t["now"]), (lambda s: t.__setitem__("now", t["now"] + s))

    def test_a_single_batch_by_default(self):
        t, mono, sleep = self.clock()
        session = MagicMock()
        session.get.return_value = _updates_response([])
        mod.run(self.control, MagicMock(), _Claims(), duration=0, session=session, sleep=sleep, monotonic=mono)
        self.assertEqual(session.get.call_count, 1)
        self.assertEqual(session.get.call_args.kwargs["params"]["timeout"], 0)

    def test_polls_until_the_deadline_with_long_polls_and_saves_the_offset(self):
        t, mono, sleep = self.clock()
        bot = MagicMock()
        batches = iter([[_msg(5, 100, "/help")], [], [_msg(9, 100, "/help")], []])

        def get(url, params=None, timeout=None):
            t["now"] += 25                       # a long poll that waited
            return _updates_response(next(batches, []))
        session = MagicMock()
        session.get.side_effect = get
        offset = mod.run(self.control, bot, _Claims(), duration=70, session=session, sleep=sleep, monotonic=mono)
        self.assertEqual(offset, 10)
        self.assertEqual(mod._load_offset(), 10)
        timeouts = [c.kwargs["params"]["timeout"] for c in session.get.call_args_list]
        self.assertTrue(all(0 <= x <= mod.LONG_POLL_S for x in timeouts))
        self.assertGreaterEqual(len(timeouts), 3)
        self.assertEqual(bot.handle_update.call_count, 2)

    def test_an_instant_error_does_not_spin(self):
        t, mono, sleep = self.clock()
        session = MagicMock()
        session.get.side_effect = RuntimeError("network down")
        calls = []
        mod.run(self.control, MagicMock(), _Claims(), duration=30, session=session,
                sleep=lambda s: (calls.append(s), sleep(s)), monotonic=mono)
        self.assertLess(session.get.call_count, 30)
        self.assertTrue(calls and all(c >= 1 for c in calls))

    def test_a_webhook_409_or_a_rejected_token_401_stops_the_run_at_once(self):
        import requests
        for status in (409, 401):
            t, mono, sleep = self.clock()
            session = MagicMock()
            err = requests.HTTPError("boom", response=MagicMock(status_code=status))
            session.get.return_value.raise_for_status.side_effect = err
            slept = []
            with self.assertLogs("run_telegram_control", level="ERROR") as logs:
                mod.run(self.control, MagicMock(), _Claims(), duration=270, session=session,
                        sleep=lambda s: slept.append(s), monotonic=mono)
            self.assertEqual(session.get.call_count, 1, status)       # one call, not ~135
            self.assertEqual(slept, [])
            self.assertIn("polling stopped", logs.output[0])
        self.assertIn("webhook", mod.FATAL_POLL_STATUS[409])

    def test_other_errors_still_retry_and_poll_once_never_raises_by_default(self):
        import requests
        session = MagicMock()
        session.get.return_value.raise_for_status.side_effect = requests.HTTPError(
            "boom", response=MagicMock(status_code=409))
        control = TelegramControl(token="tok", chat_id="100")
        self.assertEqual(mod.poll_once(control, MagicMock(), session=session, offset=7), 7)   # no raise_fatal
        with self.assertRaises(mod.PollFatal):
            mod.poll_once(control, MagicMock(), session=session, offset=7, raise_fatal=True)
        session.get.return_value.raise_for_status.side_effect = requests.HTTPError(
            "boom", response=MagicMock(status_code=502))
        self.assertEqual(mod.poll_once(control, MagicMock(), session=session, offset=7, raise_fatal=True), 7)

    def test_main_is_off_without_a_token(self):
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}):
            self.assertEqual(mod.main(["--duration", "5"]), 0)


class SendTestCase(unittest.TestCase):
    def test_send_no_token_is_false(self):
        self.assertFalse(TelegramControl(token="", chat_id="").send(100, "hi"))

    def test_send_blank_chat_is_false(self):
        self.assertFalse(TelegramControl(token="tok", chat_id="100").send("", "hi"))



class InsertNewTestCase(unittest.TestCase):
    """SupabaseSync.insert_new — the claim primitive: only NEW rows come back,
    and an unknown outcome is None, never 'all new'."""

    def test_returns_only_inserted_rows_and_asks_postgrest_to_ignore_duplicates(self):
        from modules.supabase_sync import SupabaseSync
        resp = MagicMock(status_code=201)
        resp.json.return_value = [{"update_id": 2}]
        with patch("modules.supabase_sync.requests.post", return_value=resp) as post:
            out = SupabaseSync(url="https://x.supabase.co", service_key="k").insert_new(
                "telegram_updates", [{"update_id": 1}, {"update_id": 2}], on_conflict="update_id")
        self.assertEqual(out, [{"update_id": 2}])
        self.assertIn("ignore-duplicates", post.call_args.kwargs["headers"]["Prefer"])
        self.assertIn("return=representation", post.call_args.kwargs["headers"]["Prefer"])
        self.assertEqual(post.call_args.kwargs["params"], {"on_conflict": "update_id"})

    def test_failure_or_disabled_is_none(self):
        from modules.supabase_sync import SupabaseSync
        with patch("modules.supabase_sync.requests.post", return_value=MagicMock(status_code=404)):
            self.assertIsNone(SupabaseSync(url="https://x.supabase.co", service_key="k").insert_new(
                "telegram_updates", [{"update_id": 1}], on_conflict="update_id"))
        with patch("modules.supabase_sync.requests.post", side_effect=RuntimeError("down")):
            self.assertIsNone(SupabaseSync(url="https://x.supabase.co", service_key="k").insert_new(
                "telegram_updates", [{"update_id": 1}], on_conflict="update_id"))
        self.assertIsNone(SupabaseSync(url="", service_key="").insert_new(
            "telegram_updates", [{"update_id": 1}], on_conflict="update_id"))


if __name__ == "__main__":
    unittest.main()
