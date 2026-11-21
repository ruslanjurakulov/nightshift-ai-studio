"""Custom voice: the pure half (migration 0117, docs/CUSTOM_VOICE.md).

A user may clone THEIR OWN voice, and only that user may use it. The database
(supabase/migrations/0117_voice_profiles.sql) is where that is enforced; this
module is what the worker and the tests use around it. It has three parts and
none of them can spend or publish anything by itself:

1. **Screening and identifiers** (no network). ``voice_guard`` refuses a voice
   name or description that reads as a real, identifiable person ("sounds like
   ...", "voice of ...", a title such as "president"), the way
   ``modules.avatar.synthetic_only_guard`` does for faces. It is a KEYWORD
   screen: weak by construction, it stops a casual attempt and nothing more. A
   person who wants to name a clone after a celebrity can misspell it. It is the
   same rule as the SQL function ``voice_name_problem``; a test runs one shared
   corpus through both. ``owner_ref`` helpers check the shape of the per-user
   reference the database mints, and build/parse the provider voice NAME that
   carries it, so a voice found in the provider account traces back to a user.

2. **The read-aloud check** (no network, no Whisper here). ``new_phrase`` draws a
   phrase of random words from a fixed list with ``secrets``; ``hash_phrase``
   is what is stored; ``check_transcript`` compares a Whisper-style transcript
   with the phrase. It proves a live person read a phrase in that recording. It
   does NOT prove the voice is theirs (a recording of someone else's voice can be
   played back and the phrase read over it), so it reduces casual abuse only. v1
   takes a live recording, never an uploaded file, which narrows the gap a little.

3. **A provider adapter skeleton** for ElevenLabs instant voice cloning, against
   an injected HTTP session. EVERY request shape here is "from the public API as
   the planner knew it, UNVERIFIED live": the account is on the FREE plan today,
   which does not allow instant cloning, so nothing in this file has ever been
   run against the real service. ``ElevenLabsVoiceProvider.create_voice`` refuses
   to run, with a message that names the plan requirement, unless the plan probe
   (``GET /v1/user/subscription``, read-only) says ``can_use_instant_voice_cloning``
   is true. An answer without that field is "unknown", and unknown is not true
   (CLAUDE.md rule 5). Deleting a voice never needs the plan: a downgrade must not
   strand a clone the user asked to remove.

The key is sent only in the ``xi-api-key`` header, only to ``api.elevenlabs.io``,
redirects are never followed, the voice id is shape-checked before it goes into a
URL, and no response body is ever copied into an error (a closed code and an HTTP
status are).
"""

from __future__ import annotations

import hashlib
import re
import secrets
import unicodedata
from dataclasses import dataclass
from typing import Mapping, Optional, Protocol, Sequence, runtime_checkable

# ---------------------------------------------------------------------------
# 1. Screening and identifiers
# ---------------------------------------------------------------------------


class UnsafeVoiceRequest(ValueError):
    """A voice name or description that reads as a real, identifiable person (or is malformed).
    ``code`` is one of the closed words below; the SQL function ``voice_name_problem`` returns the same words."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


#: Closed words, shared with ``voice_name_problem`` in the migration.
NAME_TOO_SHORT_OR_LONG = "name_length"
NAME_BAD_CHARACTERS = "name_characters"
NAME_REAL_PERSON = "name_real_person"
NAME_LINK = "name_link"

NAME_MIN, NAME_MAX = 2, 60

# Zero-width and other format characters are removed before matching, so "sounds​like" is "soundslike"
# only if the person typed it so, and not a way round the screen. (SQL: [​-‏⁠﻿].)
_INVISIBLE = re.compile("[​-‏⁠﻿]")
#: Anything that is not a letter or digit separates words for the screen. Letters are a-z, 0-9 and Cyrillic.
_SEPARATORS = re.compile("[^a-z0-9а-яё]+")

# Markers that a voice is meant to be somebody else's. Each is matched against the normalised name
# (lower case, separators collapsed to one space, padded with a space at both ends), so a pattern is a
# whole word or phrase. The SAME list is in the migration (voice_name_problem); a test pins the two together.
# Deliberately conservative where it costs little, and still easy to get round: see the module docstring.
REAL_PERSON_PATTERNS = (
    r" sounds? like ", r" sounding like ", r" sound ?alike ", r" soundalike ", r" sounds? just like ",
    r" voice of ", r" voice like ", r" in the style of ", r" in the voice of ", r" as voiced by ",
    r" as spoken by ", r" impression of ", r" impressions? ", r" impersonat[a-z]* ", r" imitat[a-z]* ",
    r" mimic[a-z]* ", r" parod[a-z]* ", r" (clone|copy|replica|likeness|lookalike|double) of ",
    r" deep ?fakes? ", r" fake ", r" real person ", r" public figure ", r" celebrity ", r" celebrities ",
    r" politician ", r" president ", r" prime minister ", r" senator ", r" actor ", r" actress ",
    r" singer ", r" rapper ", r" streamer ", r" youtuber ", r" influencer ",
    # Russian: "sounds like", "voice of", "similar to", imitation, parody, celebrity, president
    "звучит как", "похож на",
    "голос как у", "имитац",
    "пароди", "знаменит",
    "президент",
    # Uzbek (Latin): "like the voice of", "voice like"
    r" ovozi kabi ", r" ovoz kabi ", r" ovoziga o xshash ",
)
_REAL_PERSON = tuple(re.compile(p) for p in REAL_PERSON_PATTERNS)
#: A link or an address: a voice name is a label, not a place to put a URL.
_LINK = re.compile(r"https?://|www\.|[@/\\<>{}\[\]|`$%^*=+~\"]")
_HAS_LETTER = re.compile(r"[^\W\d_]")


def normalize_name(text: str) -> str:
    """The text the screen reads: NFKC, lower case, invisible characters removed, every run of
    non-letters/digits one space, a space at both ends."""
    t = unicodedata.normalize("NFKC", text or "")
    t = _INVISIBLE.sub("", t).lower()
    return " " + _SEPARATORS.sub(" ", t).strip() + " "


def voice_name_problem(name: object) -> Optional[str]:
    """None for an acceptable voice name, else a closed word. Same rule as ``voice_name_problem`` in 0117."""
    if not isinstance(name, str):
        return NAME_TOO_SHORT_OR_LONG
    stripped = name.strip()
    if not NAME_MIN <= len(stripped) <= NAME_MAX:
        return NAME_TOO_SHORT_OR_LONG
    if _LINK.search(stripped.lower()) or re.search(r"[\x00-\x1f\x7f]", stripped):
        return NAME_LINK
    if not _HAS_LETTER.search(stripped):
        return NAME_BAD_CHARACTERS
    norm = normalize_name(stripped)
    if any(p.search(norm) for p in _REAL_PERSON):
        return NAME_REAL_PERSON
    return None


_PROBLEM_TEXT = {
    NAME_TOO_SHORT_OR_LONG: f"A voice name is {NAME_MIN} to {NAME_MAX} characters.",
    NAME_LINK: "A voice name is a label: no links, addresses or control characters.",
    NAME_BAD_CHARACTERS: "A voice name needs at least one letter.",
    NAME_REAL_PERSON: (
        "This name reads as a real or public person ('sounds like ...', 'voice of ...', a celebrity or an office). "
        "A custom voice is your OWN voice only; give it a plain name of your own."
    ),
}


def voice_guard(name: object, description: str = "") -> None:
    """Refuse a voice name or description that reads as a real, identifiable person. Raises
    ``UnsafeVoiceRequest`` (``.code`` is the closed word); returns None when nothing matched.
    A keyword screen: weak by design (see the module docstring)."""
    problem = voice_name_problem(name)
    if problem is None and description:
        if not isinstance(description, str):
            problem = NAME_BAD_CHARACTERS
        elif len(description) > 500:
            problem = NAME_TOO_SHORT_OR_LONG
        else:
            norm = normalize_name(description)
            if any(p.search(norm) for p in _REAL_PERSON) or _LINK.search(description.lower()):
                problem = NAME_REAL_PERSON
    if problem is not None:
        raise UnsafeVoiceRequest(problem, _PROBLEM_TEXT[problem])


# -- the per-user reference ---------------------------------------------------

#: What the database mints for each user (user_voice_refs.owner_ref): 32 lower-case hex characters.
OWNER_REF_RE = re.compile(r"[0-9a-f]{32}")
_PROFILE_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
#: The provider voice name the worker gives a clone: ``ns-<owner_ref>-<first 8 hex of the profile id>``.
PROVIDER_NAME_RE = re.compile(r"ns-([0-9a-f]{32})-([0-9a-f]{8})")


def is_owner_ref(value: object) -> bool:
    return isinstance(value, str) and OWNER_REF_RE.fullmatch(value) is not None


def provider_voice_name(owner_ref: str, profile_id: str) -> str:
    """The name a clone carries in the provider account. The user's own words (the profile name) are never
    sent to the provider: only this, so a voice found there traces to a user via ``user_voice_refs``."""
    if not is_owner_ref(owner_ref):
        raise ValueError("owner_ref must be 32 lower-case hex characters")
    pid = str(profile_id).lower()
    if _PROFILE_ID_RE.fullmatch(pid) is None:
        raise ValueError("profile_id must be a UUID")
    return f"ns-{owner_ref}-{pid[:8]}"


def parse_provider_voice_name(name: object) -> Optional[tuple]:
    """``(owner_ref, short_profile_id)`` for a name made by ``provider_voice_name``, else None."""
    m = PROVIDER_NAME_RE.fullmatch(name) if isinstance(name, str) else None
    return (m.group(1), m.group(2)) if m else None


# ---------------------------------------------------------------------------
# 2. The read-aloud phrase
# ---------------------------------------------------------------------------

#: 128 short, common, easy-to-tell-apart English words, so a speaker of any of our languages can read them and a
#: transcriber is unlikely to confuse two of them. The SAME list is in the migration (voice_phrase_new);
#: tests/test_voice_profiles_migration.py compares the two. Changing it changes both, in a new migration.
PHRASE_WORDS = (
    "apple", "river", "candle", "window", "garden", "pencil", "silver", "orange", "bridge", "forest",
    "yellow", "button", "mirror", "basket", "blanket", "dragon", "engine", "feather", "guitar", "hammer",
    "island", "jacket", "kitchen", "ladder", "magnet", "needle", "pepper", "rabbit", "saddle", "tunnel",
    "umbrella", "violin", "wallet", "anchor", "bottle", "carpet", "dinner", "eagle", "flower", "ginger",
    "harbor", "insect", "jungle", "kettle", "lantern", "marble", "napkin", "ocean", "pillow", "quiet",
    "rocket", "sunset", "ticket", "valley", "winter", "yogurt", "zipper", "autumn", "breeze", "castle",
    "desert", "elbow", "fabric", "glass", "honey", "icicle", "jelly", "knight", "lemon", "morning",
    "number", "oyster", "planet", "quartz", "ribbon", "spider", "turtle", "unicorn", "velvet", "whistle",
    "yarn", "zebra", "badge", "cherry", "daisy", "ember", "falcon", "grape", "hollow", "ivory",
    "juniper", "kernel", "linen", "meadow", "nectar", "olive", "pebble", "quilt", "raven", "satin",
    "timber", "urchin", "vessel", "walnut", "yonder", "zenith", "acorn", "barrel", "cobweb", "dolphin",
    "echo", "fiddle", "gravel", "hazel", "iguana", "jigsaw", "koala", "locket", "mango", "nutmeg",
    "orchid", "parrot", "radish", "sparrow", "thimble", "walrus", "pocket", "tomato",
)
PHRASE_LENGTH = 6
assert len(PHRASE_WORDS) == 128 and len(set(PHRASE_WORDS)) == 128, "128 distinct words: 7 bits each"

#: How many words a transcript may carry beyond the phrase ("okay, my phrase is ...", a breath, a repeat).
MAX_EXTRA_WORDS = 8


def new_phrase(rng: Optional[secrets.SystemRandom] = None, length: int = PHRASE_LENGTH) -> str:
    """``length`` distinct random words from PHRASE_WORDS, space-separated. ``secrets`` (the system CSPRNG), never
    ``random``: the phrase must not be predictable before the request that issues it."""
    r = rng or secrets.SystemRandom()
    if not 3 <= length <= 12:
        raise ValueError("a phrase is 3 to 12 words")
    return " ".join(r.sample(PHRASE_WORDS, length))


_TOKEN_SPLIT = re.compile(r"[^a-z0-9а-яё]+")


def phrase_tokens(text: object) -> list:
    """Words of a phrase or transcript: NFKC, lower case, punctuation and extra space ignored."""
    if not isinstance(text, str):
        return []
    t = _INVISIBLE.sub("", unicodedata.normalize("NFKC", text)).lower()
    return [w for w in _TOKEN_SPLIT.split(t) if w]


def normalize_phrase(text: object) -> str:
    return " ".join(phrase_tokens(text))


def hash_phrase(phrase: str) -> str:
    """SHA-256 (hex) of the normalised phrase: what voice_consents.verification_phrase_hash stores. The database
    computes the same value (voice_phrase_hash) from the phrase it issues."""
    return hashlib.sha256(normalize_phrase(phrase).encode("utf-8")).hexdigest()


def phrase_matches_hash(phrase: str, expected_hash: str) -> bool:
    return secrets.compare_digest(hash_phrase(phrase), str(expected_hash or ""))


@dataclass(frozen=True)
class PhraseCheck:
    passed: bool
    #: 'passed' | 'failed' (voice_consents.verification_result) and a closed reason for the log.
    result: str
    reason: str
    near_misses: int = 0


def _within_one_edit(a: str, b: str) -> bool:
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long_[i]:
        i += 1
    return short[i:] == long_[i + 1:]


def check_transcript(phrase: str, transcript: object, *, max_near_misses: int = 1,
                     max_extra_words: int = MAX_EXTRA_WORDS) -> PhraseCheck:
    """Did the person read THIS phrase? Pure: the transcript comes from Whisper (not called here).

    Passes when the phrase's words appear as one run, in order, in the transcript, ignoring case, punctuation
    and spacing, with at most ``max_extra_words`` other words around it. ONE word may be a near miss (a single
    letter wrong, added or missing, and only in a word of 4+ letters) because a transcriber mishears single
    words; two or more, a swapped order, a word missing or a different phrase fail. An empty transcript fails.
    A transcript much longer than the phrase fails, so reading the whole word list cannot pass."""
    want = phrase_tokens(phrase)
    got = phrase_tokens(transcript)
    if not want:
        return PhraseCheck(False, "failed", "no_phrase")
    if not got:
        return PhraseCheck(False, "failed", "empty_transcript")
    if len(got) > len(want) + max_extra_words:
        return PhraseCheck(False, "failed", "transcript_too_long")
    best: Optional[int] = None
    for start in range(0, len(got) - len(want) + 1):
        misses = 0
        for w, g in zip(want, got[start:start + len(want)]):
            if w == g:
                continue
            if len(w) >= 4 and len(g) >= 4 and _within_one_edit(w, g):
                misses += 1
                continue
            misses = max_near_misses + 1
            break
        if misses <= max_near_misses and (best is None or misses < best):
            best = misses
            if misses == 0:
                break
    if best is None:
        return PhraseCheck(False, "failed", "phrase_not_found")
    return PhraseCheck(True, "passed", "ok" if best == 0 else "near_miss", near_misses=best)


# ---------------------------------------------------------------------------
# 3. The provider adapter (UNVERIFIED live)
# ---------------------------------------------------------------------------

#: The only host the key is ever sent to, and the base every request is built from.
ELEVENLABS_HOST = "api.elevenlabs.io"
ELEVENLABS_BASE = f"https://{ELEVENLABS_HOST}/v1"
#: ElevenLabs voice ids are 20 letters and digits (CLAUDE.md "Known ceilings").
VOICE_ID_RE = re.compile(r"[A-Za-z0-9]{20}")
#: The sample the worker sends: the bucket's own limit (50 MB).
MAX_SAMPLE_BYTES = 50 * 1024 * 1024
#: A closed list of the audio types the bucket accepts (0117), and the file name each is sent under.
SAMPLE_TYPES = {
    "audio/webm": "sample.webm", "audio/ogg": "sample.ogg", "audio/mpeg": "sample.mp3",
    "audio/mp4": "sample.m4a", "audio/wav": "sample.wav", "audio/x-wav": "sample.wav",
    "audio/aac": "sample.aac", "audio/flac": "sample.flac",
}
REQUEST_TIMEOUT_S = 60

PLAN_FLAG = "can_use_instant_voice_cloning"


class ProviderError(RuntimeError):
    """A provider call that did not work. ``code`` is a closed word; the message never carries a response body."""

    def __init__(self, code: str, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status


class PlanRequired(ProviderError):
    """The ElevenLabs plan does not (or is not known to) allow instant voice cloning. Nothing was sent.
    ``state`` is False when the subscription SAID so (the documented free plan) and None when it said nothing: the second is
    an unverified answer, not a verdict, and a worker must not treat it as the first."""

    def __init__(self, message: str, state: Optional[bool] = None):
        super().__init__("plan_required", message)
        self.state = state


@dataclass(frozen=True)
class ProviderVoice:
    provider: str
    voice_id: str


@dataclass(frozen=True)
class ProfileVoices:
    """Voices in the provider account that carry one profile's name: ``owned`` are labelled with that profile's FULL id and its
    owner reference (made by this system for it); ``conflicting`` carry the name but a different or missing label."""
    owned: tuple = ()
    conflicting: tuple = ()


@runtime_checkable
class VoiceProvider(Protocol):
    """What the worker needs from a voice provider. The worker (a later slice) is the only caller."""

    provider: str

    def create_voice(self, *, owner_ref: str, profile_id: str, sample: bytes, content_type: str) -> ProviderVoice: ...

    def delete_voice(self, voice_id: str) -> bool: ...

    def get_voice(self, voice_id: str) -> Optional[Mapping]: ...

    def ensure_plan(self) -> None: ...

    def find_voices_for_profile(self, owner_ref: str, profile_id: str) -> "ProfileVoices": ...


def plan_allows_instant_cloning(subscription: object) -> Optional[bool]:
    """True/False from the subscription answer, or None when the answer does not say (unknown is not true)."""
    if not isinstance(subscription, Mapping) or PLAN_FLAG not in subscription:
        return None
    value = subscription[PLAN_FLAG]
    return value if isinstance(value, bool) else None


_PLAN_NEEDED = (
    "Instant voice cloning needs an ElevenLabs plan that allows it (the Starter plan or above, as the planner knew "
    "it; check the account's plan page). The account's own subscription says {state}. Upgrade the plan, run the "
    "'ElevenLabs plan probe' workflow to confirm can_use_instant_voice_cloning is true, then retry. Nothing was sent "
    "to the clone endpoint and no voice was created."
)


class ElevenLabsVoiceProvider:
    """ElevenLabs instant voice cloning through an injected ``requests``-style session.

    EVERY request below is from the public API as the planner knew it, UNVERIFIED live (the account is on the
    free plan, which cannot clone):

    * ``GET    /v1/user/subscription``      read-only plan probe (this one is already used by the repo)
    * ``POST   /v1/voices/add``             multipart: ``name``, ``files`` (the sample), ``labels`` (JSON text)
    * ``DELETE /v1/voices/{voice_id}``
    * ``GET    /v1/voices/{voice_id}``
    * ``GET    /v1/voices``                 the account's voices, read only to find a profile's clone by name and labels (below)

    ``create_voice`` calls the plan probe first and refuses (``PlanRequired``) unless it reads true.
    """

    provider = "elevenlabs"

    def __init__(self, session, api_key: str, *, base_url: str = ELEVENLABS_BASE):
        if base_url != ELEVENLABS_BASE:
            raise ValueError("the ElevenLabs adapter talks to https://api.elevenlabs.io/v1 only")
        key = str(api_key or "").strip()
        if not key:
            raise ProviderError("not_configured", "ELEVENLABS_API_KEY is empty: no voice request was made.")
        self._session = session
        self._key = key

    def __repr__(self) -> str:  # never show the key
        return "ElevenLabsVoiceProvider(<key hidden>)"

    # -- one request ----------------------------------------------------------
    def _request(self, method: str, path: str, what: str, **kw):
        url = f"{ELEVENLABS_BASE}{path}"
        headers = {"xi-api-key": self._key, "Accept": "application/json"}
        try:
            resp = getattr(self._session, method)(url, headers=headers, timeout=REQUEST_TIMEOUT_S,
                                                  allow_redirects=False, **kw)
        except Exception as e:  # network, TLS, timeout: the type name only, never the text
            raise ProviderError("network", f"ElevenLabs {what} failed ({type(e).__name__}).") from e
        status = getattr(resp, "status_code", None)
        if isinstance(status, int) and 300 <= status < 400:
            # A redirect would carry the key to a host nobody checked.
            raise ProviderError("redirect", f"ElevenLabs {what} answered a redirect (HTTP {status}); not followed.", status)
        return resp

    @staticmethod
    def _failure(resp, what: str) -> ProviderError:
        status = getattr(resp, "status_code", None)
        word = ""
        try:
            detail = resp.json().get("detail")
            raw = detail.get("status") if isinstance(detail, Mapping) else None
            if isinstance(raw, str) and re.fullmatch(r"[a-z_]{1,60}", raw):
                word = raw
        except Exception:
            pass
        if status in (401, 403):
            code = "plan_required" if word in ("can_not_use_instant_voice_cloning", "voice_cloning_not_allowed") else "auth"
        elif status == 404:
            code = "not_found"
        elif status == 422:
            code = "rejected"
        elif status == 429:
            code = "quota"
        elif isinstance(status, int) and status >= 500:
            code = "transient"
        else:
            code = "unexpected"
        suffix = f" ({word})" if word else ""
        return ProviderError(code, f"ElevenLabs {what} failed (HTTP {status}){suffix}.", status)

    # -- the plan probe -------------------------------------------------------
    def subscription(self) -> Mapping:
        resp = self._request("get", "/user/subscription", "plan probe")
        if getattr(resp, "status_code", None) != 200:
            raise self._failure(resp, "plan probe")
        try:
            data = resp.json()
        except Exception as e:
            raise ProviderError("unexpected", "ElevenLabs plan probe answered something that is not JSON.") from e
        if not isinstance(data, Mapping):
            raise ProviderError("unexpected", "ElevenLabs plan probe answered something that is not an object.")
        return data

    def ensure_plan(self) -> None:
        """Raise ``PlanRequired`` unless the plan probe says instant cloning is allowed."""
        flag = plan_allows_instant_cloning(self.subscription())
        if flag is not True:
            raise PlanRequired(_PLAN_NEEDED.format(
                state="it is not allowed" if flag is False else "nothing about it (unknown is treated as not allowed)"), flag)

    # -- the three calls --------------------------------------------------------
    def create_voice(self, *, owner_ref: str, profile_id: str, sample: bytes, content_type: str) -> ProviderVoice:
        name = provider_voice_name(owner_ref, profile_id)  # validates both
        if content_type not in SAMPLE_TYPES:
            raise ProviderError("rejected", "The sample is not one of the accepted audio types; nothing was sent.")
        if not isinstance(sample, (bytes, bytearray)) or not 0 < len(sample) <= MAX_SAMPLE_BYTES:
            raise ProviderError("rejected", "The sample is empty or over 50 MB; nothing was sent.")
        self.ensure_plan()
        labels = '{"nightshift_owner_ref": "%s", "nightshift_profile": "%s"}' % (owner_ref, str(profile_id).lower())
        resp = self._request(
            "post", "/voices/add", "voice clone",
            data={"name": name, "labels": labels},
            files={"files": (SAMPLE_TYPES[content_type], bytes(sample), content_type)},
        )
        if getattr(resp, "status_code", None) != 200:
            raise self._failure(resp, "voice clone")
        try:
            voice_id = resp.json().get("voice_id")
        except Exception:
            voice_id = None
        if not isinstance(voice_id, str) or VOICE_ID_RE.fullmatch(voice_id) is None:
            # The clone may exist at the provider with no id we can use: the worker must treat this as "maybe
            # created" and look the voice up by its name, never retry blindly.
            raise ProviderError("unexpected", "ElevenLabs created a voice but returned no usable voice id.")
        return ProviderVoice(self.provider, voice_id)

    def delete_voice(self, voice_id: str) -> bool:
        """True when the voice is gone (deleted now, or already absent). Never needs the plan."""
        self._check_voice_id(voice_id)
        resp = self._request("delete", f"/voices/{voice_id}", "voice delete")
        status = getattr(resp, "status_code", None)
        if status == 200 or status == 404:
            return True
        raise self._failure(resp, "voice delete")

    def get_voice(self, voice_id: str) -> Optional[Mapping]:
        self._check_voice_id(voice_id)
        resp = self._request("get", f"/voices/{voice_id}", "voice lookup")
        status = getattr(resp, "status_code", None)
        if status == 404:
            return None
        if status != 200:
            raise self._failure(resp, "voice lookup")
        try:
            data = resp.json()
        except Exception as e:
            raise ProviderError("unexpected", "ElevenLabs voice lookup answered something that is not JSON.") from e
        return data if isinstance(data, Mapping) else None

    def find_voices_for_profile(self, owner_ref: str, profile_id: str) -> ProfileVoices:
        """The voices in the account named for this profile (``provider_voice_name``), split by their LABELS: ``owned`` carry
        ``nightshift_profile`` equal to the profile's full id and ``nightshift_owner_ref`` equal to the owner's reference.
        A voice with the name but another label (or none) is ``conflicting`` and is never adopted or deleted by the caller. This is
        what makes a retry safe: a create that timed out, or whose answer had no usable id, may have made the voice, and the next
        attempt must adopt it, never make a second one. Read only, never needs the plan. The list is read first; a voice whose
        listing carries no labels is read by id. UNVERIFIED live like the rest: the list endpoint and its ``voices`` / ``name`` /
        ``voice_id`` / ``labels`` fields are as the planner knew them."""
        name = provider_voice_name(owner_ref, profile_id)  # validates both
        resp = self._request("get", "/voices", "voice list")
        if getattr(resp, "status_code", None) != 200:
            raise self._failure(resp, "voice list")
        try:
            voices = resp.json().get("voices")
        except Exception as e:
            raise ProviderError("unexpected", "ElevenLabs voice list answered something that is not JSON.") from e
        if not isinstance(voices, list):
            raise ProviderError("unexpected", "ElevenLabs voice list answered something that is not a list of voices.")
        owned, conflicting = [], []
        for v in voices:
            if not (isinstance(v, Mapping) and v.get("name") == name and isinstance(v.get("voice_id"), str)
                    and VOICE_ID_RE.fullmatch(v["voice_id"]) is not None):
                continue
            labels = v.get("labels")
            if not isinstance(labels, Mapping):
                detail = self.get_voice(v["voice_id"])
                labels = detail.get("labels") if isinstance(detail, Mapping) else None
            ours = (isinstance(labels, Mapping) and labels.get("nightshift_profile") == str(profile_id).lower()
                    and labels.get("nightshift_owner_ref") == owner_ref)
            (owned if ours else conflicting).append(v["voice_id"])
        return ProfileVoices(tuple(owned), tuple(conflicting))

    @staticmethod
    def _check_voice_id(voice_id: object) -> None:
        if not isinstance(voice_id, str) or VOICE_ID_RE.fullmatch(voice_id) is None:
            raise ProviderError("rejected", "A voice id is 20 letters and digits; nothing was sent.")


def sample_sha256(sample: bytes) -> str:
    """The hash stored with the consent record (the sample itself may be deleted right after the clone)."""
    return hashlib.sha256(bytes(sample)).hexdigest()
