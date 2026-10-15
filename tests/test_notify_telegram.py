"""The customer-bot sender (modules/notify_telegram.py, tools/notify_worker.py,
tools/fake_telegram.py). No Telegram call is ever made: a fake session or the
local fake server answers, and a real host is refused by the fake itself."""

import json
import logging
from pathlib import Path
import re
import threading
import unittest
from unittest import mock
from http.server import HTTPServer
from io import StringIO

import requests

from modules import log_redaction
from modules import notify_i18n as i18n
from modules import notify_telegram as nt
from tools import fake_telegram
from tools import notify_worker as nw

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://app.example.test"
UUID = "0f0e0d0c-0b0a-4000-8000-000000000001"
TOKEN = "123456:TESTTOKENNOTREALTESTTOKENNOTREAL"
BANNED = re.compile(r"openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|\b(owner|editor|viewer|admin)\b|"
                    r"владелец|редактор|наблюдатель|администратор|egasi|muharrir|kuzatuvchi", re.I)


class Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeSession:
    """Records every URL and refuses the real API host: a test can never reach Telegram."""

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def post(self, url, json=None, timeout=None):
        assert "api.telegram.org" not in url, "a test tried the real Telegram API"
        self.calls.append((url, json))
        a = self.answers.pop(0) if self.answers else Resp(200, {"ok": True, "result": {"message_id": 1}})
        if isinstance(a, BaseException):
            raise a
        return a


class Words(unittest.TestCase):
    def test_every_kind_has_words_in_every_language_and_no_brand_or_role_word(self):
        keys = {k for k in i18n.BUNDLES["en"] if k.startswith("push.")}
        self.assertTrue({"push." + k for k in nt.KINDS} <= keys)
        for lang, table in i18n.BUNDLES.items():
            own = {k for k in table if k.startswith("push.")}
            self.assertEqual(own, keys, f"{lang} is missing or has extra keys")
            for key in own:
                self.assertFalse(BANNED.search(table[key]), (lang, key))
                self.assertLessEqual(len(table[key]), 200)

    def test_an_unknown_language_falls_back_to_english_never_to_a_branch(self):
        for lang in ("ar", "ur", None, "", "xx-yy", 5, "../../etc", "en ", "e"):
            self.assertEqual(nt.words(lang, "credits_low"), "Your credits are running low.")
        self.assertEqual(nt.words("ru", "credits_low"), "Кредиты заканчиваются.")
        self.assertEqual(nt.words("uz", "editor_export_done"), "Eksport tayyor.")
        bundles = {k: v for k, v in i18n.BUNDLES.items() if k != "uz"}
        with mock.patch.object(i18n, "BUNDLES", bundles):
            self.assertEqual(nt.words("uz", "editor_export_done"), "Your export is ready.")

    def test_a_language_with_missing_keys_falls_back_per_key(self):
        bundles = dict(i18n.BUNDLES, xx={"push.credits_low": "XX low"})
        with mock.patch.object(i18n, "BUNDLES", bundles):
            self.assertEqual(nt.words("xx", "credits_low"), "XX low")
            self.assertEqual(nt.words("xx", "test"), i18n.BUNDLES["en"]["push.test"])

    def test_failed_says_credits_were_returned_only_when_the_notification_says_so(self):
        self.assertIn("credits were returned", nt.sentence("creative_job_failed", {"credits_returned": 6}, "en"))
        self.assertNotIn("returned", nt.sentence("creative_job_failed", {}, "en"))
        self.assertNotIn("returned", nt.sentence("creative_job_failed", {"credits_returned": "6"}, "en"))
        self.assertNotIn("returned", nt.sentence("creative_job_failed", {"credits_returned": True}, "en"))

    def test_the_message_is_a_sentence_and_a_link_and_nothing_a_person_typed(self):
        data = {"capability": "t2i", "job_id": UUID, "title": "My secret video", "prompt": "secret", "credits_charged": 6}
        m = nt.build_message(ORIGIN, "42", "creative_job_completed", data, "en")
        blob = json.dumps(m)
        self.assertEqual(m["text"], "Your video is ready.")
        for leak in ("secret", "My ", "6", UUID):
            self.assertNotIn(leak, blob)
        self.assertEqual(m["reply_markup"]["inline_keyboard"], [[{"text": "Open", "url": f"{ORIGIN}/library"}]])
        self.assertEqual(m["link_preview_options"], {"is_disabled": True})
        self.assertEqual(set(m), {"chat_id", "text", "link_preview_options", "reply_markup"})

    def test_links_lead_where_the_bell_leads_and_only_with_real_uuids(self):
        self.assertEqual(nt.link_path("creative_job_completed", {"capability": "captions"}), "/editor")
        self.assertEqual(nt.link_path("creative_job_failed", {"capability": "t2i"}), "/studio")
        self.assertEqual(nt.link_path("creative_job_failed", {"capability": "describe"}), "/create")
        self.assertEqual(nt.link_path("storyboard_ready", {"storyboard_id": UUID}), f"/videos/storyboard/{UUID}")
        self.assertEqual(nt.link_path("storyboard_ready", {"storyboard_id": "x?y=1"}), "/videos")
        self.assertEqual(nt.link_path("editor_export_done", {"project_id": UUID}), f"/editor/{UUID}")
        self.assertEqual(nt.link_path("editor_export_done", {"project_id": "../x"}), "/library")
        self.assertEqual(nt.link_path("credits_low", {"available": 3}), "/credits")
        self.assertIsNone(nt.link_path("test", {}))
        self.assertNotIn("reply_markup", nt.build_message(ORIGIN, "1", "test", {}, "en"))

    def test_a_ready_video_leads_to_its_own_page_only_with_a_plain_id(self):
        self.assertEqual(nt.link_path("video_ready", {"video_id": "run-ab12_x"}), "/videos/run-ab12_x")
        for bad in ({}, {"video_id": "../x"}, {"video_id": "a b"}, {"video_id": "x?y=1"}, {"video_id": 5}):
            self.assertEqual(nt.link_path("video_ready", bad), "/videos")
        self.assertIn("ready", nt.sentence("video_ready", {}, "en"))

    def test_every_link_starts_at_a_section_the_app_redirects_to_the_open_channel(self):
        # Without a channel in the path the middleware redirects a URL whose first segment is a SECTION.
        text = (ROOT / "command-center" / "lib" / "channels.ts").read_text(encoding="utf-8")
        sections = set(re.findall(r'"([a-z-]+)"', text.split("export const SECTIONS = [", 1)[1].split("]", 1)[0]))
        samples = [nt.link_path(k, {"storyboard_id": UUID, "project_id": UUID, "video_id": "run-1", "capability": c})
                   for k in nt.KINDS for c in ("t2i", "captions", "describe")]
        for path in filter(None, samples):
            self.assertIn(path.split("/")[1], sections, path)

    def test_an_unknown_kind_has_no_message(self):
        self.assertIsNone(nt.build_message(ORIGIN, "1", "weekly_summary", {}, "en"))

    def test_the_app_origin_is_https_without_a_path_or_credentials(self):
        self.assertEqual(nt.valid_app_origin("https://app.example.test/"), ORIGIN)
        self.assertEqual(nt.valid_app_origin("http://localhost:3000"), "http://localhost:3000")
        for bad in (None, "", "app.example.test", "http://app.example.test", "https://a.test/x", "https://u:p@a.test",
                    "javascript:alert(1)", "https://a.test?x=1", "ftp://a.test"):
            self.assertIsNone(nt.valid_app_origin(bad), bad)


class Client(unittest.TestCase):
    def send(self, *answers):
        s = FakeSession(*answers)
        return nt.TelegramClient(TOKEN, "http://fake.test", s).send_message({"chat_id": "1", "text": "x"}), s

    def test_ok_is_sent_with_the_message_id(self):
        r, s = self.send(Resp(200, {"ok": True, "result": {"message_id": 77}}))
        self.assertEqual(r, nt.SendResult("sent", message_id="77"))
        self.assertEqual(s.calls[0][0], f"http://fake.test/bot{TOKEN}/sendMessage")

    def test_a_blocked_bot_is_final(self):
        for st, desc in ((403, "Forbidden: bot was blocked by the user"), (403, ""), (400, "Bad Request: chat not found"),
                         (400, "Forbidden: user is deactivated")):
            r, _ = self.send(Resp(st, {"ok": False, "description": desc}))
            self.assertEqual((r.outcome, r.error_code), ("blocked", "blocked"), (st, desc))

    def test_rate_limit_carries_retry_after_and_is_bounded(self):
        r, _ = self.send(Resp(429, {"parameters": {"retry_after": 7}}))
        self.assertEqual((r.outcome, r.error_code, r.retry_after), ("retry", "rate_limited", 7))
        r, _ = self.send(Resp(429, {"parameters": {"retry_after": 10**9}}))
        self.assertEqual(r.retry_after, 30)
        r, _ = self.send(Resp(429, None))
        self.assertEqual(r.retry_after, 30)

    def test_server_errors_retry_and_bad_requests_do_not(self):
        self.assertEqual(self.send(Resp(502, {}))[0], nt.SendResult("retry", "http_5xx"))
        self.assertEqual(self.send(Resp(400, {"description": "Bad Request: text is empty"}))[0], nt.SendResult("dead", "bad_request"))
        self.assertEqual(self.send(Resp(401, {}))[0], nt.SendResult("retry", "not_configured"))
        self.assertEqual(self.send(Resp(200, None))[0], nt.SendResult("dead", "bad_request"))

    def test_only_a_request_that_never_left_is_retried_never_one_that_may_have_arrived(self):
        self.assertEqual(self.send(requests.exceptions.ConnectTimeout("x"))[0], nt.SendResult("retry", "network"))
        self.assertEqual(self.send(requests.exceptions.ReadTimeout("x"))[0], nt.SendResult("dead", "unconfirmed"))
        self.assertEqual(self.send(requests.exceptions.ConnectionError("reset"))[0], nt.SendResult("dead", "unconfirmed"))
        from urllib3.exceptions import NewConnectionError
        refused = requests.exceptions.ConnectionError(NewConnectionError(None, "refused"))
        self.assertEqual(self.send(refused)[0], nt.SendResult("retry", "network"))

    def test_the_real_api_is_only_the_default_of_an_unset_env(self):
        self.assertEqual(nt.api_base_from_env({}), nt.REAL_API_BASE)
        self.assertEqual(nt.api_base_from_env({"NOTIFY_TELEGRAM_API_BASE": " http://127.0.0.1:8081 "}), "http://127.0.0.1:8081")

    def test_a_token_in_a_logged_error_is_scrubbed(self):
        buf = StringIO()
        h = logging.StreamHandler(buf)
        h.addFilter(log_redaction.RedactingFilter())
        lg = logging.getLogger("notify-test")
        lg.addHandler(h)
        lg.warning("failed for url: https://api.telegram.org/bot%s/sendMessage", TOKEN)
        self.assertNotIn("TESTTOKEN", buf.getvalue())


class Limiter(unittest.TestCase):
    def test_one_second_per_chat_and_a_gap_overall(self):
        now = [0.0]
        slept = []
        lim = nt.SendLimiter(clock=lambda: now[0], sleep=lambda d: (slept.append(d), now.__setitem__(0, now[0] + d)),
                             per_chat=1.0, overall_per_second=25)
        self.assertEqual(lim.wait("a"), 0)
        self.assertAlmostEqual(lim.wait("b"), 0.04, places=3)
        self.assertGreaterEqual(lim.wait("a"), 0.9)
        now[0] += 5
        self.assertEqual(lim.wait("a"), 0)


class FakeQueue:
    def __init__(self, rows):
        self.rows, self.done = rows, []

    def claim(self, worker, limit):
        rows, self.rows = self.rows, []
        return rows

    def complete(self, rid, worker, result):
        self.done.append((rid, result))
        return True


def row(i, chat="42", kind="creative_job_completed", lang="en", data=None):
    return {"id": f"id{i}", "external_id": chat, "event_kind": kind, "locale": lang, "data": data or {"capability": "t2i"}}


class Worker(unittest.TestCase):
    def run_batch(self, rows, *answers):
        q, s = FakeQueue(rows), FakeSession(*answers)
        lim = nt.SendLimiter(clock=lambda: 0.0, sleep=lambda d: None)
        counts, self.pause = nw.process_batch(q, nt.TelegramClient(TOKEN, "http://fake.test", s), lim, ORIGIN, "w1")
        return q, s, counts

    def test_each_row_is_sent_once_in_its_own_language_and_settled(self):
        q, s, counts = self.run_batch([row(1, lang="ru"), row(2, chat="43", kind="credits_low", lang="ar")])
        self.assertEqual([c[1]["text"] for c in s.calls], ["Ваше видео готово.", "Your credits are running low."])
        self.assertEqual([r.outcome for _, r in q.done], ["sent", "sent"])
        self.assertEqual(counts, {"sent": 2})

    def test_a_refused_token_pauses_the_whole_worker_and_hands_back_the_rest_unsent(self):
        with self.assertLogs("notify_worker", level="ERROR") as logs:
            q, s, counts = self.run_batch([row(1, chat="1"), row(2, chat="2"), row(3, chat="3")], Resp(401, {}))
        self.assertEqual(len(s.calls), 1, "one question to Telegram, not one per message")
        self.assertEqual([(r.outcome, r.error_code, r.retry_after) for _, r in q.done], [("retry", "not_configured", 300)] * 3)
        self.assertEqual(self.pause, 300)
        self.assertIn("ALARM", logs.output[0])
        self.assertNotIn(TOKEN, logs.output[0])

    def test_a_rate_limit_pauses_everything_for_its_retry_after_not_just_that_chat(self):
        q, s, counts = self.run_batch([row(1, chat="1"), row(2, chat="2")], Resp(429, {"parameters": {"retry_after": 9}}))
        self.assertEqual(len(s.calls), 1)
        self.assertEqual([(r.error_code, r.retry_after) for _, r in q.done], [("rate_limited", 9), ("rate_limited", 9)])
        self.assertEqual(self.pause, 9)
        q, s, counts = self.run_batch([row(1)], Resp(429, {"parameters": {"retry_after": 3000}}))
        self.assertEqual(self.pause, nw.MAX_RATE_PAUSE_SECONDS)

    def test_a_blocked_chat_is_reported_blocked_and_the_next_still_goes(self):
        q, s, _ = self.run_batch([row(1, chat="1"), row(2, chat="2")], Resp(403, {"description": "bot was blocked"}))
        self.assertEqual([r.outcome for _, r in q.done], ["blocked", "sent"])

    def test_an_unknown_kind_is_dropped_not_sent(self):
        q, s, _ = self.run_batch([row(1, kind="weekly_summary")])
        self.assertEqual(s.calls, [])
        self.assertEqual(q.done[0][1], nt.SendResult("dead", "bad_request"))

    def test_a_failure_to_settle_is_not_a_reason_to_send_again(self):
        class Down(FakeQueue):
            def complete(self, *a):
                raise nw.QueueUnavailable("complete: HTTP 503")
        q, s = Down([row(1)]), FakeSession()
        nw.process_batch(q, nt.TelegramClient(TOKEN, "http://fake.test", s), nt.SendLimiter(sleep=lambda d: None), ORIGIN, "w1")
        self.assertEqual(len(s.calls), 1)

    def test_the_outbox_calls_carry_only_codes(self):
        calls = []

        class Http:
            def post(self, url, json=None, timeout=None, headers=None):
                calls.append((url, json))
                return Resp(200, [])
        oq = nw.OutboxQueue("https://x.supabase.test/", "svc", session=Http())
        oq.complete("id1", "w1", nt.SendResult("retry", "rate_limited", retry_after=7))
        self.assertTrue(calls[0][0].endswith("/rest/v1/rpc/complete_notification_outbox"))
        self.assertEqual(calls[0][1], {"p_id": "id1", "p_worker": "w1", "p_outcome": "retry", "p_error_code": "rate_limited",
                                       "p_retry_after_s": 7, "p_provider_message_id": None})


class LocalFake(unittest.TestCase):
    """The worker against tools/fake_telegram.py over real HTTP on 127.0.0.1."""

    def test_driving_every_failure_without_telegram(self):
        fake = fake_telegram.FakeTelegram()
        srv = HTTPServer(("127.0.0.1", 0), fake_telegram.make_handler(fake))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{srv.server_port}"
            client = nt.TelegramClient(TOKEN, base, requests.Session(), timeout=5)
            send = lambda chat: client.send_message(nt.build_message(ORIGIN, chat, "credits_low", {}, "uz"))  # noqa: E731
            self.assertEqual(send("100").outcome, "sent")
            self.assertEqual(send("5403").outcome, "blocked")
            r = send("5429")
            self.assertEqual((r.error_code, r.retry_after), ("rate_limited", 7))
            self.assertEqual(send("5500").error_code, "http_5xx")
            self.assertEqual(send("5400").outcome, "blocked")
            self.assertEqual(len(fake.sent), 1)
            self.assertEqual(fake.sent[0]["text"], "Kreditlaringiz tugab bormoqda.")
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
