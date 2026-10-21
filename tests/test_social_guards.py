"""Cross-post guards: the TikTok "unaudited app" error has its own reason word, and (below) the pre-upload probe
refuses a file a platform would reject, with a closed reason word and a plain message."""

import json
import unittest

from modules import social_publish as sp
from tests.test_social_publish import Base, FakeHTTP, FakeStore, FakeTokens, Resp, TOKEN

TT = sp.TT_API
UNAUDITED = "unaudited_client_can_only_post_to_private_accounts"


def tt_routes(init):
    return {
        ("POST", f"{TT}/creator_info/query/"): [Resp(200, {
            "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 600},
            "error": {"code": "ok"}})],
        ("POST", f"{TT}/video/init/"): [init],
        ("PUT", "https://open-upload.tiktokapis.com/x"): [Resp(201)],
    }


class TiktokUnaudited(Base):
    def run_init(self, init):
        http = FakeHTTP(tt_routes(init))
        store = FakeStore(video=self.video, http=http)
        out = self.run_req(store, FakeTokens("tiktok"), platform="tiktok", http=http)
        return out, store, http

    def test_the_unaudited_error_is_its_own_reason_word_not_platform_error(self):
        out, store, http = self.run_init(Resp(403, {"error": {"code": UNAUDITED, "message": "body " + TOKEN}}))
        self.assertEqual(out, "failed")
        self.assertEqual(store.final["status"], "failed")
        self.assertEqual(store.final["reason"], "tiktok_unaudited")
        self.assertIn("HTTP 403", store.final["error"])
        self.assertIn("private", store.final["error"])

    def test_the_detail_is_ours_never_the_response_body_or_the_token(self):
        _, store, _ = self.run_init(Resp(403, {"error": {"code": UNAUDITED, "message": "body " + TOKEN}}))
        self.assertNotIn(TOKEN, json.dumps(store.final))
        self.assertNotIn("body", store.final["error"])

    def test_nothing_is_uploaded_after_it(self):
        _, _, http = self.run_init(Resp(403, {"error": {"code": UNAUDITED}}))
        self.assertFalse(any(c[0] == "PUT" for c in http.calls))

    def test_it_is_a_closed_word_the_database_accepts(self):
        self.assertRegex(sp.TT_UNAUDITED_REASON, r"^[a-z0-9_]{1,64}$")

    def test_the_post_is_still_requested_as_private_only(self):
        _, _, http = self.run_init(Resp(403, {"error": {"code": UNAUDITED}}))
        init = next(c for c in http.calls if c[1].endswith("/video/init/"))
        self.assertEqual(init[2]["json"]["post_info"]["privacy_level"], "SELF_ONLY")
        self.assertEqual(sp.TT_PRIVACY, "SELF_ONLY")

    def test_other_tiktok_errors_keep_their_words(self):
        for code, status, reason in (("access_token_invalid", 401, "token_expired"),
                                     ("rate_limit_exceeded", 429, "rate_limited"),
                                     ("url_ownership_unverified", 403, "platform_error"),
                                     ("", 500, "platform_error")):
            out, store, _ = self.run_init(Resp(status, {"error": {"code": code}}))
            self.assertEqual((out, store.final["reason"]), ("failed", reason), code)

    def test_a_malformed_code_cannot_become_the_word(self):
        out, store, _ = self.run_init(Resp(403, {"error": {"code": UNAUDITED.upper()}}))
        self.assertEqual(store.final["reason"], "platform_error")


if __name__ == "__main__":
    unittest.main()
