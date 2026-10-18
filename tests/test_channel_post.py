"""The brand channel's sender (modules/channel_post.py): the message builder and how Telegram's answer becomes
what ``complete_marketing_post`` accepts. No Telegram call is ever made: a fake session, or the local fake server
(tools/fake_telegram.py) on 127.0.0.1, answers.

What these pin, because each is a way to post something wrong in public:
  * one message, three labelled blocks in the fixed order, then the link; the words only HTML-escaped;
  * the 4096 / 1024 limits are refused, never truncated, and counted the way Telegram counts (after parsing);
  * only "the connection was never established" is retried; a read timeout, a reset, a 5xx and an unreadable
    reply are final (the post may be on the channel).
"""

import socket
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit

import requests

from modules import channel_post as cp
from modules import notify_telegram as nt
from tools import fake_telegram

ORIGIN = "https://app.example.test"
MEDIA_BASE = "https://proj.supabase.example.test"
TOKEN = "123456:TESTTOKENNOTREALTESTTOKENNOTREAL"
TEXTS = {"uz": "Salom dunyo, bu sinov matni.", "ru": "Привет, мир, это тестовый текст.", "en": "Hello world, this is test text."}


class Server:
    """tools/fake_telegram.py on a free local port, in a thread."""

    def __init__(self):
        self.fake = fake_telegram.FakeTelegram()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), fake_telegram.make_handler(self.fake))
        self.httpd.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def closed_port_base():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}"


class LocalOnlySession(requests.Session):
    """A requests session that refuses to leave the machine: a test can never reach the real Telegram API."""

    def request(self, method, url, *args, **kwargs):
        host = urlsplit(url).hostname
        assert host in ("127.0.0.1", "localhost"), f"a test tried to reach {host}"
        return super().request(method, url, *args, **kwargs)


def session():
    s = LocalOnlySession()
    s.trust_env = False                       # no proxy from the environment between a test and 127.0.0.1
    return s


def sized_texts(total, link_url=ORIGIN + "/pricing"):
    """Texts whose plain message (with the link line) is exactly ``total`` UTF-16 units."""
    blocks = lambda en: cp._blocks({"uz": "a", "ru": "a", "en": en}, link_url, escape=False)
    pad = total - cp.utf16_len(blocks("a"))
    return {"uz": "a", "ru": "a", "en": "a" + "b" * pad}


class MessageBuilder(unittest.TestCase):
    def test_one_message_three_labelled_blocks_in_the_fixed_order_then_the_link(self):
        out = cp.build_outgoing("@chan_test", {"texts": TEXTS, "link": "/pricing", "media_path": None}, ORIGIN, MEDIA_BASE)
        self.assertEqual(out.method, "sendMessage")
        self.assertEqual(out.payload["text"], (
            "Oʻzbekcha\nSalom dunyo, bu sinov matni.\n\n"
            "Русский\nПривет, мир, это тестовый текст.\n\n"
            "English\nHello world, this is test text.\n\n"
            "https://app.example.test/pricing"))
        self.assertEqual(out.payload["parse_mode"], "HTML")
        self.assertEqual(out.payload["chat_id"], "@chan_test")
        self.assertEqual(out.payload["link_preview_options"], {"is_disabled": True})

    def test_the_order_does_not_follow_the_dict_order(self):
        shuffled = {"en": TEXTS["en"], "uz": TEXTS["uz"], "ru": TEXTS["ru"]}
        text = cp.render(shuffled, None, ORIGIN, False)
        self.assertLess(text.index("Oʻzbekcha"), text.index("Русский"))
        self.assertLess(text.index("Русский"), text.index("English"))
        self.assertTrue(text.endswith(TEXTS["en"]), "without a link the message ends with the English block")

    def test_the_words_are_html_escaped_and_only_that(self):
        texts = {"uz": "A & B <b>x</b> e'lon", "ru": "1 < 2 > 0", "en": 'say "hi" & </a>'}
        text = cp.render(texts, "/pricing", ORIGIN, False)
        self.assertIn("A &amp; B &lt;b&gt;x&lt;/b&gt; e'lon", text)
        self.assertIn("1 &lt; 2 &gt; 0", text)
        self.assertIn('say "hi" &amp; &lt;/a&gt;', text)
        self.assertNotIn("<b>", text)
        self.assertNotIn("&#x27;", text, "Telegram HTML does not promise hex entities; an apostrophe stays itself")

    def test_the_limit_is_counted_after_parsing_so_escapes_do_not_count(self):
        # 3000 ampersands are 3000 characters in the channel but 15000 in the HTML we send.
        texts = {"uz": "a", "ru": "a", "en": "&" * 3000}
        text = cp.render(texts, None, ORIGIN, False)
        self.assertGreater(len(text), cp.MESSAGE_LIMIT)

    def test_exactly_at_the_message_limit_is_sent_one_over_is_refused(self):
        ok = sized_texts(cp.MESSAGE_LIMIT)
        self.assertEqual(cp.utf16_len(cp._blocks(ok, ORIGIN + "/pricing", escape=False)), cp.MESSAGE_LIMIT)
        cp.render(ok, "/pricing", ORIGIN, False)
        with self.assertRaises(cp.Refused) as cm:
            cp.render(sized_texts(cp.MESSAGE_LIMIT + 1), "/pricing", ORIGIN, False)
        self.assertEqual(cm.exception.code, "too_long")

    def test_a_caption_is_held_to_1024(self):
        cp.render(sized_texts(cp.CAPTION_LIMIT), "/pricing", ORIGIN, True)
        with self.assertRaises(cp.Refused) as cm:
            cp.render(sized_texts(cp.CAPTION_LIMIT + 1), "/pricing", ORIGIN, True)
        self.assertEqual(cm.exception.code, "too_long")
        # the same words are fine as a plain message
        cp.render(sized_texts(cp.CAPTION_LIMIT + 1), "/pricing", ORIGIN, False)

    def test_length_is_utf16_units_the_stricter_count(self):
        # one emoji is 1 character but 2 UTF-16 units
        self.assertEqual(cp.utf16_len("😀"), 2)
        texts = sized_texts(cp.CAPTION_LIMIT - 1)
        texts["en"] = texts["en"][:-1] + "😀"                # 1 character -> 2 units: exactly 1024 units
        self.assertEqual(cp.utf16_len(cp._blocks(texts, ORIGIN + "/pricing", escape=False)), cp.CAPTION_LIMIT)
        cp.render(texts, "/pricing", ORIGIN, True)
        texts["en"] = texts["en"][:-3] + "😀" + texts["en"][-2:]   # one more emoji: 1025 units, still under 1024 characters
        with self.assertRaises(cp.Refused):
            cp.render(texts, "/pricing", ORIGIN, True)

    def test_an_over_limit_post_is_refused_not_shortened_and_nothing_is_sent(self):
        srv = Server()
        self.addCleanup(srv.close)
        sender = cp.ChannelSender(nt.TelegramClient(TOKEN, srv.base, session()), "@chan_test", ORIGIN, MEDIA_BASE)
        result = sender.send({"texts": sized_texts(cp.MESSAGE_LIMIT + 1), "link": "/pricing", "media_path": None})
        self.assertEqual((result.outcome, result.error_code, result.refused), ("failed", "bad_request", "too_long"))
        self.assertEqual(srv.fake.calls, [], "a refused post must not reach Telegram, cut or not")

    def test_a_link_needs_a_usable_origin_and_a_clean_path(self):
        for origin in (None, "", "http://app.example.test", "app.example.test", "https://u@app.example.test"):
            with self.assertRaises(cp.Refused, msg=origin) as cm:
                cp.render(TEXTS, "/pricing", origin, False)
            self.assertEqual(cm.exception.code, "no_origin")
        for link in ("pricing", "//evil.example/x", "/a/../b", "/A", "https://evil.example/", "/"):
            with self.assertRaises(cp.Refused, msg=link) as cm:
                cp.render(TEXTS, link, ORIGIN, False)
            self.assertEqual(cm.exception.code, "bad_link")
        # no link: no origin needed, no link line
        self.assertNotIn("http", cp.render(TEXTS, None, None, False))

    def test_all_three_languages_are_required_and_non_empty(self):
        for texts in (None, {}, {"uz": "a", "ru": "b"}, {"uz": "a", "ru": "b", "en": " "}, {"uz": "a", "ru": "b", "en": 5},
                      {"uz": "a", "ru": "b", "en": "c", "de": "d"}):
            with self.assertRaises(cp.Refused, msg=texts) as cm:
                cp.render(texts, None, ORIGIN, False)
            self.assertEqual(cm.exception.code, "bad_texts")

    def test_words_that_would_have_to_be_altered_are_refused_not_altered(self):
        texts = dict(TEXTS, en="Write to someone@example.com for details")      # sanitize_outgoing would change it
        with self.assertRaises(cp.Refused) as cm:
            cp.render(texts, None, ORIGIN, False)
        self.assertEqual(cm.exception.code, "unsafe_text")


class MediaPath(unittest.TestCase):
    def build(self, path, base=MEDIA_BASE, texts=TEXTS):
        return cp.build_outgoing("@chan_test", {"texts": texts, "link": "/pricing", "media_path": path}, ORIGIN, base)

    def test_a_photo_goes_by_url_with_the_post_as_its_caption(self):
        out = self.build("showcase/2026/sample.jpg")
        self.assertEqual(out.method, "sendPhoto")
        self.assertEqual(out.payload["photo"], MEDIA_BASE + "/storage/v1/object/public/showcase/2026/sample.jpg")
        self.assertEqual(out.payload["caption"], cp.render(TEXTS, "/pricing", ORIGIN, True))
        self.assertEqual(out.payload["parse_mode"], "HTML")
        self.assertNotIn("text", out.payload)

    def test_a_video_goes_by_url_and_streams(self):
        out = self.build("showcase/clip.MP4")
        self.assertEqual(out.method, "sendVideo")
        self.assertEqual(out.payload["video"], MEDIA_BASE + "/storage/v1/object/public/showcase/clip.MP4")
        self.assertIs(out.payload["supports_streaming"], True)

    def test_only_the_public_showcase_bucket_and_known_types_are_sent(self):
        for path in ("previews/x.mp4", "showcase/../private/x.mp4", "showcase/x.gif", "showcase/x.mov", "showcase/x", "/showcase/x.jpg",
                     "showcase/x.jpg?token=1", "showcase/a b.jpg", "https://evil.example/x.jpg"):
            with self.assertRaises(cp.Refused, msg=path) as cm:
                self.build(path)
            self.assertEqual(cm.exception.code, "bad_media", path)

    def test_media_needs_the_storage_origin(self):
        for base in (None, "", "ftp://x.example", "http://remote.example"):
            with self.assertRaises(cp.Refused, msg=base) as cm:
                self.build("showcase/x.jpg", base=base)
            self.assertEqual(cm.exception.code, "no_media_base")

    def test_the_caption_limit_applies_to_media_posts(self):
        with self.assertRaises(cp.Refused) as cm:
            self.build("showcase/x.jpg", texts=sized_texts(cp.CAPTION_LIMIT + 1))
        self.assertEqual(cm.exception.code, "too_long")

    def test_end_to_end_the_server_sees_the_right_method(self):
        srv = Server()
        self.addCleanup(srv.close)
        sender = cp.ChannelSender(nt.TelegramClient(TOKEN, srv.base, session()), "-1001234567890", ORIGIN, MEDIA_BASE)
        for path, method in ((None, "sendMessage"), ("showcase/a.jpg", "sendPhoto"), ("showcase/a.mp4", "sendVideo")):
            done = sender.send({"texts": TEXTS, "link": "/pricing", "media_path": path})
            self.assertEqual(done.outcome, "sent", path)
        self.assertEqual([c["method"] for c in srv.fake.calls], ["sendMessage", "sendPhoto", "sendVideo"])
        self.assertTrue(all(c["payload"]["chat_id"] == "-1001234567890" for c in srv.fake.calls))


class Classification(unittest.TestCase):
    """The same classification as the customer sender, with "may have been posted" made final."""

    def done(self, status, body):
        return cp.to_completion(cp.classify_channel_response(status, body))

    def test_what_telegram_confirms(self):
        c = self.done(200, {"ok": True, "result": {"message_id": 42}})
        self.assertEqual((c.outcome, c.message_id), ("sent", "42"))

    def test_what_telegram_refused_before_posting(self):
        c = self.done(429, {"ok": False, "parameters": {"retry_after": 11}})
        self.assertEqual((c.outcome, c.error_code, c.retry_after), ("retry", "rate_limited", 11))
        for status in (401, 404):
            c = self.done(status, {"ok": False})
            self.assertEqual((c.outcome, c.error_code), ("retry", "not_configured"), status)
        c = self.done(403, {"ok": False, "description": "Forbidden: bot is not a member of the channel chat"})
        self.assertEqual((c.outcome, c.error_code), ("failed", "blocked"))
        c = self.done(400, {"ok": False, "description": "Bad Request: chat not found"})
        self.assertEqual((c.outcome, c.error_code), ("failed", "blocked"))
        for status in (400, 413, 409):
            c = self.done(status, {"ok": False, "description": "Bad Request: wrong HTTP URL specified"})
            self.assertEqual((c.outcome, c.error_code), ("failed", "bad_request"), status)

    def test_a_5xx_is_final_even_though_the_customer_sender_retries_it(self):
        self.assertEqual(nt.classify_response(500, {}).outcome, "retry", "the shared classifier calls a 5xx retryable")
        for status in (500, 502, 503, 504):
            c = self.done(status, {})
            self.assertEqual((c.outcome, c.error_code), ("dead", "http_5xx"), status)

    def test_an_answer_that_does_not_say_whether_it_was_posted_is_final(self):
        for status, body in ((200, {}), (200, {"ok": False}), (200, {"ok": "yes"}), (302, {}), (204, {})):
            c = self.done(status, body)
            self.assertEqual((c.outcome, c.error_code), ("dead", "unconfirmed"), (status, body))

    def test_nothing_ambiguous_is_ever_a_retry(self):
        for status in (200, 204, 302, 500, 502, 503):
            for body in ({}, {"ok": False}, {"ok": False, "parameters": {"retry_after": 5}}):
                c = self.done(status, body)
                if c.outcome == "retry":
                    self.assertEqual(status, 429, (status, body))


class OverTheWire(unittest.TestCase):
    """Real sockets against the fake server: the exception classes the code decides on are the real ones."""

    def sender(self, base, timeout=5.0, chat="@chan_test"):
        return cp.ChannelSender(nt.TelegramClient(TOKEN, base, session(), timeout=timeout), chat, ORIGIN, MEDIA_BASE), chat

    def send(self, base, chat, timeout=5.0):
        sender, _ = self.sender(base, timeout, chat)
        return sender.send({"texts": TEXTS, "link": "/pricing", "media_path": None})

    def test_a_refused_connection_never_left_so_it_may_be_retried(self):
        c = self.send(closed_port_base(), "@chan_test")
        self.assertEqual((c.outcome, c.error_code), ("retry", "network"))

    def test_a_connection_closed_after_the_request_was_written_is_not_retried(self):
        srv = Server()
        self.addCleanup(srv.close)
        c = self.send(srv.base, "-1000000000000")                  # the fake closes without an answer
        self.assertEqual((c.outcome, c.error_code), ("dead", "unconfirmed"))
        self.assertEqual(len(srv.fake.calls), 1, "the request arrived exactly once: nothing retried on its own")

    def test_a_read_timeout_is_not_retried(self):
        srv = Server()
        self.addCleanup(srv.close)
        c = self.send(srv.base, "-1000000000999", timeout=0.3)
        self.assertEqual((c.outcome, c.error_code), ("dead", "unconfirmed"))
        self.assertEqual(len(srv.fake.calls), 1)

    def test_a_5xx_from_the_server_is_not_retried(self):
        srv = Server()
        self.addCleanup(srv.close)
        c = self.send(srv.base, "-1000000000500")
        self.assertEqual((c.outcome, c.error_code), ("dead", "http_5xx"))
        self.assertEqual(len(srv.fake.calls), 1)

    def test_an_unreadable_200_is_not_retried(self):
        srv = Server()
        self.addCleanup(srv.close)
        for chat in ("-1000000000888", "-1000000000777"):
            c = self.send(srv.base, chat)
            self.assertEqual((c.outcome, c.error_code), ("dead", "unconfirmed"), chat)

    def test_each_answer_the_fake_can_give(self):
        srv = Server()
        self.addCleanup(srv.close)
        cases = {
            "-1000000000001": ("sent", None),
            "-1000000000429": ("retry", "rate_limited"),
            "-1000000000401": ("retry", "not_configured"),
            "-1000000000403": ("failed", "blocked"),
            "-1000000000400": ("failed", "blocked"),
        }
        for chat, want in cases.items():
            c = self.send(srv.base, chat)
            self.assertEqual((c.outcome, c.error_code), want, chat)

    def test_only_a_connection_that_never_opened_counts_as_network(self):
        class Boom(requests.exceptions.ConnectionError):
            pass

        class Dropped:
            def __init__(self, exc):
                self.exc = exc

            def post(self, *a, **k):
                raise self.exc

        refused = requests.exceptions.ConnectTimeout("connect timed out")
        reset = requests.exceptions.ConnectionError("Connection aborted.", ConnectionResetError(104, "reset by peer"))
        readto = requests.exceptions.ReadTimeout("read timed out")
        cases = ((refused, ("retry", "network")), (reset, ("dead", "unconfirmed")), (readto, ("dead", "unconfirmed")),
                 (Boom("anything"), ("dead", "unconfirmed")), (RuntimeError("x"), ("dead", "unconfirmed")))
        for exc, want in cases:
            sender = cp.ChannelSender(nt.TelegramClient(TOKEN, "http://127.0.0.1:9", Dropped(exc)), "@chan_test", ORIGIN, MEDIA_BASE)
            c = sender.send({"texts": TEXTS, "link": None, "media_path": None})
            self.assertEqual((c.outcome, c.error_code), want, type(exc).__name__)

    def test_the_token_is_not_in_a_result_whatever_the_exception_says(self):
        class Leaky:
            def post(self, url, **k):
                raise requests.exceptions.ConnectionError(f"HTTPSConnectionPool: Max retries exceeded with url: {url}")

        sender = cp.ChannelSender(nt.TelegramClient(TOKEN, "https://api.telegram.test", Leaky()), "@chan_test", ORIGIN, MEDIA_BASE)
        c = sender.send({"texts": TEXTS, "link": None, "media_path": None})
        self.assertNotIn(TOKEN.split(":")[1], repr(c))
        self.assertNotIn(TOKEN, repr(c))


class Completion(unittest.TestCase):
    def test_only_never_left_codes_are_retry(self):
        retry = {code for code in ("rate_limited", "not_configured", "network", "blocked", "bad_request", "http_5xx", "unconfirmed", "zzz")
                 if cp.to_completion(nt.SendResult("retry", code)).outcome == "retry"}
        self.assertEqual(retry, {"rate_limited", "not_configured", "network"})
        dead = cp.to_completion(nt.SendResult("dead", "weird"))
        self.assertEqual((dead.outcome, dead.error_code), ("dead", "unconfirmed"))


if __name__ == "__main__":
    unittest.main()
