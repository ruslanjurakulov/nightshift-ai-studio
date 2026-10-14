"""The customer e-mails (migration 0101): the words, the links, the transport and
the worker loop. No mail leaves this process: the transports are fakes or an
injected session, and the real one is only ever built from environment NAMES."""

import json
import re
import tempfile
import unittest
from pathlib import Path

from modules import email_notify as mail
from modules.email_copy import COPY, DEFAULT_LANGUAGE, copy_for
from tools import email_worker as worker

ORIGIN = "https://app.example.test"
TOKEN = "ab" * 32
BRANDS = ("openai", "gemini", "google", "elevenlabs", "kling", "minimax", "higgsfield", "veo", "seedance",
          "leonardo", "flux", "ideogram", "pexels", "vidiq", "anthropic", "claude", "gpt", "wan ")
ROLE_WORDS = re.compile(r"\b(owner|editor|viewer|admin)\b|владелец|редактор|наблюдател|администратор|egasi|tahrirchi|kuzatuvchi", re.I)
PRICE = re.compile(r"[$€£₽]|\busd\b|\bso[ʻ']?m\b|\bрубл", re.I)


def ready_item(**kw):
    item = {
        "user_id": "11111111-1111-1111-1111-111111111111", "email": "ana@example.test", "locale": "en", "token": TOKEN,
        "kind": "video_ready", "ref": "run-abc:held",
        "data": {"video_id": "run-abc", "channel_id": "night-owl", "state": "held"},
        "channel": {"id": "night-owl", "name": "Night Owl", "avatar": "https://yt3.example/a.jpg"},
    }
    item.update(kw)
    return item


def weekly_item(**kw):
    item = {
        "user_id": "11111111-1111-1111-1111-111111111111", "email": "ana@example.test", "locale": "en", "token": TOKEN,
        "kind": "weekly", "ref": "2026-10-14",
        "digest": {"days": 7, "videos_made": 3, "exports_made": 0, "generations_made": 2, "waiting_videos": 1,
                   "waiting_storyboards": 0, "credits_available": 41.5,
                   "channels": [{"id": "night-owl", "name": "Night Owl", "avatar": None, "made": 3,
                                 "waiting_videos": 1, "waiting_storyboards": 0}]},
    }
    item.update(kw)
    return item


class Copy(unittest.TestCase):
    def test_every_language_has_exactly_the_english_keys_and_placeholders(self):
        en = COPY[DEFAULT_LANGUAGE]
        for code, block in COPY.items():
            self.assertEqual(set(block), set(en), f"{code}: keys differ from English")
            for key, line in block.items():
                self.assertEqual(set(re.findall(r"\{(\w+)\}", line)), set(re.findall(r"\{(\w+)\}", en[key])), f"{code}.{key}")
                self.assertTrue(line.strip(), f"{code}.{key} is empty")

    def test_language_codes_are_codes_and_direction_is_data(self):
        for code, block in COPY.items():
            self.assertRegex(code, r"^[a-z]{2,3}$")
            self.assertIn(block["dir"], ("ltr", "rtl"))

    def test_the_three_launch_languages_are_present_and_really_translated(self):
        self.assertTrue({"en", "ru", "uz"} <= set(COPY))
        for key in ("subject_video_plain", "body_video", "reason_ready", "reason_weekly", "unsub_ready"):
            self.assertNotEqual(COPY["ru"][key], COPY["en"][key], key)
            self.assertNotEqual(COPY["uz"][key], COPY["en"][key], key)

    def test_no_provider_brand_no_role_word_no_price(self):
        for code, block in COPY.items():
            for key, line in block.items():
                low = line.lower()
                for brand in BRANDS:
                    self.assertNotIn(brand, low, f"{code}.{key}")
                self.assertIsNone(ROLE_WORDS.search(line), f"{code}.{key}")
                self.assertIsNone(PRICE.search(line), f"{code}.{key}")

    def test_an_unknown_language_is_written_in_english(self):
        self.assertIs(copy_for("xx"), COPY["en"])
        self.assertIs(copy_for(None), COPY["en"])
        self.assertIs(copy_for(""), COPY["en"])
        self.assertIs(copy_for("RU"), COPY["ru"])


class RenderReady(unittest.TestCase):
    def test_a_video_mail_names_the_channel_and_offers_open_and_make_another(self):
        m = mail.render_ready(ready_item(), language="en", origin=ORIGIN)
        self.assertEqual(m.to, "ana@example.test")
        self.assertEqual(m.subject, "Night Owl: your video is ready")
        for body in (m.text, m.html):
            self.assertIn("Night Owl", body)
            self.assertIn(f"{ORIGIN}/night-owl/videos/run-abc", body)
            self.assertIn(f"{ORIGIN}/night-owl/create", body)
        self.assertIn("https://yt3.example/a.jpg", m.html)
        self.assertIn(f"{ORIGIN}/unsubscribe?t={TOKEN}&s=ready&l=en", m.text)

    def test_the_language_is_an_argument_not_a_property_of_the_item(self):
        ru = mail.render_ready(ready_item(locale="en"), language="ru", origin=ORIGIN)
        self.assertEqual(ru.subject, "Night Owl: ваше видео готово")
        self.assertIn('lang="ru"', ru.html)
        self.assertIn("l=ru", ru.text)
        uz = mail.render_ready(ready_item(), language="uz", origin=ORIGIN)
        self.assertTrue(uz.subject.endswith("videongiz tayyor"))
        fallback = mail.render_ready(ready_item(), language="zz", origin=ORIGIN)
        self.assertEqual(fallback.subject, "Night Owl: your video is ready")
        self.assertIn('lang="en"', fallback.html)
        self.assertIn("l=en", fallback.text)

    def test_a_direction_in_the_copy_reaches_the_html_root(self):
        COPY["zz"] = dict(COPY["en"], dir="rtl")
        try:
            m = mail.render_ready(ready_item(), language="zz", origin=ORIGIN)
        finally:
            del COPY["zz"]
        self.assertIn('<html lang="zz" dir="rtl">', m.html)

    def test_one_click_unsubscribe_headers_point_at_the_post_route(self):
        m = mail.render_ready(ready_item(), language="en", origin=ORIGIN)
        self.assertEqual(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
        self.assertEqual(m.headers["List-Unsubscribe"], f"<{ORIGIN}/api/email/unsubscribe?t={TOKEN}&s=ready>")

    def test_no_channel_means_no_channel_block_and_a_plain_subject(self):
        m = mail.render_ready(ready_item(kind="editor_export_done", channel=None, data={}), language="en", origin=ORIGIN)
        self.assertEqual(m.subject, "Your export is ready")
        self.assertIn(f"{ORIGIN}/library", m.text)
        self.assertNotIn("Channel:", m.text)
        self.assertIn(f"{ORIGIN}/create", m.text)

    def test_the_avatar_falls_back_to_the_first_letter_and_never_accepts_http(self):
        for avatar in (None, "http://insecure.example/a.jpg", 'https://x.example/"onerror="x', "javascript:alert(1)"):
            m = mail.render_ready(ready_item(channel={"id": "night-owl", "name": "night owl", "avatar": avatar}),
                                  language="en", origin=ORIGIN)
            self.assertNotIn("<img", m.html)
            self.assertIn(">N</div>", m.html)

    def test_a_hostile_channel_name_is_escaped_and_cannot_inject_a_header(self):
        evil = 'A<script>alert(1)</script>\r\nBcc: x@example.test'
        m = mail.render_ready(ready_item(channel={"id": "night-owl", "name": evil, "avatar": None}),
                              language="en", origin=ORIGIN)
        self.assertNotIn("<script>", m.html)
        self.assertNotRegex(m.subject, r"[\r\n]")

    def test_an_id_that_is_not_a_plain_id_never_reaches_a_link(self):
        m = mail.render_ready(ready_item(data={"video_id": "../../x?y=1", "channel_id": "night-owl"}), language="en", origin=ORIGIN)
        self.assertIn(f"{ORIGIN}/library", m.text)
        self.assertNotIn("../", m.text)

    def test_a_relative_or_missing_origin_is_refused_because_a_link_must_be_absolute(self):
        for origin in ("", "/relative", "javascript:alert(1)", "ftp://x.example"):
            with self.assertRaises(ValueError):
                mail.render_ready(ready_item(), language="en", origin=origin)

    def test_a_malformed_token_is_refused(self):
        with self.assertRaises(ValueError):
            mail.render_ready(ready_item(token="short"), language="en", origin=ORIGIN)

    def test_the_mail_carries_no_title_no_prompt_and_no_price(self):
        m = mail.render_ready(ready_item(), language="en", origin=ORIGIN)
        self.assertIsNone(PRICE.search(m.text))


class RenderWeekly(unittest.TestCase):
    def test_it_states_only_measured_numbers_and_leaves_zero_lines_out(self):
        m = mail.render_weekly(weekly_item(), language="en", origin=ORIGIN)
        self.assertIn("Videos made: 3", m.text)
        self.assertIn("Generations finished: 2", m.text)
        self.assertIn("Videos waiting for your decision: 1", m.text)
        self.assertIn("Credits left: 41.5", m.text)
        self.assertNotIn("Exports finished", m.text)
        self.assertNotIn("Storyboards waiting", m.text)
        self.assertIn("Night Owl: made 3, waiting 1", m.text)

    def test_unknown_credits_are_left_out_never_shown_as_zero(self):
        for credits in (None, "n/a", float("nan"), True):
            d = dict(weekly_item()["digest"], credits_available=credits)
            m = mail.render_weekly(weekly_item(digest=d), language="en", origin=ORIGIN)
            self.assertNotIn("Credits left", m.text)

    def test_a_known_zero_balance_is_shown_as_zero(self):
        d = dict(weekly_item()["digest"], credits_available=0)
        self.assertIn("Credits left: 0", mail.render_weekly(weekly_item(digest=d), language="en", origin=ORIGIN).text)

    def test_numbers_use_the_languages_decimal_separator(self):
        m = mail.render_weekly(weekly_item(), language="ru", origin=ORIGIN)
        self.assertIn("Осталось кредитов: 41,5", m.text)

    def test_weekly_unsubscribe_has_its_own_scope_and_headers(self):
        m = mail.render_weekly(weekly_item(), language="uz", origin=ORIGIN)
        self.assertIn(f"{ORIGIN}/unsubscribe?t={TOKEN}&s=weekly&l=uz", m.text)
        self.assertEqual(m.headers["List-Unsubscribe"], f"<{ORIGIN}/api/email/unsubscribe?t={TOKEN}&s=weekly>")

    def test_a_garbled_digest_still_renders_without_inventing_anything(self):
        m = mail.render_weekly(weekly_item(digest={"days": "x", "videos_made": -4, "channels": "oops"}),
                               language="en", origin=ORIGIN)
        self.assertIn("The last 7 days", m.text)
        self.assertNotIn("Videos made", m.text)


class Transports(unittest.TestCase):
    def test_off_unless_every_name_is_set(self):
        self.assertIsNone(mail.transport_from_env({}))
        self.assertIsNone(mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "resend", "APP_ORIGIN": ORIGIN}))
        self.assertIsNone(mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "resend", "APP_ORIGIN": ORIGIN,
                                                   "RESEND_API_KEY": "k"}))
        self.assertIsNone(mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "fake"}))
        self.assertIsNone(mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "smtp", "APP_ORIGIN": ORIGIN}))
        self.assertIn("RESEND_API_KEY", mail.describe_off({"NIGHTSHIFT_EMAIL_TRANSPORT": "resend", "APP_ORIGIN": ORIGIN}))

    def test_the_real_transport_is_built_from_names_and_the_fake_needs_no_secret(self):
        t = mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "resend", "APP_ORIGIN": ORIGIN,
                                     "RESEND_API_KEY": "k", "NIGHTSHIFT_EMAIL_FROM": "Nightshift <hi@example.test>"})
        self.assertEqual(t.name, "resend")
        f = mail.transport_from_env({"NIGHTSHIFT_EMAIL_TRANSPORT": "fake", "APP_ORIGIN": ORIGIN})
        self.assertEqual(f.name, "fake")

    def test_the_fake_writes_files_and_sends_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            t = mail.FakeTransport(Path(d))
            t.send(mail.render_ready(ready_item(), language="en", origin=ORIGIN))
            files = list(Path(d).glob("*.json"))
            self.assertEqual(len(files), 1)
            self.assertIn("Night Owl", json.loads(files[0].read_text())["subject"])
        self.assertEqual(len(t.sent), 1)

    def _session(self, status=200, raises=None):
        calls = []

        class R:
            status_code = status

        class S:
            def post(self_, url, **kw):
                calls.append((url, kw))
                if raises:
                    raise raises
                return R()

        return S(), calls

    def test_resend_sends_one_json_post_with_the_unsubscribe_headers(self):
        s, calls = self._session()
        t = mail.ResendTransport("secret-key", "Nightshift <hi@example.test>", session=s)
        t.send(mail.render_ready(ready_item(), language="en", origin=ORIGIN))
        (url, kw), = calls
        self.assertEqual(url, "https://api.resend.com/emails")
        self.assertEqual(kw["json"]["to"], ["ana@example.test"])
        self.assertIn("List-Unsubscribe", kw["json"]["headers"])
        self.assertEqual(kw["headers"]["Authorization"], "Bearer secret-key")

    def test_a_provider_refusal_is_permanent_but_trouble_is_retried(self):
        for status, permanent in ((400, True), (403, True), (422, True), (429, False), (500, False), (503, False)):
            s, _ = self._session(status)
            with self.assertRaises(mail.TransportError) as cm:
                mail.ResendTransport("k", "a@b.test", session=s).send(mail.Message("x@y.test", "s", "t", "h"))
            self.assertEqual((cm.exception.code, cm.exception.permanent), (f"http_{status}", permanent))

    def test_a_network_error_is_retried_and_never_quotes_the_request(self):
        s, _ = self._session(raises=RuntimeError("boom https://api.resend.com Bearer secret-key"))
        with self.assertRaises(mail.TransportError) as cm:
            mail.ResendTransport("secret-key", "a@b.test", session=s).send(mail.Message("x@y.test", "s", "t", "h"))
        self.assertFalse(cm.exception.permanent)
        self.assertNotIn("secret", cm.exception.code)
        self.assertIsNone(cm.exception.__cause__)


class FakeStore:
    def __init__(self, ready=(), weekly=(), fail_claim=False):
        self.ready, self.weekly, self.fail_claim = list(ready), list(weekly), fail_claim
        self.done = []

    def claim_ready(self, w, limit=20):
        if self.fail_claim:
            raise worker.StoreError("email_claim_ready", 500)
        out, self.ready = self.ready, []
        return out

    def claim_weekly(self, w, limit=20):
        out, self.weekly = self.weekly, []
        return out

    def complete(self, item, outcome, error=None):
        self.done.append((item["ref"], outcome, error))


class Worker(unittest.TestCase):
    def test_a_pass_sends_what_the_database_handed_over_and_records_each_verdict(self):
        t = mail.FakeTransport()
        store = FakeStore(ready=[ready_item(), ready_item(ref="r2", locale="ru")], weekly=[weekly_item()])
        counts = worker.run_once(store, t, ORIGIN, "w1")
        self.assertEqual(counts["sent"], 3)
        self.assertEqual([d[1] for d in store.done], ["sent"] * 3)
        self.assertEqual([m.subject for m in t.sent][1], "Night Owl: ваше видео готово")

    def test_the_language_comes_from_the_item_with_english_when_it_is_missing_or_unknown(self):
        t = mail.FakeTransport()
        store = FakeStore(ready=[ready_item(locale=None, ref="a"), ready_item(locale="zz", ref="b")])
        worker.run_once(store, t, ORIGIN, "w1")
        self.assertEqual({m.subject for m in t.sent}, {"Night Owl: your video is ready"})

    def test_a_transport_failure_is_retried_or_given_up_by_kind(self):
        class T:
            name = "t"

            def __init__(self, err):
                self.err = err

            def send(self, m):
                raise self.err

        for err, outcome in ((mail.TransportError("http_503"), "retry"), (mail.TransportError("http_422", True), "dead"),
                             (RuntimeError("x"), "retry")):
            store = FakeStore(ready=[ready_item()])
            worker.run_once(store, T(err), ORIGIN, "w1")
            self.assertEqual(store.done[0][1], outcome)

    def test_a_malformed_item_is_given_up_and_the_rest_still_go(self):
        t = mail.FakeTransport()
        store = FakeStore(ready=[ready_item(token="bad", ref="bad"), ready_item(ref="good")])
        worker.run_once(store, t, ORIGIN, "w1")
        self.assertEqual({d[0]: d[1] for d in store.done}, {"bad": "dead", "good": "sent"})
        self.assertEqual(len(t.sent), 1)

    def test_a_failed_claim_is_survived_and_the_other_claim_still_runs(self):
        t = mail.FakeTransport()
        store = FakeStore(weekly=[weekly_item()], fail_claim=True)
        counts = worker.run_once(store, t, ORIGIN, "w1")
        self.assertEqual((counts["claim_errors"], counts["sent"]), (1, 1))

    def test_unconfigured_it_exits_cleanly_and_never_builds_a_store(self):
        def boom():
            raise AssertionError("must not connect")

        self.assertEqual(worker.main(["--once"], env={}, store_factory=boom), 0)

    def test_once_with_the_fake_transport_runs_a_pass_and_stops(self):
        with tempfile.TemporaryDirectory() as d:
            store = FakeStore(ready=[ready_item()])
            env = {"NIGHTSHIFT_EMAIL_TRANSPORT": "fake", "APP_ORIGIN": ORIGIN, "NIGHTSHIFT_EMAIL_FAKE_DIR": d}
            self.assertEqual(worker.main(["--once"], env=env, store_factory=lambda: store), 0)
            self.assertEqual(len(list(Path(d).glob("*.json"))), 1)
        self.assertEqual(store.done[0][1], "sent")

    def test_the_store_calls_only_the_0101_functions_with_the_service_key(self):
        calls = []

        class R:
            status_code = 200

            def json(self):
                return []

        class S:
            def post(self, url, **kw):
                calls.append((url, kw))
                return R()

        st = worker.EmailStore("https://x.supabase.test/", "svc-key", session=S())
        st.claim_ready("w"), st.claim_weekly("w")
        st.complete({"user_id": "u", "kind": "weekly", "ref": "r"}, "sent")
        self.assertEqual([c[0].rsplit("/", 1)[1] for c in calls], ["email_claim_ready", "email_claim_weekly", "email_complete"])
        self.assertTrue(all(c[1]["headers"]["Authorization"] == "Bearer svc-key" for c in calls))

    def test_the_worker_never_logs_an_address_or_a_token(self):
        with self.assertLogs("email_worker", level="WARNING") as cm:
            store = FakeStore(fail_claim=True)
            worker.run_once(store, mail.FakeTransport(), ORIGIN, "w1")
        self.assertNotIn("@", "".join(cm.output))
        self.assertNotIn(TOKEN, "".join(cm.output))


if __name__ == "__main__":
    unittest.main()
