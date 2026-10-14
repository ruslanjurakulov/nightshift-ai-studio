"""Webhook mode: the secret-token header is checked in constant time and the
sender allow-list runs before any database write or data read. The HTTP server
is exercised on a loopback socket with fakes behind it; no Telegram, no
Supabase, no secret."""

import hmac
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from modules.operator_bot import router, webhook
from modules.operator_bot.config import valid_secret_token
from tests.operator_bot_fakes import (
    FakeHttp, FakeTelegram, NOW, github_ok, healthy_tables, make_control, make_ops, site_ok, update_callback,
    update_message,
)

SECRET = "s3cret_token-ABCDEFGHIJKLMNOP"
HEADER = {"X-Telegram-Bot-Api-Secret-Token": SECRET}


class Claims:
    enabled = True

    def __init__(self, fail=False):
        self.seen = set()
        self.calls = 0
        self.fail = fail

    def insert_new(self, table, rows, on_conflict):
        self.calls += 1
        if self.fail:
            return None
        new = [r for r in rows if r["update_id"] not in self.seen]
        self.seen |= {r["update_id"] for r in new}
        return new


def build(claims=None, secret=SECRET):
    tg = FakeTelegram()
    control = make_control(tg)
    ops, sync = make_ops(healthy_tables(), FakeHttp({**site_ok(), **github_ok()}))
    bot = router.OperatorBot(control, None, ops, None, ops.cfg, clock=lambda: NOW.timestamp())
    claims = claims if claims is not None else Claims()
    return webhook.WebhookService(bot, secret, claims), tg, sync, claims


def post(service, update, headers=HEADER, path=webhook.DEFAULT_PATH, method="POST"):
    body = update if isinstance(update, bytes) else json.dumps(update).encode()
    return service.handle(method, path, headers, body)


class SecretTestCase(unittest.TestCase):
    def test_the_comparison_is_constant_time(self):
        with patch.object(hmac, "compare_digest", wraps=hmac.compare_digest) as cd:
            self.assertTrue(webhook.verify_secret(SECRET, SECRET))
            self.assertFalse(webhook.verify_secret("wrong", SECRET))
        self.assertEqual(cd.call_count, 2)
        for call in cd.call_args_list:
            self.assertTrue(all(isinstance(a, bytes) for a in call.args))

    def test_a_missing_or_empty_secret_never_matches(self):
        self.assertFalse(webhook.verify_secret("", ""))
        self.assertFalse(webhook.verify_secret(None, None))
        self.assertFalse(webhook.verify_secret("anything", ""))
        self.assertFalse(webhook.verify_secret(None, SECRET))

    def test_non_ascii_header_does_not_raise(self):
        self.assertFalse(webhook.verify_secret("sécret\udcff", SECRET))

    def test_secret_shape_rules(self):
        self.assertEqual(valid_secret_token(SECRET), SECRET)
        for bad in ("", "short", "has space in the secret!!", "x" * 300, "bad/chars+++++++++++"):
            self.assertIsNone(valid_secret_token(bad))


class HandleTestCase(unittest.TestCase):
    def test_a_good_request_is_answered_and_claimed(self):
        service, tg, sync, claims = build()
        status, body = post(service, update_message("/health", update_id=11))
        self.assertEqual((status, body), (200, b"{}"))
        self.assertEqual(len(tg.sent()), 1)
        self.assertEqual(claims.seen, {11})

    def test_wrong_missing_or_empty_secret_is_403_with_no_work(self):
        for headers in ({}, {"X-Telegram-Bot-Api-Secret-Token": "wrong"}, {"X-Telegram-Bot-Api-Secret-Token": ""},
                        {"X-Telegram-Bot-Api-Secret-Token": SECRET + "x"}):
            service, tg, sync, claims = build()
            status, body = post(service, update_message("/health"), headers=headers)
            self.assertEqual((status, body), (403, b""))
            self.assertEqual((tg.calls, sync.reads, claims.calls), ([], [], 0))

    def test_the_header_name_is_case_insensitive(self):
        service, tg, *_ = build()
        status, _ = post(service, update_message("/health"), headers={"x-telegram-bot-api-secret-token": SECRET})
        self.assertEqual(status, 200)
        self.assertEqual(len(tg.sent()), 1)

    def test_no_configured_secret_refuses_everything(self):
        service, tg, sync, claims = build(secret="")
        for headers in ({}, {"X-Telegram-Bot-Api-Secret-Token": ""}, HEADER):
            self.assertEqual(post(service, update_message("/health"), headers=headers)[0], 403)
        self.assertEqual((tg.calls, claims.calls), ([], 0))

    def test_method_and_path(self):
        service, tg, *_ = build()
        self.assertEqual(post(service, {}, method="GET")[0], 404)
        self.assertEqual(post(service, {}, path="/other")[0], 404)
        self.assertEqual(post(service, {}, path=webhook.DEFAULT_PATH + "/x")[0], 404)

    def test_bad_json_and_oversize_bodies(self):
        service, tg, sync, claims = build()
        self.assertEqual(post(service, b"not json")[0], 400)
        self.assertEqual(post(service, b"[1,2]")[0], 400)
        self.assertEqual(post(service, b"x" * (webhook.MAX_BODY_BYTES + 1))[0], 413)
        self.assertEqual((tg.calls, claims.calls), ([], 0))

    def test_the_allow_list_is_checked_before_any_database_write_or_data_read(self):
        stranger_updates = [
            update_message("/health", chat=999),
            update_message("/health", chat=100, user=999),
            update_message("hello", chat=999),
            update_callback("c:health", chat=555, user=100),
            update_callback("c:health", user=999),
            {"update_id": 1, "channel_post": {"text": "/health", "chat": {"id": 100, "type": "channel"}}},
            {"update_id": 2, "edited_message": update_message("/health")["message"]},
        ]
        for upd in stranger_updates:
            service, tg, sync, claims = build()
            status, body = post(service, upd)
            self.assertEqual((status, body), (200, b"{}"))           # 200: a non-200 only makes Telegram retry
            self.assertEqual(claims.calls, 0, upd)                   # no database write
            self.assertEqual(sync.reads, [], upd)                    # no data read
            self.assertEqual(tg.calls, [], upd)                      # and no reply to a stranger

    def test_a_forwarded_message_from_the_admin_is_refused_after_the_allow_list(self):
        service, tg, *_ = build()
        post(service, update_message("/publish v1", forward_origin={"type": "user"}))
        self.assertIn("Forwarded", tg.texts()[0])

    def test_a_retried_delivery_is_skipped(self):
        service, tg, sync, claims = build()
        post(service, update_message("/health", update_id=5))
        post(service, update_message("/health", update_id=5))
        self.assertEqual(len(tg.sent()), 1)

    def test_a_claim_that_cannot_be_made_still_answers_reads_but_refuses_actions(self):
        service, tg, sync, claims = build(Claims(fail=True))
        with patch("modules.event_log.emit") as emit:
            post(service, update_message("/health", update_id=7))
            post(service, update_message("/publish v1", update_id=8))
        emit.assert_not_called()
        self.assertEqual(len(tg.sent()), 2)
        self.assertIn("could not be recorded durably", tg.texts()[1])

    def test_a_button_press_over_the_webhook(self):
        service, tg, *_ = build()
        post(service, update_callback("c:health", update_id=21))
        self.assertEqual(len(tg.answers()), 1)
        self.assertEqual(len(tg.sent()), 1)

    def test_an_update_without_an_id_is_ignored(self):
        service, tg, *_ = build()
        upd = update_message("/health")
        del upd["update_id"]
        post(service, upd)
        self.assertEqual(tg.calls, [])


class ServerTestCase(unittest.TestCase):
    """The real HTTP wrapper, on loopback."""

    def setUp(self):
        from tools import operator_bot_server as srv
        self.service, self.tg, self.sync, self.claims = build()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), srv.make_handler(self.service))
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, method="POST", path=webhook.DEFAULT_PATH, body=b"{}", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        out = (resp.status, resp.read(), dict(resp.getheaders()))
        conn.close()
        return out

    def test_good_request(self):
        status, body, headers = self.request(body=json.dumps(update_message("/health")).encode(), headers=HEADER)
        self.assertEqual((status, body), (200, b"{}"))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(len(self.tg.sent()), 1)

    def test_server_banner_does_not_name_the_software(self):
        _, _, headers = self.request(headers=HEADER)
        self.assertNotIn("Python", headers.get("Server", ""))
        self.assertNotIn("BaseHTTP", headers.get("Server", ""))

    def test_wrong_secret(self):
        status, body, _ = self.request(body=json.dumps(update_message("/health")).encode(),
                                       headers={"X-Telegram-Bot-Api-Secret-Token": "nope"})
        self.assertEqual((status, body), (403, b""))
        self.assertEqual(self.tg.calls, [])

    def test_other_methods_are_404(self):
        for method in ("GET", "PUT", "DELETE", "PATCH"):
            self.assertEqual(self.request(method=method, body=None)[0], 404, method)

    def test_oversized_declared_body_is_refused_before_reading_it(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest("POST", webhook.DEFAULT_PATH)
        conn.putheader("Content-Length", str(webhook.MAX_BODY_BYTES + 1))
        conn.putheader("X-Telegram-Bot-Api-Secret-Token", SECRET)
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()

    def test_missing_content_length_is_411(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest("POST", webhook.DEFAULT_PATH)
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 411)
        conn.close()


class AdminCommandsTestCase(unittest.TestCase):
    def test_set_webhook_sends_the_secret_in_the_body_and_prints_no_secret(self):
        import io
        from contextlib import redirect_stdout
        from tools import operator_bot_server as srv
        tg = FakeTelegram()
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "123456:TESTTOKENTESTTOKENTESTTOKENTEST",
                                       "TELEGRAM_CHAT_ID": "100", "TELEGRAM_WEBHOOK_SECRET": SECRET}):
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = srv.set_webhook("https://example.test/telegram/operator", True, session=tg)
        self.assertEqual(rc, 0)
        method, payload = tg.calls[0]
        self.assertEqual(method, "setWebhook")
        self.assertEqual(payload["secret_token"], SECRET)
        self.assertEqual(payload["allowed_updates"], ["message", "callback_query"])
        self.assertTrue(payload["drop_pending_updates"])
        self.assertNotIn(SECRET, buf.getvalue())
        self.assertNotIn("TESTTOKEN", buf.getvalue())

    def test_set_webhook_refuses_a_bad_url_or_missing_secret(self):
        from tools import operator_bot_server as srv
        env = {"TELEGRAM_BOT_TOKEN": "123456:TESTTOKENTESTTOKENTESTTOKENTEST", "TELEGRAM_CHAT_ID": "100",
               "TELEGRAM_WEBHOOK_SECRET": SECRET}
        for url in ("http://example.test/x", "https://user:pw@example.test/x", "https://example.test/x?a=b",
                    "ftp://x", "https://"):
            with patch.dict("os.environ", env), self.assertRaises(SystemExit):
                srv.set_webhook(url, False, session=FakeTelegram())
        with patch.dict("os.environ", {**env, "TELEGRAM_WEBHOOK_SECRET": ""}), self.assertRaises(SystemExit):
            srv.set_webhook("https://example.test/x", False, session=FakeTelegram())

    def test_serve_refuses_to_start_without_a_valid_secret(self):
        from tools import operator_bot_server as srv
        env = {"TELEGRAM_BOT_TOKEN": "123456:TESTTOKENTESTTOKENTESTTOKENTEST", "TELEGRAM_CHAT_ID": "100"}
        for secret in ("", "short"):
            with patch.dict("os.environ", {**env, "TELEGRAM_WEBHOOK_SECRET": secret}), self.assertRaises(SystemExit):
                srv.serve("127.0.0.1", 0, webhook.DEFAULT_PATH)

    def test_delete_webhook_and_info(self):
        from tools import operator_bot_server as srv
        tg = FakeTelegram()
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "123456:TESTTOKENTESTTOKENTESTTOKENTEST",
                                       "TELEGRAM_CHAT_ID": "100"}):
            self.assertEqual(srv.delete_webhook(session=tg), 0)
        self.assertEqual(tg.calls[0][0], "deleteWebhook")


if __name__ == "__main__":
    unittest.main()
