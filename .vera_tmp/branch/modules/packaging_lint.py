"""Packaging lint: does the title and the thumbnail text work as ONE pairing? Advisory only.

A viewer meets a title and a thumbnail together, in a feed, cut to whatever fits. Two things
go wrong that nothing else here looks at: the title is cut before its point (the publish gate
only rejects > 100 characters), and the thumbnail text repeats the title instead of adding to
it. This module reports both, plus a few cheap shape checks, so a human can read them next to
the publish score.

What this is NOT
----------------
* It is NOT the publish gate. Nothing here blocks, permits, rewrites or ships anything; the
  caller emits the result as an event and carries on (CLAUDE.md rule 2).
* It is NOT calibrated. The thresholds are the commonly reported YouTube cut points and a
  thumbnail budget chosen by hand; none was fitted to this channel's CTR. The result says so
  (``basis: heuristic``, ``calibrated: false``).
* It never turns an unknown into a pass (rule 5). Every check is ``ok``, ``issue`` or
  ``not_checked``, with a reason from a closed vocabulary:
    - no overlay text -> overlay checks are ``not_checked: no_overlay``, never ``ok`` and never
      a count of 0;
    - checks that read WORDS (here: whether the overlay repeats the title, which needs a
      function-word list) only exist for English. For any other language, or none, they are
      ``not_checked: language``. Checks that only read characters (length, case, a digit's
      position) are language independent and always run.

Pure: stdlib only, no I/O, no network, never raises, deterministic. The result carries counts
and closed words only; the title and overlay text are never copied into it.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Optional

# Status of a check.
OK = "ok"
ISSUE = "issue"
NOT_CHECKED = "not_checked"
STATUSES = (OK, ISSUE, NOT_CHECKED)

# Checks, in the order they are reported.
TITLE_HARD_LIMIT = "title_hard_limit"
TITLE_DESKTOP = "title_desktop_cut"
TITLE_MOBILE = "title_mobile_cut"
FIGURE_POSITION = "figure_position"
TITLE_CAPS = "title_caps"
OVERLAY_LENGTH = "overlay_length"
OVERLAY_ECHO = "overlay_echo"
ALL_CHECKS = (TITLE_HARD_LIMIT, TITLE_DESKTOP, TITLE_MOBILE, FIGURE_POSITION,
              TITLE_CAPS, OVERLAY_LENGTH, OVERLAY_ECHO)
#: The checks that read words and therefore need a language that is handled.
WORD_CHECKS = (OVERLAY_ECHO,)

# Reasons: a closed vocabulary, so an event consumer can switch on them and no input text can
# ride along in one.
R_NO_TITLE = "no_title"
R_NO_OVERLAY = "no_overlay"
R_LANGUAGE = "language"
R_NO_FIGURE = "no_figure"
R_NO_CASED_LETTERS = "no_cased_letters"
R_NO_CONTENT_WORDS = "no_content_words"
R_ERROR = "error"
R_WITHIN_LIMIT = "within_limit"
R_OVER_LIMIT = "over_limit"
R_FITS_DESKTOP = "fits_desktop"
R_CUT_DESKTOP = "cut_desktop"
R_FITS_MOBILE = "fits_mobile"
R_CUT_MOBILE = "cut_mobile"
R_FIGURE_VISIBLE = "figure_visible"
R_FIGURE_CUT_MOBILE = "figure_cut_mobile"
R_FIGURE_CUT_DESKTOP = "figure_cut_desktop"
R_CAPS_OK = "caps_ok"
R_TOO_MANY_CAPS = "too_many_caps"
R_WITHIN_BUDGET = "within_budget"
R_TOO_MANY_WORDS = "too_many_words"
R_TOO_LONG = "too_long"
R_ADDS_WORDS = "adds_words"
R_REPEATS_TITLE = "repeats_title"
REASONS = frozenset({
    R_NO_TITLE, R_NO_OVERLAY, R_LANGUAGE, R_NO_FIGURE, R_NO_CASED_LETTERS, R_NO_CONTENT_WORDS,
    R_ERROR, R_WITHIN_LIMIT, R_OVER_LIMIT, R_FITS_DESKTOP, R_CUT_DESKTOP, R_FITS_MOBILE,
    R_CUT_MOBILE, R_FIGURE_VISIBLE, R_FIGURE_CUT_MOBILE, R_FIGURE_CUT_DESKTOP, R_CAPS_OK,
    R_TOO_MANY_CAPS, R_WITHIN_BUDGET, R_TOO_MANY_WORDS, R_TOO_LONG, R_ADDS_WORDS, R_REPEATS_TITLE,
})

# How many glyphs of a title a viewer sees before the "..." (approximate: the real cut is by
# pixel width, so a title of capitals or wide letters is cut earlier).
MOBILE_VISIBLE_CHARS = 40
DESKTOP_VISIBLE_CHARS = 60
# YouTube refuses a longer title. Counted like the publish gate counts it (len(), code points),
# not in glyphs, so the advice and the gate agree on what is over.
HARD_LIMIT_CHARS = 100
#: More than this many all-caps words reads as shouting.
MAX_CAPS_WORDS = 2
#: A word needs this many cased letters to count as all-caps, so "US" and "TV" do not.
MIN_CAPS_LETTERS = 3
#: What fits on a thumbnail at feed size. Chosen by hand, not fitted to any CTR.
MAX_OVERLAY_WORDS = 4
MAX_OVERLAY_CHARS = 28
#: The overlay "repeats" the title when at least this share of its content words is in the title.
ECHO_SHARE = 0.5
#: Input is cut to this many characters before any work, so a hostile megabyte title costs the
#: same as a long one. Far above every limit that matters, so it never changes a verdict.
MAX_INPUT_CHARS = 2000

WORDS_RUN = "run"
WORDS_LANGUAGE = "language"


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    reason: str


@dataclass(frozen=True)
class LintResult:
    checks: tuple
    #: ``run`` when the word checks could read the language, ``language`` when they were gated.
    word_checks: str
    #: None means unknown (no title / no overlay), never 0.
    title_graphemes: Optional[int]
    title_chars: Optional[int]
    overlay_graphemes: Optional[int]
    overlay_words: Optional[int]
    truncated: bool = False

    def get(self, name: str) -> Check:
        for c in self.checks:
            if c.name == name:
                return c
        raise KeyError(name)

    def counts(self) -> dict:
        return {s: sum(1 for c in self.checks if c.status == s) for s in STATUSES}

    def to_metadata(self) -> dict:
        """Event metadata: closed words and numbers only, never the title or overlay text."""
        return {
            "advisory": True,
            "basis": "heuristic",
            "calibrated": False,
            "word_checks": self.word_checks,
            "checks": {c.name: {"status": c.status, "reason": c.reason} for c in self.checks},
            "counts": self.counts(),
            "title_graphemes": self.title_graphemes,
            "title_chars": self.title_chars,
            "overlay_graphemes": self.overlay_graphemes,
            "overlay_words": self.overlay_words,
            "input_truncated": self.truncated,
            "thresholds": {
                "title_mobile": MOBILE_VISIBLE_CHARS,
                "title_desktop": DESKTOP_VISIBLE_CHARS,
                "title_hard_limit": HARD_LIMIT_CHARS,
                "max_caps_words": MAX_CAPS_WORDS,
                "overlay_words": MAX_OVERLAY_WORDS,
                "overlay_chars": MAX_OVERLAY_CHARS,
            },
        }


# ── Counting what a viewer sees ──────────────────────────────────────────────────────────

_EMOJI_MODIFIERS = range(0x1F3FB, 0x1F400)
_REGIONAL_INDICATORS = range(0x1F1E6, 0x1F200)
_WHITESPACE_CONTROLS = {"\t", "\n", "\r", "\x0b", "\x0c", "\x85"}


def _joins_previous(ch: str, category: str) -> bool:
    """True when ``ch`` is drawn on top of / fused into the glyph before it, so it adds no
    visible character: combining marks, joiners and other zero-width format characters,
    variation selectors and emoji skin tones."""
    # Variation selectors and tag characters are Mn / Cf, so the categories already cover them;
    # skin tones are the one fusing family filed as plain symbols.
    return category in ("Mn", "Me", "Mc", "Cf") or ord(ch) in _EMOJI_MODIFIERS


def _graphemes(text: str) -> list:
    """Split ``text`` into the glyphs a viewer counts. Approximates Unicode extended grapheme
    clusters with the stdlib alone: a base plus its combining marks / variation selectors /
    skin tones, a ZWJ-joined emoji sequence, a flag (two regional indicators), a keycap. A
    joiner only fuses with a following emoji-like symbol, so ZWJ threaded between letters
    cannot shrink the count."""
    out: list = []
    join_next = False
    for ch in text:
        cat = unicodedata.category(ch)
        if out and (_joins_previous(ch, cat) or (join_next and cat == "So")):
            out[-1] += ch
            join_next = ch == "\u200d"
            continue
        if cat == "Cf":
            continue  # a zero-width character with nothing to attach to is invisible
        if (ord(ch) in _REGIONAL_INDICATORS and out and len(out[-1]) % 2 == 1
                and all(ord(c) in _REGIONAL_INDICATORS for c in out[-1])):
            out[-1] += ch
            join_next = False
            continue
        out.append(ch)
        join_next = False
    return out


def grapheme_count(text) -> int:
    """Visible length of ``text`` (0 for anything that is not a string)."""
    if not isinstance(text, str):
        return 0
    try:
        return len(_graphemes(_normalise(text)[0]))
    except Exception:
        return 0


def _normalise(value: str) -> tuple:
    """Clean text for measuring: no control characters (they are not glyphs), whitespace runs
    collapsed, NFC. Returns (text, truncated)."""
    value = value.strip()
    truncated = len(value) > MAX_INPUT_CHARS
    value = value[:MAX_INPUT_CHARS]
    try:
        value = unicodedata.normalize("NFC", value)
    except Exception:
        pass
    chars = []
    for ch in value:
        if ch in _WHITESPACE_CONTROLS:
            chars.append(" ")
        elif unicodedata.category(ch) == "Cc":
            continue
        else:
            chars.append(ch)
    text = re.sub(r"\s+", " ", "".join(chars)).strip()
    return text, truncated


@dataclass(frozen=True)
class _Text:
    text: str
    glyphs: tuple
    truncated: bool


def _prepare(value) -> Optional[_Text]:
    """Measurable text, or None when there is nothing a viewer could see (missing, not a
    string, only whitespace / control / zero-width characters)."""
    if not isinstance(value, str):
        return None
    text, truncated = _normalise(value)
    glyphs = tuple(_graphemes(text))
    if not glyphs:
        return None
    return _Text(text=text, glyphs=glyphs, truncated=truncated)


# ── Language ─────────────────────────────────────────────────────────────────────────────

def _is_english(language) -> bool:
    """The only language the word checks can read. Anything else, or nothing, is gated: an
    unknown language must not borrow English function words and call that a pass."""
    if not isinstance(language, str):
        return False
    text = language.strip().casefold()
    return text in ("en", "eng", "english") or text.startswith(("english", "en-", "en_"))


# Function words that carry no pairing information. Written for this module; English only.
_STOPWORDS = frozenset(
    "a an the of in on at to for from by with about and or but nor so as is are was were be been "
    "being it its this that these those why how what when where who which do does did has have "
    "had not no you your we our they their he she his her i my me than then into over up out if "
    "can will would just vs".split()
)
_WORD = re.compile(r"[^\W_]+(?:['\u2019\u02bc][^\W_]+)*")


def _content_words(text: str) -> frozenset:
    words = set()
    for token in _WORD.findall(text.casefold()):
        for suffix in ("'s", "\u2019s", "\u02bcs"):
            if token.endswith(suffix):
                token = token[: -len(suffix)]
        if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
            token = token[:-1]  # "romans" and "roman" are the same word to a viewer
        if token in _STOPWORDS or (len(token) < 2 and not token.isdigit()):
            continue
        words.add(token)
    return frozenset(words)


# ── Checks ───────────────────────────────────────────────────────────────────────────────

def _is_caps_word(word: str) -> bool:
    cased = [c for c in word if c.isalpha() and (c.isupper() or c.islower())]
    return len(cased) >= MIN_CAPS_LETTERS and all(c.isupper() for c in cased)


def _title_checks(title: Optional[_Text]) -> list:
    if title is None:
        return [Check(n, NOT_CHECKED, R_NO_TITLE)
                for n in (TITLE_HARD_LIMIT, TITLE_DESKTOP, TITLE_MOBILE, FIGURE_POSITION, TITLE_CAPS)]
    shown = len(title.glyphs)
    checks = [
        Check(TITLE_HARD_LIMIT, *((ISSUE, R_OVER_LIMIT) if len(title.text) > HARD_LIMIT_CHARS else (OK, R_WITHIN_LIMIT))),
        Check(TITLE_DESKTOP, *((ISSUE, R_CUT_DESKTOP) if shown > DESKTOP_VISIBLE_CHARS else (OK, R_FITS_DESKTOP))),
        Check(TITLE_MOBILE, *((ISSUE, R_CUT_MOBILE) if shown > MOBILE_VISIBLE_CHARS else (OK, R_FITS_MOBILE))),
    ]

    first_digit = next((i for i, g in enumerate(title.glyphs) if unicodedata.category(g[0]) == "Nd"), None)
    if first_digit is None:
        checks.append(Check(FIGURE_POSITION, NOT_CHECKED, R_NO_FIGURE))
    elif first_digit >= DESKTOP_VISIBLE_CHARS:
        checks.append(Check(FIGURE_POSITION, ISSUE, R_FIGURE_CUT_DESKTOP))
    elif first_digit >= MOBILE_VISIBLE_CHARS:
        checks.append(Check(FIGURE_POSITION, ISSUE, R_FIGURE_CUT_MOBILE))
    else:
        checks.append(Check(FIGURE_POSITION, OK, R_FIGURE_VISIBLE))

    if not any(c.isupper() or c.islower() for c in title.text):
        # "1453" or a title in an uncased script has no capitals to count; that is not "no shouting".
        checks.append(Check(TITLE_CAPS, NOT_CHECKED, R_NO_CASED_LETTERS))
    else:
        caps = sum(1 for w in title.text.split(" ") if _is_caps_word(w))
        checks.append(Check(TITLE_CAPS, *((ISSUE, R_TOO_MANY_CAPS) if caps > MAX_CAPS_WORDS else (OK, R_CAPS_OK))))
    return checks


def _overlay_length_check(overlay: Optional[_Text]) -> Check:
    if overlay is None:
        return Check(OVERLAY_LENGTH, NOT_CHECKED, R_NO_OVERLAY)
    # Words are whitespace-separated runs; a script written without spaces is one "word", which
    # the character budget then catches.
    if len(overlay.text.split(" ")) > MAX_OVERLAY_WORDS:
        return Check(OVERLAY_LENGTH, ISSUE, R_TOO_MANY_WORDS)
    if len(overlay.glyphs) > MAX_OVERLAY_CHARS:
        return Check(OVERLAY_LENGTH, ISSUE, R_TOO_LONG)
    return Check(OVERLAY_LENGTH, OK, R_WITHIN_BUDGET)


def _overlay_echo_check(title: Optional[_Text], overlay: Optional[_Text], english: bool) -> Check:
    if not english:
        return Check(OVERLAY_ECHO, NOT_CHECKED, R_LANGUAGE)
    if title is None:
        return Check(OVERLAY_ECHO, NOT_CHECKED, R_NO_TITLE)
    if overlay is None:
        return Check(OVERLAY_ECHO, NOT_CHECKED, R_NO_OVERLAY)
    mine = _content_words(overlay.text)
    if not mine:
        return Check(OVERLAY_ECHO, NOT_CHECKED, R_NO_CONTENT_WORDS)
    shared = mine & _content_words(title.text)
    if len(shared) / len(mine) >= ECHO_SHARE:
        return Check(OVERLAY_ECHO, ISSUE, R_REPEATS_TITLE)
    return Check(OVERLAY_ECHO, OK, R_ADDS_WORDS)


def _lint(title, overlay_text, language) -> LintResult:
    t = _prepare(title)
    o = _prepare(overlay_text)
    english = _is_english(language)
    checks = _title_checks(t)
    checks.append(_overlay_length_check(o))
    checks.append(_overlay_echo_check(t, o, english))
    return LintResult(
        checks=tuple(checks),
        word_checks=WORDS_RUN if english else WORDS_LANGUAGE,
        title_graphemes=len(t.glyphs) if t else None,
        title_chars=len(t.text) if t else None,
        overlay_graphemes=len(o.glyphs) if o else None,
        overlay_words=len(o.text.split(" ")) if o else None,
        truncated=bool((t and t.truncated) or (o and o.truncated)),
    )


def lint(title, overlay_text=None, language=None) -> LintResult:
    """Lint one title + thumbnail-text pairing. Never raises: anything it cannot handle comes
    back as ``not_checked: error`` on every check, so a caller can emit it without a guard
    (and should still keep one)."""
    try:
        return _lint(title, overlay_text, language)
    except Exception:
        return LintResult(
            checks=tuple(Check(n, NOT_CHECKED, R_ERROR) for n in ALL_CHECKS),
            word_checks=WORDS_LANGUAGE,
            title_graphemes=None, title_chars=None,
            overlay_graphemes=None, overlay_words=None,
        )
