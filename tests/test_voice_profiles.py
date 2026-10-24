"""modules/voice_profiles.py: the pure half of Custom Voice (migration 0117, docs/CUSTOM_VOICE.md).

No test here makes a network call: the HTTP session is a fake that records every request, and the module does not import ``requests``.
The ElevenLabs adapter is UNVERIFIED live (the account is on the free plan); these tests pin what the adapter does with a fake, which is
all that can be said until a plan that allows instant cloning exists.
"""

import hashlib
import re
import unittest
from pathlib import Path
from unittest import mock

from modules import voice_profiles as vp
from modules.voice_profiles import (
    ElevenLabsVoiceProvider,
    PlanRequired,
    ProviderError,
    UnsafeVoiceRequest,
    VoiceProvider,
    check_transcript,
    hash_phrase,
    new_phrase,
    voice_guard,
    voice_name_problem,
)

ROOT = Path(__file__).resolve().parent.parent
OWNER_REF = "0123456789abcdef0123456789abcdef"
PROFILE = "d4d12bb0-c94a-4b87-bb89-e61848757d12"
VOICE = "AbCdEfGhIjKlMnOpQrSt"
KEY = "xi-secret-key-not-real"


# ── screening ────────────────────────────────────────────────────────────────

class NameScreen(unittest.TestCase):
    def test_a_plain_name_passes(self):
        for name in ("My own voice", "Ruslan narrator", "Голос диктора", "Ovozim", "a b", "x" * 60, "  padded  ", "O'Neil",
                     "a_b-c.d", "Apple pie", "voiceover", "soundscape", "action hero", "unfaked"):
            self.assertIsNone(voice_name_problem(name), name)
            voice_guard(name)

    def test_a_name_that_reads_as_a_real_person_is_refused(self):
        for name in ("sounds like Elvis", "Sounds  LIKE  elvis", "soundalike", "sound-alike", "voice of Morgan", "in the style of X",
                     "In The Voice Of Y", "impression of Z", "impersonating", "imitation", "parody", "clone of Anna", "copy of me",
                     "deepfake", "deep fakes", "fake", "real person", "public figure", "celebrity", "politician", "president Bob",
                     "prime minister", "senator", "actor", "actress", "singer", "rapper", "streamer", "youtuber", "influencer",
                     "звучит как Путин", "ПОХОЖ НА кого-то", "голос как у него", "имитация", "пародия", "знаменитость", "президент",
                     "ovozi kabi", "ovoz kabi biri"):
            self.assertEqual(voice_name_problem(name), vp.NAME_REAL_PERSON, name)
            with self.assertRaises(UnsafeVoiceRequest) as cm:
                voice_guard(name)
            self.assertEqual(cm.exception.code, vp.NAME_REAL_PERSON)

    def test_invisible_characters_and_width_tricks_are_not_a_way_round(self):
        for name in ("S​ounds like X", "ｓｏｕｎｄｓ ｌｉｋｅ", "sounds⁠ like", "﻿sounds like"):
            self.assertEqual(voice_name_problem(name), vp.NAME_REAL_PERSON, repr(name))

    def test_length_links_and_characters(self):
        self.assertEqual(voice_name_problem(""), vp.NAME_TOO_SHORT_OR_LONG)
        self.assertEqual(voice_name_problem("x"), vp.NAME_TOO_SHORT_OR_LONG)
        self.assertEqual(voice_name_problem("x" * 61), vp.NAME_TOO_SHORT_OR_LONG)
        self.assertEqual(voice_name_problem(None), vp.NAME_TOO_SHORT_OR_LONG)
        self.assertEqual(voice_name_problem(5), vp.NAME_TOO_SHORT_OR_LONG)
        for name in ("https://x.io", "HTTP://x.io", "www.x.io", "a@b.io", "a/b", "a\\b", "<x>", "a{b}", "a[b]", "a|b", "a`b",
                     "a$b", "a%b", "a^b", "a*b", "a=b", "a+b", "a~b", 'a"b', "a\tb", "a\x7fb"):
            self.assertEqual(voice_name_problem(name), vp.NAME_LINK, repr(name))
        for name in ("1234", "123 456", "---", "!!"):
            self.assertEqual(voice_name_problem(name), vp.NAME_BAD_CHARACTERS, name)

    def test_the_boundaries_of_the_length_rule(self):
        self.assertIsNone(voice_name_problem("ab"))
        self.assertIsNone(voice_name_problem("a" * 60))
        self.assertEqual(voice_name_problem(" " * 3 + "a" + " " * 3), vp.NAME_TOO_SHORT_OR_LONG, "length counts the trimmed text")

    def test_a_description_is_screened_too(self):
        voice_guard("My voice", "A warm narrator voice for travel videos.")
        for text in ("sounds like a famous actor", "a clone of my boss, the president"):
            with self.assertRaises(UnsafeVoiceRequest):
                voice_guard("My voice", text)
        with self.assertRaises(UnsafeVoiceRequest):
            voice_guard("My voice", "see https://example.com")
        with self.assertRaises(UnsafeVoiceRequest):
            voice_guard("My voice", "x" * 501)
        with self.assertRaises(UnsafeVoiceRequest):
            voice_guard("My voice", 7)  # type: ignore[arg-type]

    def test_the_refusal_names_what_to_do(self):
        with self.assertRaises(UnsafeVoiceRequest) as cm:
            voice_guard("voice of the president")
        self.assertIn("OWN voice only", str(cm.exception))

    def test_the_guard_is_documented_as_weak(self):
        doc = (vp.__doc__ or "") + (vp.voice_guard.__doc__ or "")
        self.assertIn("weak", doc.lower())


# ── the per-user reference ───────────────────────────────────────────────────────

class OwnerRef(unittest.TestCase):
    def test_the_shape_is_32_lower_case_hex(self):
        self.assertTrue(vp.is_owner_ref(OWNER_REF))
        for bad in ("", OWNER_REF.upper(), OWNER_REF[:-1], OWNER_REF + "0", "g" * 32, None, 5, OWNER_REF + "\n", " " + OWNER_REF):
            self.assertFalse(vp.is_owner_ref(bad), repr(bad))

    def test_the_provider_name_carries_the_reference_and_round_trips(self):
        name = vp.provider_voice_name(OWNER_REF, PROFILE)
        self.assertEqual(name, f"ns-{OWNER_REF}-d4d12bb0")
        self.assertEqual(vp.parse_provider_voice_name(name), (OWNER_REF, "d4d12bb0"))
        self.assertEqual(vp.provider_voice_name(OWNER_REF, PROFILE.upper()), name, "a profile id is read case-insensitively")

    def test_a_bad_reference_or_profile_id_is_refused(self):
        with self.assertRaises(ValueError):
            vp.provider_voice_name("short", PROFILE)
        with self.assertRaises(ValueError):
            vp.provider_voice_name(OWNER_REF, "not-a-uuid")
        with self.assertRaises(ValueError):
            vp.provider_voice_name(OWNER_REF, PROFILE + "x")

    def test_only_our_names_parse(self):
        for bad in (None, "", "Rachel", f"ns-{OWNER_REF}", f"ns-{OWNER_REF}-d4d12bb", f"ns-{OWNER_REF}-d4d12bb0x", f"xx-{OWNER_REF}-d4d12bb0",
                    f"ns-{OWNER_REF.upper()}-d4d12bb0", f" ns-{OWNER_REF}-d4d12bb0"):
            self.assertIsNone(vp.parse_provider_voice_name(bad), repr(bad))

    def test_the_users_own_words_never_reach_the_provider_name(self):
        self.assertNotIn("narrator", vp.provider_voice_name(OWNER_REF, PROFILE))


# ── the read-aloud phrase ─────────────────────────────────────────────────────────

class Phrase(unittest.TestCase):
    def test_the_word_list_is_128_distinct_plain_words(self):
        self.assertEqual(len(vp.PHRASE_WORDS), 128)
        self.assertEqual(len(set(vp.PHRASE_WORDS)), 128)
        for w in vp.PHRASE_WORDS:
            self.assertRegex(w, r"^[a-z]{3,9}$")

    def test_a_phrase_is_six_distinct_words_from_the_list(self):
        for _ in range(50):
            words = new_phrase().split(" ")
            self.assertEqual(len(words), 6)
            self.assertEqual(len(set(words)), 6)
            self.assertTrue(set(words) <= set(vp.PHRASE_WORDS))

    def test_phrases_differ(self):
        self.assertGreater(len({new_phrase() for _ in range(30)}), 25)

    def test_the_phrase_comes_from_the_system_csprng_never_from_random(self):
        seen = []

        class Rng:
            def sample(self, population, k):
                seen.append((tuple(population), k))
                return list(population)[:k]

        self.assertEqual(new_phrase(Rng()), " ".join(vp.PHRASE_WORDS[:6]))
        self.assertEqual(seen, [(vp.PHRASE_WORDS, 6)])
        with mock.patch.object(vp.secrets, "SystemRandom") as sysrand:
            sysrand.return_value.sample.return_value = ["apple"] * 6
            self.assertEqual(new_phrase(), " ".join(["apple"] * 6))
            sysrand.assert_called_once_with()
        src = (ROOT / "modules" / "voice_profiles.py").read_text(encoding="utf-8")
        self.assertNotRegex(src, r"(?m)^\s*(import random|from random)\b")

    def test_the_length_is_bounded(self):
        for n in (2, 13, 0, -1):
            with self.assertRaises(ValueError):
                new_phrase(length=n)
        self.assertEqual(len(new_phrase(length=3).split()), 3)
        self.assertEqual(len(new_phrase(length=12).split()), 12)

    def test_the_hash_is_the_sha256_of_the_normalised_phrase(self):
        self.assertEqual(hash_phrase("apple river candle"), hashlib.sha256(b"apple river candle").hexdigest())
        self.assertEqual(hash_phrase("  Apple,  RIVER! candle.  "), hash_phrase("apple river candle"))
        self.assertEqual(hash_phrase("Apple​ River"), hash_phrase("apple river"))
        self.assertEqual(hash_phrase("ａｐｐｌｅ river"), hash_phrase("apple river"))
        self.assertNotEqual(hash_phrase("apple river candle"), hash_phrase("apple candle river"))
        self.assertEqual(len(hash_phrase("")), 64)
        self.assertTrue(vp.phrase_matches_hash("apple river", hash_phrase("Apple, river")))
        self.assertFalse(vp.phrase_matches_hash("apple river", hash_phrase("apple rivers")))
        self.assertFalse(vp.phrase_matches_hash("apple river", ""))


class Transcript(unittest.TestCase):
    PHRASE = "apple river candle window garden pencil"

    def ok(self, transcript, **kw):
        r = check_transcript(self.PHRASE, transcript, **kw)
        self.assertTrue(r.passed, (transcript, r))
        self.assertEqual(r.result, "passed")
        return r

    def bad(self, transcript, reason=None, **kw):
        r = check_transcript(self.PHRASE, transcript, **kw)
        self.assertFalse(r.passed, (transcript, r))
        self.assertEqual(r.result, "failed")
        if reason:
            self.assertEqual(r.reason, reason)
        return r

    def test_the_exact_phrase_passes(self):
        r = self.ok(self.PHRASE)
        self.assertEqual((r.reason, r.near_misses), ("ok", 0))

    def test_case_punctuation_and_spacing_do_not_matter(self):
        self.ok("Apple, river; CANDLE... window!  garden\npencil.")
        self.ok("  apple   river candle window garden pencil  ")

    def test_a_few_extra_words_around_it_are_fine(self):
        self.ok("okay so my phrase is apple river candle window garden pencil thank you")
        self.ok("uh " + self.PHRASE)
        self.ok("a b c d e f g h " + self.PHRASE)           # 8 extra: the limit
        self.bad("a b c d e f g h i " + self.PHRASE, "transcript_too_long")  # 9 extra

    def test_the_extra_word_limit_can_be_set(self):
        self.bad("one two " + self.PHRASE, "transcript_too_long", max_extra_words=1)
        self.ok("one " + self.PHRASE, max_extra_words=1)

    def test_a_different_phrase_fails(self):
        self.bad("ocean mirror hammer bridge forest rocket", "phrase_not_found")
        self.bad("apple river candle window garden rocket", "phrase_not_found")      # five of six, the sixth is another word
        self.bad("apple river candle window", "phrase_not_found")                    # a word short
        self.bad("river apple candle window garden pencil", "phrase_not_found")      # two swapped
        self.bad("pencil garden window candle river apple", "phrase_not_found")      # reversed

    def test_the_whole_list_read_aloud_cannot_pass(self):
        self.bad(" ".join(vp.PHRASE_WORDS), "transcript_too_long")

    def test_one_misheard_word_is_tolerated_but_only_one(self):
        r = self.ok("apple rivers candle window garden pencil")
        self.assertEqual((r.reason, r.near_misses), ("near_miss", 1))
        self.ok("apple river candles window garden pencil")      # an extra letter
        self.ok("apple river candl window garden pencil")        # a missing letter
        self.ok("apple river candle windoe garden pencil")       # a substituted letter
        self.bad("apples rivers candle window garden pencil", "phrase_not_found")   # two near misses

    def test_the_near_miss_budget_can_be_closed(self):
        self.bad("apple rivers candle window garden pencil", "phrase_not_found", max_near_misses=0)
        self.ok("apple rivers candle window garden pencil", max_near_misses=2)
        self.ok("apples rivers candle window garden pencil", max_near_misses=2)

    def test_a_short_word_gets_no_slack(self):
        r = check_transcript("echo yarn dog", "ecko yarn dog")
        self.assertTrue(r.passed and r.near_misses == 1, "four letters or more may be a near miss")
        self.assertFalse(check_transcript("echo yarn dog", "echo yarn dig").passed, "a three-letter word must match exactly")
        self.assertFalse(check_transcript("echo yarn dog", "echo yarn do").passed)
        self.assertFalse(check_transcript("echo yarn dog", "echo yarn dogs").passed)

    def test_two_edits_in_one_word_is_not_a_near_miss(self):
        self.bad("apple river cadle window garden pencil".replace("cadle", "cndl"), "phrase_not_found")
        self.bad("apple river candle window gardens pencils", "phrase_not_found")

    def test_empty_and_odd_input_fails_closed(self):
        self.bad("", "empty_transcript")
        self.bad("   ...  ", "empty_transcript")
        self.bad(None, "empty_transcript")
        self.bad(12345, "empty_transcript")
        self.bad(["apple"], "empty_transcript")
        r = check_transcript("", "apple river")
        self.assertEqual((r.passed, r.reason), (False, "no_phrase"))
        self.assertFalse(check_transcript(None, "apple").passed)  # type: ignore[arg-type]

    def test_the_best_match_is_found_wherever_it_sits(self):
        self.ok("apple apple river candle window garden pencil")   # a stumble before it
        self.ok(self.PHRASE + " apple river")
        self.ok("garden pencil " + self.PHRASE)

    def test_the_phrase_must_be_a_run_not_scattered_words(self):
        self.bad("apple x river x candle x window x garden x pencil", "phrase_not_found")


# ── the provider adapter ──────────────────────────────────────────────────────────

class Resp:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class Session:
    """Records every request; answers from a queue, or by (method, path suffix)."""

    def __init__(self, *answers, subscription=None, add=None):
        self.calls = []
        self.answers = list(answers)
        self.subscription = {"can_use_instant_voice_cloning": True} if subscription is None else subscription
        self.add = add

    def _do(self, method, url, **kw):
        self.calls.append((method, url, kw))
        if self.answers:
            a = self.answers.pop(0)
            if isinstance(a, BaseException):
                raise a
            return a
        if url.endswith("/user/subscription"):
            return Resp(200, self.subscription)
        if url.endswith("/voices/add"):
            return self.add or Resp(200, {"voice_id": VOICE})
        return Resp(200, {})

    def get(self, url, **kw):
        return self._do("get", url, **kw)

    def post(self, url, **kw):
        return self._do("post", url, **kw)

    def delete(self, url, **kw):
        return self._do("delete", url, **kw)


def provider(session):
    return ElevenLabsVoiceProvider(session, KEY)


def create(p, **kw):
    args = dict(owner_ref=OWNER_REF, profile_id=PROFILE, sample=b"RIFFxxxx", content_type="audio/webm")
    args.update(kw)
    return p.create_voice(**args)


class Adapter(unittest.TestCase):
    def test_it_is_a_voice_provider(self):
        self.assertIsInstance(provider(Session()), VoiceProvider)
        self.assertEqual(provider(Session()).provider, "elevenlabs")

    def test_the_constructor_refuses_a_missing_key_and_any_other_host(self):
        for key in ("", "   ", None):
            with self.assertRaises(ProviderError) as cm:
                ElevenLabsVoiceProvider(Session(), key)  # type: ignore[arg-type]
            self.assertEqual(cm.exception.code, "not_configured")
        with self.assertRaises(ValueError):
            ElevenLabsVoiceProvider(Session(), KEY, base_url="https://evil.example/v1")
        with self.assertRaises(ValueError):
            ElevenLabsVoiceProvider(Session(), KEY, base_url="http://api.elevenlabs.io/v1")

    def test_a_plan_that_does_not_allow_cloning_refuses_before_anything_is_sent(self):
        for sub in ({"can_use_instant_voice_cloning": False}, {"tier": "free", "voice_limit": 3}, {}, {"can_use_instant_voice_cloning": "true"},
                    {"can_use_instant_voice_cloning": 1}, {"can_use_instant_voice_cloning": None}):
            s = Session(subscription=sub)
            with self.assertRaises(PlanRequired) as cm:
                create(provider(s))
            self.assertEqual(cm.exception.code, "plan_required")
            self.assertIn("ElevenLabs plan", str(cm.exception))
            self.assertIn("can_use_instant_voice_cloning", str(cm.exception))
            self.assertEqual([c[0] for c in s.calls], ["get"], f"only the read-only probe was made: {sub}")
            self.assertTrue(s.calls[0][1].endswith("/user/subscription"))

    def test_an_unknown_plan_is_not_a_yes(self):
        with self.assertRaises(PlanRequired) as cm:
            create(provider(Session(subscription={"tier": "creator"})))
        self.assertIn("unknown", str(cm.exception))

    def test_a_probe_that_fails_stops_the_clone(self):
        for answer in (Resp(401, {"detail": {"status": "invalid_api_key"}}), Resp(500), Resp(200, None), Resp(200, ["x"])):
            s = Session(answer)
            with self.assertRaises(ProviderError):
                create(provider(s))
            self.assertEqual(len(s.calls), 1)

    def test_a_clone_sends_the_documented_request_to_the_one_host(self):
        s = Session()
        out = create(provider(s))
        self.assertEqual((out.provider, out.voice_id), ("elevenlabs", VOICE))
        self.assertEqual([c[0] for c in s.calls], ["get", "post"])
        method, url, kw = s.calls[1]
        self.assertEqual(url, "https://api.elevenlabs.io/v1/voices/add")
        self.assertEqual(kw["headers"]["xi-api-key"], KEY)
        self.assertIs(kw["allow_redirects"], False)
        self.assertGreater(kw["timeout"], 0)
        self.assertEqual(kw["data"]["name"], f"ns-{OWNER_REF}-d4d12bb0")
        self.assertEqual(kw["files"]["files"], ("sample.webm", b"RIFFxxxx", "audio/webm"))
        import json
        labels = json.loads(kw["data"]["labels"])
        self.assertEqual(labels, {"nightshift_owner_ref": OWNER_REF, "nightshift_profile": PROFILE})

    def test_the_key_goes_only_in_the_header_and_only_to_elevenlabs(self):
        s = Session()
        p = provider(s)
        create(p)
        p.delete_voice(VOICE)
        p.get_voice(VOICE)
        for method, url, kw in s.calls:
            self.assertEqual(re.match(r"https://([^/]+)/", url).group(1), "api.elevenlabs.io")
            self.assertEqual([k for k, v in kw["headers"].items() if KEY in str(v)], ["xi-api-key"])
            self.assertNotIn(KEY, url)
            self.assertNotIn(KEY, repr(kw.get("data")))
            self.assertNotIn(KEY, repr(kw.get("files")))
        self.assertNotIn(KEY, repr(p))
        self.assertNotIn(KEY, str(p))

    def test_no_redirect_is_ever_followed(self):
        s = Session()
        p = provider(s)
        create(p)
        p.delete_voice(VOICE)
        p.get_voice(VOICE)
        p.subscription()
        self.assertTrue(all(kw["allow_redirects"] is False for _, _, kw in s.calls))
        s = Session(Resp(302, {}, "moved"))
        with self.assertRaises(ProviderError) as cm:
            provider(s).subscription()
        self.assertEqual(cm.exception.code, "redirect")
        s = Session(Resp(307), Resp(200, {}))
        with self.assertRaises(ProviderError) as cm:
            provider(s).delete_voice(VOICE)
        self.assertEqual(cm.exception.code, "redirect")

    def test_a_bad_request_is_refused_before_the_network(self):
        for kw in (dict(content_type="audio/exe"), dict(content_type="video/mp4"), dict(sample=b""), dict(sample="text"),
                   dict(sample=b"x" * (vp.MAX_SAMPLE_BYTES + 1)), dict(owner_ref="short"), dict(profile_id="nope")):
            s = Session()
            with self.assertRaises((ProviderError, ValueError)):
                create(provider(s), **kw)
            self.assertEqual(s.calls, [], kw.keys())

    def test_every_accepted_audio_type_has_a_file_name(self):
        for mime, name in vp.SAMPLE_TYPES.items():
            s = Session()
            create(provider(s), content_type=mime)
            self.assertEqual(s.calls[1][2]["files"]["files"][0], name)

    def test_a_clone_without_a_usable_voice_id_is_an_error_not_a_guess(self):
        for body in ({}, {"voice_id": ""}, {"voice_id": "short"}, {"voice_id": 5}, {"voice_id": VOICE + "x"}, {"voice_id": "../etc/passwd" + "x" * 8}):
            with self.assertRaises(ProviderError) as cm:
                create(provider(Session(add=Resp(200, body))))
            self.assertEqual(cm.exception.code, "unexpected")
        with self.assertRaises(ProviderError):
            create(provider(Session(add=Resp(200, None))))

    def test_failures_become_closed_codes_and_never_carry_the_response(self):
        secret_text = "SECRET-RESPONSE-BODY"
        cases = [(401, "auth"), (403, "auth"), (404, "not_found"), (422, "rejected"), (429, "quota"), (500, "transient"), (503, "transient"),
                 (400, "unexpected")]
        for status, code in cases:
            s = Session(add=Resp(status, {"detail": {"status": "some_word", "message": secret_text}}, secret_text))
            with self.assertRaises(ProviderError) as cm:
                create(provider(s))
            self.assertEqual((cm.exception.code, cm.exception.status), (code, status))
            self.assertNotIn(secret_text, str(cm.exception))
            self.assertIn(f"HTTP {status}", str(cm.exception))

    def test_a_plan_refusal_from_the_provider_is_named_as_one(self):
        s = Session(add=Resp(401, {"detail": {"status": "can_not_use_instant_voice_cloning"}}))
        with self.assertRaises(ProviderError) as cm:
            create(provider(s))
        self.assertEqual(cm.exception.code, "plan_required")

    def test_only_a_plain_word_from_the_provider_is_quoted(self):
        s = Session(add=Resp(422, {"detail": {"status": "Has Spaces And <html>"}}))
        with self.assertRaises(ProviderError) as cm:
            create(provider(s))
        self.assertNotIn("<html>", str(cm.exception))

    def test_a_network_error_names_its_type_only(self):
        class Boom(Exception):
            pass

        s = Session(Boom("https://api.elevenlabs.io/?key=" + KEY))
        with self.assertRaises(ProviderError) as cm:
            provider(s).subscription()
        self.assertEqual(cm.exception.code, "network")
        self.assertNotIn(KEY, str(cm.exception))
        self.assertIn("Boom", str(cm.exception))

    def test_delete_never_needs_the_plan_and_treats_gone_as_done(self):
        s = Session()
        self.assertTrue(provider(s).delete_voice(VOICE))
        self.assertEqual([(m, u) for m, u, _ in s.calls], [("delete", f"https://api.elevenlabs.io/v1/voices/{VOICE}")])
        self.assertTrue(provider(Session(Resp(404, {}))).delete_voice(VOICE), "already absent is the goal")
        for status in (401, 429, 500):
            with self.assertRaises(ProviderError):
                provider(Session(Resp(status, {}))).delete_voice(VOICE)

    def test_a_voice_id_that_could_change_the_path_is_refused_before_the_network(self):
        for bad in ("../v1/user", VOICE + "/x", "", "short", VOICE[:-1], VOICE + "x", "a" * 20 + "?x=1", None, 5):
            for call in ("delete_voice", "get_voice"):
                s = Session()
                with self.assertRaises(ProviderError) as cm:
                    getattr(provider(s), call)(bad)
                self.assertEqual(cm.exception.code, "rejected")
                self.assertEqual(s.calls, [])

    def test_get_voice(self):
        self.assertIsNone(provider(Session(Resp(404, {}))).get_voice(VOICE))
        self.assertEqual(provider(Session(Resp(200, {"voice_id": VOICE, "name": "x"}))).get_voice(VOICE)["voice_id"], VOICE)
        self.assertIsNone(provider(Session(Resp(200, ["x"]))).get_voice(VOICE))
        with self.assertRaises(ProviderError):
            provider(Session(Resp(500, {}))).get_voice(VOICE)
        with self.assertRaises(ProviderError):
            provider(Session(Resp(200, None))).get_voice(VOICE)

    def test_plan_flag_reader(self):
        self.assertIs(vp.plan_allows_instant_cloning({"can_use_instant_voice_cloning": True}), True)
        self.assertIs(vp.plan_allows_instant_cloning({"can_use_instant_voice_cloning": False}), False)
        for v in (None, {}, [], "x", {"can_use_instant_voice_cloning": "yes"}, {"can_use_instant_voice_cloning": 1}):
            self.assertIsNone(vp.plan_allows_instant_cloning(v))

    def test_the_sample_hash(self):
        self.assertEqual(vp.sample_sha256(b"abc"), hashlib.sha256(b"abc").hexdigest())
        self.assertEqual(vp.sample_sha256(bytearray(b"abc")), hashlib.sha256(b"abc").hexdigest())


class Module(unittest.TestCase):
    def test_it_makes_no_network_call_of_its_own(self):
        src = (ROOT / "modules" / "voice_profiles.py").read_text(encoding="utf-8")
        self.assertNotRegex(src, r"(?m)^\s*(import requests|from requests|import urllib|import http|import socket)")
        self.assertNotIn("os.environ", src, "the key is passed in; the module reads no environment")

    def test_every_request_shape_is_marked_unverified(self):
        self.assertIn("UNVERIFIED", vp.__doc__)
        self.assertIn("UNVERIFIED", vp.ElevenLabsVoiceProvider.__doc__)

    def test_the_documented_endpoints_are_the_only_paths_used(self):
        src = (ROOT / "modules" / "voice_profiles.py").read_text(encoding="utf-8")
        paths = set(re.findall(r'"(/(?:user|voices)[^"]*)"', src)) | set(re.findall(r'f"(/voices/\{voice_id\})"', src))
        self.assertEqual(paths, {"/user/subscription", "/voices/add", "/voices/{voice_id}"})


if __name__ == "__main__":
    unittest.main()
