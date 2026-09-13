"""Telegram control-panel transport (tools/run_telegram_control.py).

The transport's job: pull updates, route each through the pure core, send the
reply back to whoever asked, and advance the offset. No network in these tests
— the requests session is a fake; the pure routing lives in
modules/telegram_control.py and is tested there."""

import unittest
from unittest.mock import MagicMock, patch

from modules.telegram_control import TelegramControl
from tools import run_telegram_control as mod


def _updates_response(updates):
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"ok": True, "result": updates}
    return resp


def _msg(update_id, chat_id, text):
    return {"update_id": update_id, "message": {"text": text, "chat": {"id": chat_id}}}


class PollOnceTestCase(unittest.TestCase):
    def setUp(self):
        # admin chat 100; token present so the transport is live
        self.control = TelegramControl(token="tok", chat_id="100")
        self.control.send = MagicMock(return_value=True)   # capture replies, no network
        self.deps = MagicMock()
        self.deps.status_summary.return_value = "all good"

    def test_no_token_is_a_noop(self):
        control = TelegramControl(token="", chat_id="")
        session = MagicMock()
        self.assertEqual(mod.poll_once(control, self.deps, session=session, offset=5), 5)
        session.get.assert_not_called()

    def test_routes_query_and_replies_to_sender(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(7, 100, "/status")])
        new_offset = mod.poll_once(self.control, self.deps, session=session, offset=0)
        self.assertEqual(new_offset, 8)   # max update_id + 1
        self.control.send.assert_called_once()
        chat_arg, text_arg = self.control.send.call_args.args
        self.assertEqual(chat_arg, 100)
        self.assertIn("all good", text_arg)

    def test_unauthorized_chat_gets_refusal_not_data(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(1, 999, "/status")])  # not admin
        mod.poll_once(self.control, self.deps, session=session, offset=0)
        _, text_arg = self.control.send.call_args.args
        self.assertIn("Not authorized", text_arg)
        self.deps.status_summary.assert_not_called()

    def test_action_intent_is_emitted_not_executed(self):
        session = MagicMock()
        session.get.return_value = _updates_response([_msg(3, 100, "/pause finance")])
        with patch("modules.event_log.emit") as emit:
            mod.poll_once(self.control, self.deps, session=session, offset=0)
        emit.assert_called_once()
        self.assertEqual(emit.call_args.args[0], "telegram.command")
        self.assertEqual(emit.call_args.kwargs["metadata"], {"action": "pause", "target": "finance"})

    def test_getupdates_failure_keeps_offset(self):
        session = MagicMock()
        session.get.side_effect = RuntimeError("network down")
        self.assertEqual(mod.poll_once(self.control, self.deps, session=session, offset=42), 42)
        self.control.send.assert_not_called()

    def test_non_text_update_is_skipped(self):
        session = MagicMock()
        session.get.return_value = _updates_response([{"update_id": 9, "message": {"chat": {"id": 100}}}])
        new_offset = mod.poll_once(self.control, self.deps, session=session, offset=0)
        self.assertEqual(new_offset, 10)   # offset still advances past it
        self.control.send.assert_not_called()


class SendTestCase(unittest.TestCase):
    def test_send_no_token_is_false(self):
        self.assertFalse(TelegramControl(token="", chat_id="").send(100, "hi"))

    def test_send_blank_chat_is_false(self):
        self.assertFalse(TelegramControl(token="tok", chat_id="100").send("", "hi"))


if __name__ == "__main__":
    unittest.main()
