"""The Telegram bot token and the Slack webhook URL never reach a log line.

Both credentials live inside the request URL, and a ``requests`` exception's
text quotes that URL (``raise_for_status()``: "... for url: https://api.
telegram.org/bot<token>/getUpdates"). Logging ``str(e)`` wrote them into
logs/*.log, which daily_video, intelligence_poll and telegram_control upload
as artifacts — where Actions' secret masking does not reach.

These capture every record the clients emit, at every level, and check that
neither the token nor the URL appears in any of them, only the exception type
and the HTTP status. Written with ``assertLogs`` (pytest's caplog, in
unittest form) so CI's ``unittest discover`` runs them too.
"""

from __future__ import annotations

import io
import logging
import unittest
from unittest.mock import MagicMock, patch

import requests

from modules import log_redaction
from modules.log_redaction import RedactingFilter, describe_http_error, redact

# Fake credentials, assembled at runtime so no credential-shaped literal sits
# in the source (secret scanning would rightly flag one).
TG_TOKEN = "1" * 9 + ":" + "fake" * 8 + "Ab"
TG_URL = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
SLACK_SECRET_PART = "/".join(("T" + "0" * 8, "B" + "0" * 8, "fake" * 6))
SLACK_URL = "https://hooks.slack.com/" + "services/" + SLACK_SECRET_PART


def _http_error(url: str, status: int) -> requests.HTTPError:
    resp = requests.Response()
    resp.status_code = status
    resp.url = url
    resp.reason = "Not Found"
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:  # the real message, URL and all
        return e
    raise AssertionError("raise_for_status did not raise")


def _connection_error(url: str) -> requests.ConnectionError:
    return requests.ConnectionError(
        f"HTTPSConnectionPool(host='x', port=443): Max retries exceeded with url: {url} "
        "(Caused by NewConnectionError('Failed to establish a new connection'))")


class _Captured:
    """Every record at every level from the root logger, rendered the way a
    handler would write it (message plus traceback)."""

    def __init__(self, testcase: unittest.TestCase):
        self.cm = testcase.assertLogs(level=logging.DEBUG)

    def __enter__(self):
        self.watcher = self.cm.__enter__()
        return self

    def __exit__(self, *exc):
        return self.cm.__exit__(*exc)

    @property
    def text(self) -> str:
        fmt = logging.Formatter("%(levelname)s %(name)s %(message)s")
        return "\n".join(fmt.format(r) for r in self.watcher.records)


class TelegramNeverLogsTokenTestCase(unittest.TestCase):
    def assert_clean(self, text: str):
        self.assertNotIn(TG_TOKEN, text)
        self.assertNotIn(TG_TOKEN.split(":", 1)[1], text)
        self.assertNotIn("api.telegram.org/bot", text)

    def test_send_connection_error(self):
        from modules.telegram_control import TelegramControl

        control = TelegramControl(token=TG_TOKEN, chat_id="42")
        with patch("requests.post", side_effect=_connection_error(TG_URL)), _Captured(self) as cap:
            self.assertFalse(control.notify("hello"))
        self.assert_clean(cap.text)
        self.assertIn("ConnectionError", cap.text)

    def test_send_timeout(self):
        from modules.telegram_control import TelegramControl

        control = TelegramControl(token=TG_TOKEN, chat_id="42")
        err = requests.Timeout(f"Read timed out. (url: {TG_URL})")
        with patch("requests.post", side_effect=err), _Captured(self) as cap:
            self.assertFalse(control.send("42", "hi"))
        self.assert_clean(cap.text)
        self.assertIn("Timeout", cap.text)

    def test_send_non_200_logs_status_only(self):
        from modules.telegram_control import TelegramControl

        resp = MagicMock(status_code=401, text=f"Unauthorized for {TG_URL}", url=TG_URL)
        control = TelegramControl(token=TG_TOKEN, chat_id="42")
        with patch("requests.post", return_value=resp), _Captured(self) as cap:
            self.assertFalse(control.notify("hello"))
        self.assert_clean(cap.text)
        self.assertIn("401", cap.text)

    def test_get_updates_http_error_logs_type_and_status(self):
        from modules.telegram_control import TelegramControl
        from tools import run_telegram_control as transport

        control = TelegramControl(token=TG_TOKEN, chat_id="42")
        resp = MagicMock()
        resp.raise_for_status.side_effect = _http_error(
            f"https://api.telegram.org/bot{TG_TOKEN}/getUpdates?offset=0&timeout=0", 404)
        session = MagicMock()
        session.get.return_value = resp
        with _Captured(self) as cap:
            self.assertEqual(transport.poll_once(control, MagicMock(), session=session, offset=7), 7)
        self.assert_clean(cap.text)
        self.assertIn("HTTPError (HTTP 404)", cap.text)

    def test_get_updates_connection_error(self):
        from modules.telegram_control import TelegramControl
        from tools import run_telegram_control as transport

        control = TelegramControl(token=TG_TOKEN, chat_id="42")
        session = MagicMock()
        session.get.side_effect = _connection_error(f"/bot{TG_TOKEN}/getUpdates")
        with _Captured(self) as cap:
            transport.poll_once(control, MagicMock(), session=session, offset=0)
        self.assert_clean(cap.text)
        self.assertIn("ConnectionError", cap.text)


class SlackNeverLogsWebhookTestCase(unittest.TestCase):
    def assert_clean(self, text: str):
        self.assertNotIn(SLACK_URL, text)
        self.assertNotIn(SLACK_SECRET_PART, text)
        self.assertNotIn("hooks.slack.com/services", text)

    def _send(self, **post):
        from modules.notifier import Notifier

        env = {"SLACK_WEBHOOK_URL": SLACK_URL, "TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}
        with patch.dict("os.environ", env), patch("modules.notifier.requests.post", **post), \
                _Captured(self) as cap:
            result = Notifier().send("1 run(s) pending human approval")
        return result, cap.text

    def test_connection_error(self):
        result, text = self._send(side_effect=_connection_error(SLACK_URL))
        self.assertFalse(result["slack"])
        self.assert_clean(text)
        self.assertIn("ConnectionError", text)

    def test_http_error(self):
        result, text = self._send(side_effect=_http_error(SLACK_URL, 403))
        self.assertFalse(result["slack"])
        self.assert_clean(text)
        self.assertIn("HTTPError (HTTP 403)", text)

    def test_non_2xx(self):
        result, text = self._send(return_value=MagicMock(status_code=404, url=SLACK_URL))
        self.assertFalse(result["slack"])
        self.assert_clean(text)
        self.assertIn("404", text)


class RedactionTestCase(unittest.TestCase):
    def test_redact_known_url_credentials(self):
        text = (f"GET {TG_URL} failed; POST {SLACK_URL} failed; "
                "https://www.googleapis.com/youtube/v3/channels?part=id&key=" + "fake-api-key" + "&alt=json")
        clean = redact(text)
        self.assertNotIn(TG_TOKEN, clean)
        self.assertNotIn(SLACK_SECRET_PART, clean)
        self.assertNotIn("fake-api-key", clean)
        self.assertIn("part=id", clean)
        self.assertIn("alt=json", clean)
        self.assertIn("api.telegram.org/bot<redacted>/sendMessage", clean)

    def test_describe_http_error(self):
        self.assertEqual(describe_http_error(_http_error(TG_URL, 502)), "HTTPError (HTTP 502)")
        self.assertEqual(describe_http_error(_connection_error(TG_URL)), "ConnectionError")
        self.assertEqual(describe_http_error(ValueError(TG_URL)), "ValueError")

    def test_filter_scrubs_messages_args_and_tracebacks(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.addFilter(RedactingFilter())
        log = logging.getLogger("test_log_redaction.filter")
        log.addHandler(handler)
        log.propagate = False
        self.addCleanup(log.removeHandler, handler)
        log.warning("send failed: %s", _connection_error(TG_URL))
        log.warning(f"webhook {SLACK_URL}")
        try:
            raise _http_error(TG_URL, 404)
        except requests.HTTPError:
            log.exception("boom")
        out = stream.getvalue()
        self.assertNotIn(TG_TOKEN, out)
        self.assertNotIn(SLACK_SECRET_PART, out)
        self.assertIn("Traceback", out)
        self.assertIn("boom", out)

    def test_install_is_idempotent_and_reaches_child_loggers(self):
        root = logging.getLogger()
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root.addHandler(handler)
        self.addCleanup(root.removeHandler, handler)
        old_level = root.level
        root.setLevel(logging.INFO)
        self.addCleanup(root.setLevel, old_level)
        before = {h: list(h.filters) for h in root.handlers}

        def restore():
            for h, filters in before.items():
                h.filters[:] = filters
        self.addCleanup(restore)
        log_redaction.install()
        log_redaction.install()
        self.assertEqual(sum(isinstance(f, RedactingFilter) for f in handler.filters), 1)
        logging.getLogger("some.library").warning("url: %s", TG_URL)
        self.assertNotIn(TG_TOKEN, stream.getvalue())
        self.assertIn("bot<redacted>", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
