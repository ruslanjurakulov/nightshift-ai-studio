"""The always-on operator bot (tools/operator_bot_service.py).

Two loops in one process - a Telegram long poll and the alert pass on its own
timer - replacing two GitHub workflows whose schedule fires only every few
hours. No network here: Telegram is a fake session, the alert engine a fake, the
clock an injected wait. What is guarded:

* a message is answered by the same router the workflow uses, once;
* the alert pass runs once per interval, however many polls happen, and a pass
  that raises does not end the service;
* 409 (a webhook or a second consumer) and 401 (a bad token) end the process
  with a non-zero code; a network error never does;
* nothing is kept on disk and nothing listens on a port.
"""

import json
import re
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from modules.operator_bot.router import OperatorBot
from modules.telegram_control import TelegramControl
from tools import operator_bot_service as svc
from tools import run_telegram_control as poll_tool

ROOT = Path(__file__).resolve().parent.parent
NOW = 1_790_000_000


def _resp(updates):
    r = MagicMock()
    r.raise_for_status.return_value = None
    r.json.return_value = {"ok": True, "result": updates}
    return r


def _msg(update_id, text, chat=100):
    return {"update_id": update_id, "message": {"text": text, "chat": {"id": chat}, "from": {"id": chat},
                                                "date": NOW - 30}}


def _http_error(status):
    return requests.HTTPError("boom", response=MagicMock(status_code=status))


class _Claims:
    enabled = True

    def __init__(self):
        self.seen = set()

    def insert_new(self, table, rows, on_conflict):
        new = [r for r in rows if r["update_id"] not in self.seen]
        self.seen |= {r["update_id"] for r in new}
        return new


class _Fixture(unittest.TestCase):
    def setUp(self):
        self.control = TelegramControl(token="tok", chat_id="100", admin_user_ids="")
        self.control.send = MagicMock(return_value=True)
        self.deps = svc.ServiceDeps()
        self.claims = _Claims()
        self.bot = OperatorBot(self.control, self.deps, clock=lambda: NOW)
        self.stats = svc.Stats()
        self.stop = threading.Event()

    def session(self, *answers):
        """A getUpdates session answering in order; after the last answer it stops the loop."""
        answers = list(answers)
        session = MagicMock()

        def get(url, params=None, timeout=None):
            item = answers.pop(0) if answers else _resp([])
            if not answers:
                self.stop.set()
            if isinstance(item, Exception):
                raise item
            return item

        session.get.side_effect = get
        return session

    def poll(self, session, wait=None):
        wait = wait or (lambda s: self.waits.append(s) or False)
        return svc.poll_loop(self.control, self.bot, self.claims, self.stop, self.stats, session=session, wait=wait)

    @property
    def waits(self):
        if not hasattr(self, "_waits"):
            self._waits = []
        return self._waits


class PollLoopTests(_Fixture):
    def test_a_message_is_answered_by_the_router_and_the_offset_moves_on(self):
        session = self.session(_resp([_msg(7, "/start")]), _resp([]))
        offset = self.poll(session)
        self.assertEqual(offset, 8)
        self.control.send.assert_called_once()
        # the second call asks from the new offset, long-polling
        first, second = session.get.call_args_list
        self.assertEqual(first.kwargs["params"]["offset"], 0)
        self.assertEqual(second.kwargs["params"]["offset"], 8)
        self.assertEqual(first.kwargs["params"]["timeout"], poll_tool.LONG_POLL_S)
        self.assertEqual(json.loads(first.kwargs["params"]["allowed_updates"]), ["message", "callback_query"])

    def test_a_restart_replays_nothing_the_claims_already_hold(self):
        batch = [_msg(3, "/start"), _msg(4, "/help")]
        self.poll(self.session(_resp(batch)))
        self.assertEqual(self.control.send.call_count, 2)
        # The process restarts with offset 0 and Telegram hands the last batch over again.
        self.stop.clear()
        self.assertEqual(self.poll(self.session(_resp(batch))), 5)
        self.assertEqual(self.control.send.call_count, 2, "a claimed update must not be answered twice")

    def test_a_stranger_is_refused_and_a_pause_is_only_an_intent(self):
        with patch("modules.event_log.emit") as emit:
            self.poll(self.session(_resp([_msg(5, "/status", chat=999), _msg(6, "/pause finance")])))
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(emit.call_args.args[0], "telegram.command")
        self.assertIn("Not authorized", self.control.send.call_args_list[0].args[1])

    def test_the_server_has_no_local_history_so_status_says_so_instead_of_inventing_a_count(self):
        self.poll(self.session(_resp([_msg(8, "/status")])))
        self.assertIn("unavailable", self.control.send.call_args.args[1].lower())
        # ... and the held-for-review count is unknown, not zero.
        self.assertIsNone(self.bot._held())

    def test_409_and_401_end_the_loop_with_a_clear_reason(self):
        for status, phrase in ((409, "webhook"), (401, "rejected the bot token")):
            with self.subTest(status):
                self.stop.clear()
                with self.assertRaises(poll_tool.PollFatal) as ctx:
                    self.poll(self.session(_http_error(status)))
                self.assertIn(phrase, str(ctx.exception))

    def test_other_errors_back_off_and_never_end_the_loop(self):
        self.stop.clear()
        session = self.session(_http_error(502), RuntimeError("down"), _http_error(500), _resp([_msg(1, "/start")]), _resp([]))
        self.poll(session)
        self.assertEqual(self.waits, [2, 4, 8])
        self.assertEqual(self.control.send.call_count, 1)
        self.assertEqual(self.stats.poll_errors, 3)

    def test_a_slow_failure_backs_off_just_the_same(self):
        # A 502 that took 1.2 s used to count as "not instant" and was retried at once: ~3000 requests an hour.
        # The backoff now follows the failure, not its duration.
        self.stop.clear()
        session = MagicMock()
        answers = [_http_error(502), _http_error(502), _resp([_msg(1, "/start")]), _resp([])]

        def get(url, params=None, timeout=None):
            item = answers.pop(0)
            if not answers:
                self.stop.set()
            if isinstance(item, Exception):
                raise item
            return item

        session.get.side_effect = get
        self.poll(session)
        self.assertEqual(self.waits, [2, 4])

    def test_the_backoff_resets_after_a_good_answer_and_is_capped(self):
        self.stop.clear()
        self.poll(self.session(*[RuntimeError("down")] * 8))
        self.assertEqual(self.waits[:6], [2, 4, 8, 16, 30, 30])
        self.assertEqual(max(self.waits), svc.MAX_BACKOFF_S)
        self.waits.clear()
        self.stop.clear()
        self.poll(self.session(RuntimeError("a"), _resp([_msg(2, "/start")]), RuntimeError("b"), _resp([])))
        self.assertEqual(self.waits, [2, 2])

    def test_a_429_retry_after_is_honoured_and_capped(self):
        def flood(seconds):
            resp = MagicMock(status_code=429)
            resp.json.return_value = {"ok": False, "parameters": {"retry_after": seconds}}
            return requests.HTTPError("429", response=resp)

        self.stop.clear()
        self.poll(self.session(flood(45), flood(99999), _resp([])))
        self.assertEqual(self.waits, [45, svc.MAX_RETRY_AFTER_S])

    def test_a_retry_after_header_or_a_junk_body_is_read_safely(self):
        for body, headers, expected in (
            (ValueError("not json"), {"Retry-After": "7"}, 7),
            ({"parameters": {"retry_after": "x"}}, {}, 0),
            ({"parameters": None}, {}, 0),
            ({"parameters": {"retry_after": -5}}, {}, 0),
        ):
            resp = MagicMock(status_code=429, headers=headers)
            if isinstance(body, Exception):
                resp.json.side_effect = body
            else:
                resp.json.return_value = body
            self.assertEqual(poll_tool._retry_after(requests.HTTPError("x", response=resp)), expected)
        self.assertEqual(poll_tool._retry_after(RuntimeError("no response")), 0)

    def test_a_quiet_long_poll_is_not_an_error(self):
        self.poll(self.session(_resp([]), _resp([])))
        self.assertEqual(self.waits, [])
        self.assertEqual(self.stats.poll_errors, 0)

    def test_the_stop_flag_ends_the_loop_between_polls(self):
        self.stop.set()
        session = self.session()
        self.assertEqual(self.poll(session), 0)
        session.get.assert_not_called()

    def test_the_token_never_reaches_the_log(self):
        with self.assertLogs("run_telegram_control", level="WARNING") as logs:
            self.poll(self.session(requests.ConnectionError("https://api.telegram.org/bottok/getUpdates failed")))
        self.assertNotIn("bottok", "\n".join(logs.output))


class AlertsLoopTests(unittest.TestCase):
    def run_loop(self, engine, ticks, first_delay=20, interval=300):
        """alerts_loop with an injected wait that records every pause and stops after ``ticks`` waits."""
        stop = threading.Event()
        pauses = []

        def wait(seconds):
            pauses.append(seconds)
            return len(pauses) > ticks

        stats = svc.Stats()
        svc.alerts_loop(engine, interval, stop, stats, first_delay=first_delay, wait=wait)
        return pauses, stats

    def test_one_pass_per_interval_after_the_first_delay(self):
        engine = MagicMock()
        engine.tick.return_value = MagicMock(state="ok")
        pauses, stats = self.run_loop(engine, ticks=3)
        self.assertEqual(pauses, [20, 300, 300, 300])
        self.assertEqual(engine.tick.call_count, 3)
        self.assertEqual(stats.passes, 3)
        self.assertEqual(stats.last_pass, "ok")

    def test_stopped_during_the_first_delay_runs_nothing(self):
        engine = MagicMock()
        pauses, _ = self.run_loop(engine, ticks=-1)
        engine.tick.assert_not_called()

    def test_a_failing_pass_is_logged_by_type_and_the_loop_carries_on(self):
        engine = MagicMock()
        engine.tick.side_effect = [RuntimeError("secret-token-123"), MagicMock(state="ok"), RuntimeError("x")]
        with self.assertLogs("operator_bot_service", level="INFO") as logs:
            _, stats = self.run_loop(engine, ticks=3)
        self.assertEqual(engine.tick.call_count, 3)
        self.assertEqual((stats.passes, stats.pass_errors), (1, 2))
        text = "\n".join(logs.output)
        self.assertIn("RuntimeError", text)
        self.assertNotIn("secret-token-123", text)


class RunServiceTests(_Fixture):
    def test_the_pass_runs_once_per_interval_not_once_per_poll(self):
        engine = MagicMock()
        engine.tick.return_value = MagicMock(state="ok")
        session = MagicMock()
        calls = []

        def get(url, params=None, timeout=None):
            calls.append(1)          # a new update every time: five busy polls, no backoff
            if len(calls) >= 5:
                self.stop.set()
            return _resp([_msg(len(calls), "/help")])

        session.get.side_effect = get
        code = svc.run_service(self.control, self.bot, self.claims, engine, self.stop, interval=3600,
                               session=session, first_delay=0, poll_timeout=25)
        self.assertEqual(code, svc.EXIT_OK)
        self.assertEqual(len(calls), 5)
        self.assertEqual(self.control.send.call_count, 5)
        # first_delay 0 lets the startup pass run; the 3600 s interval means no second one
        self.assertLessEqual(engine.tick.call_count, 1)

    def test_409_exits_non_zero_and_stops_the_alert_thread(self):
        engine = MagicMock()
        engine.tick.return_value = MagicMock(state="ok")
        session = MagicMock()
        session.get.side_effect = _http_error(409)
        with self.assertLogs("operator_bot_service", level="ERROR") as logs:
            code = svc.run_service(self.control, self.bot, self.claims, engine, self.stop, interval=3600,
                                   session=session, first_delay=3600)
        self.assertEqual(code, svc.EXIT_REFUSED)
        self.assertTrue(self.stop.is_set())
        self.assertIn("webhook", "\n".join(logs.output))
        engine.tick.assert_not_called()

    def test_401_exits_non_zero_too(self):
        session = MagicMock()
        session.get.side_effect = _http_error(401)
        code = svc.run_service(self.control, self.bot, self.claims, MagicMock(), self.stop, interval=3600,
                               session=session, first_delay=3600)
        self.assertEqual(code, svc.EXIT_REFUSED)

    def test_sigterm_style_stop_exits_zero(self):
        session = MagicMock()
        session.get.side_effect = lambda *a, **k: (self.stop.set(), _resp([]))[1]
        code = svc.run_service(self.control, self.bot, self.claims, MagicMock(), self.stop, interval=3600,
                               session=session, first_delay=3600)
        self.assertEqual(code, svc.EXIT_OK)


class IntervalAndMainTests(unittest.TestCase):
    TEXT = (ROOT / "tools" / "operator_bot_service.py").read_text(encoding="utf-8")

    def test_default_depends_on_the_github_token(self):
        self.assertEqual(svc.alert_interval({}), 600)
        self.assertEqual(svc.alert_interval({"GITHUB_TOKEN": "  "}), 600)
        self.assertEqual(svc.alert_interval({"GITHUB_TOKEN": "t"}), 300)

    def test_it_is_not_a_setting(self):
        self.assertEqual(svc.alert_interval({"GITHUB_TOKEN": "t", "OPERATOR_ALERT_INTERVAL_SECONDS": "60"}), 300)
        self.assertNotIn("OPERATOR_ALERT_INTERVAL_SECONDS", self.TEXT)

    def test_without_telegram_it_exits_2_and_without_supabase_too(self):
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}):
            self.assertEqual(svc.main([]), svc.EXIT_NOT_CONFIGURED)
        env = {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "1", "SUPABASE_URL": "", "SUPABASE_SERVICE_KEY": ""}
        with patch.dict("os.environ", env):
            self.assertEqual(svc.main([]), svc.EXIT_NOT_CONFIGURED)

    def test_main_wires_the_real_engine_and_the_server_deps(self):
        env = {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "1", "SUPABASE_URL": "https://x.supabase.co",
               "SUPABASE_SERVICE_KEY": "k", "GITHUB_TOKEN": ""}
        seen = {}

        def fake_run(control, bot, store, engine, stop, **kw):
            seen.update(bot=bot, engine=engine, interval=kw["interval"])
            return 0

        with patch.dict("os.environ", env), patch.object(svc, "run_service", fake_run), \
                patch("signal.signal"):
            self.assertEqual(svc.main([]), 0)
        self.assertIsInstance(seen["bot"].deps, svc.ServiceDeps)
        self.assertEqual(type(seen["engine"]).__name__, "AlertEngine")
        self.assertEqual(seen["interval"], 600)


class NoStateNoListenerTests(unittest.TestCase):
    TEXT = (ROOT / "tools" / "operator_bot_service.py").read_text(encoding="utf-8")

    def test_it_listens_on_nothing_and_does_not_use_the_webhook_server(self):
        for needle in ("http.server", "socketserver", "bind(", "listen(", "operator_bot_server", "set-webhook", "flask", "uvicorn"):
            self.assertNotIn(needle, self.TEXT)

    def test_it_writes_no_local_state(self):
        for needle in ("open(", "write_text", "write_bytes", "_save_offset", "_OFFSET_FILE", "mkdir", "StateStore"):
            self.assertNotRegex(self.TEXT.split('"""', 2)[2], re.escape(needle))

    def test_it_does_not_import_the_pipeline_or_a_provider(self):
        for needle in ("queue_worker", "ELEVENLABS_API_KEY", "GEMINI", "publisher", "youtube_"):
            self.assertNotIn(needle, self.TEXT)

    def test_the_single_consumer_rule_is_the_poll_tools_own(self):
        # one getUpdates call site in the service: poll_once, which treats 409/401 as fatal
        self.assertEqual(len(re.findall(r"getUpdates", self.TEXT.split('"""', 2)[2])), 0)
        self.assertIn("raise_fatal=True", self.TEXT)


if __name__ == "__main__":
    unittest.main()
