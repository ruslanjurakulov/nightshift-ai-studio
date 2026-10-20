"""Claim extraction — pulls candidate factual claims out of a generated Script.

Fits into the pipeline as the missing connective piece between script
generation and fact-checking:

    Topic -> Research -> Script -> [claim_extractor] -> Fact Check -> Final Human Approval -> Publish

`extract_claims(script)` takes a `modules.script_engine.Script` (or, for
convenience/testing, a plain narration string, or any duck-typed object that
looks enough like one — see `_narration_text` below) and returns a plain
`list[str]` of claim strings, exactly the input shape
`modules.fact_checker.fact_check_claims` expects.

*** THIS IS A HEURISTIC, NOT A GUARANTEED-ACCURATE CLASSIFIER. ***

The approach chosen here is naive sentence-splitting over the narration text
plus a lightweight keyword/shape filter — not an LLM call. Two consequences
follow directly from that, and both are ACCEPTABLE, BOUNDED risks rather than
silent correctness gaps:

  1. It WILL miss real factual claims that are phrased awkwardly, split
     across sentences, or embedded in a sentence that also trips a filter
     heuristic (e.g. a factual sentence that happens to also contain a CTA
     phrase like "subscribe").
  2. It WILL occasionally pass through sentences that are not really
     checkable claims (transitional narration, scene-setting, rhetorical
     asides that don't end in "?").

This is fine because `fact_checker.fact_check_claims` is itself advisory-only
and already defaults every claim that isn't confidently verified to
`requires_human_review=True` (see that module's docstring) — a human reviewer
sees the claim text either way before anything publishes. Extraction being
imperfect only ever means a human sees slightly more or slightly less text at
that gate, never that something false gets waved through automatically.

Why sentence-splitting over an LLM call: script narration is already
generated text (not raw user input), the claims that matter for fact-checking
are almost always simple declarative sentences, and avoiding a second Gemini
round-trip here keeps this step free, fast, and independent of API quota —
consistent with `script_engine`'s own note about avoiding extra round-trips
where the data is already in hand. If experience shows sentence-splitting
misses too much, an LLM-based extraction pass (following the same
`generate_with_retry`/`make_client`/`GEMINI_MODEL` pattern used elsewhere in
this codebase, with claims JSON-encoded into the prompt the same defensive
way `fact_checker._build_prompt` does) would be a reasonable follow-up.
"""

import re
import unicodedata
from dataclasses import dataclass

# --- Sentence splitting -----------------------------------------------------

# Common abbreviations whose trailing "." must NOT be treated as a sentence
# boundary. This is a fixed heuristic list, not exhaustive — an abbreviation
# missing from this list can still cause a spurious split. Matched
# case-insensitively at a word boundary immediately before the period.
_ABBREVIATIONS = (
    r"mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|no|fig|vol|gen|rev|"
    r"gov|sen|rep|capt|col|lt|cmdr|maj|sgt|u\.s|u\.k"
)
_ABBREV_RE = re.compile(rf"\b(?:{_ABBREVIATIONS})\.", re.IGNORECASE)

# A period between two digits ("3.5 million") is a decimal point, never a
# sentence boundary.
_DECIMAL_RE = re.compile(r"(?<=\d)\.(?=\d)")

# A placeholder that can't otherwise occur in narration text, used to
# temporarily hide protected periods before splitting, then restored.
_DOT_PLACEHOLDER = " DOT "

# Split on whitespace that follows a sentence-ending ./!/? — by requiring the
# trailing whitespace, this already leaves "3.5" (no space after the period)
# alone; the abbreviation/decimal protection below exists for the cases that
# DO have a following space, like "Dr. Smith".
#
# Scripts that end a sentence with their own mark are split on it too, with or
# without a space after it: Chinese/Japanese 。！？ carry no space at all, the
# Hindi danda । ॥ and Arabic ؟ usually do. A mark followed by a closing quote or
# bracket stays with its sentence.
_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|(?<=[。！？।॥؟])(?![」』）)\"”’])\s*")


def _split_sentences(text: str) -> list[str]:
    """Naive sentence splitter — good enough, not linguistically perfect.

    Protects known abbreviations and decimal numbers from being mistaken for
    sentence boundaries, then splits on whitespace following [.!?]. Anything
    trickier than that (nested quotes, semicolons-as-sentence-breaks, etc.)
    is out of scope for this heuristic.
    """
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []

    protected = _DECIMAL_RE.sub(_DOT_PLACEHOLDER, text)
    protected = _ABBREV_RE.sub(lambda m: m.group(0)[:-1] + _DOT_PLACEHOLDER, protected)

    pieces = _SPLIT_RE.split(protected)
    return [p.replace(_DOT_PLACEHOLDER, ".").strip() for p in pieces if p.strip()]


# --- Non-claim filtering -----------------------------------------------------

# Fewer words than this reads as a fragment, not a checkable claim (e.g. a
# lone interjection or a cue-stripped leftover).
MIN_CLAIM_WORDS = 4

#: Scripts written without spaces between words. A run of them counts as one
#: "word" per this many characters (a Chinese or Japanese word is ~2 characters,
#: a Thai or Khmer one ~4); without it a whole Chinese narration is "2 words".
_UNSPACED_CHARS_PER_WORD = (
    (re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]"), 2),
    (re.compile(r"[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff]"), 4),
)
_QUESTION_MARKS = ("?", "\uff1f", "\u061f")


def count_words(text: str) -> int:
    """Words in ``text``, counting unspaced scripts (CJK, Thai, Lao, Myanmar,
    Khmer) by characters so a narration without spaces is not read as nearly empty."""
    text = text or ""
    total = 0
    for pattern, per_word in _UNSPACED_CHARS_PER_WORD:
        found = pattern.findall(text)
        if found:
            total += -(-len(found) // per_word)
            text = pattern.sub(" ", text)
    return total + len(text.split())

# Substrings (case-insensitive) that mark a sentence as a hook/CTA/transition
# rather than a factual statement. This is a heuristic keyword list, not a
# guaranteed classifier — a factual sentence that happens to contain one of
# these phrases will still be filtered out, and plenty of CTAs that don't
# match any phrase here will still get through.
_CTA_PHRASES = (
    "subscribe",
    "hit the bell",
    "hit that bell",
    "smash that like",
    "like and subscribe",
    "comment below",
    "let me know",
    "let us know",
    "click the link",
    "link in the description",
    "stay tuned",
    "don't go anywhere",
    "we'll reveal",
    "we'll get to that",
    "we'll answer that",
    "coming up",
    "coming next",
    "in this video",
    "before we continue",
    "welcome back",
)


def _looks_like_claim(sentence: str) -> bool:
    """Heuristic filter: drop obvious non-claims, keep everything else.

    Documented heuristics only (not a guaranteed-accurate classification):
      - drop pure questions (end in "?") — these are hooks/open-loop prompts,
        not assertions to fact-check;
      - drop very short fragments (fewer than MIN_CLAIM_WORDS words);
      - drop sentences containing an obvious hook/CTA phrase.
    """
    stripped = sentence.strip()
    if not stripped:
        return False
    if stripped.endswith(_QUESTION_MARKS):
        return False
    if count_words(stripped) < MIN_CLAIM_WORDS:
        return False
    lowered = stripped.lower()
    if any(phrase in lowered for phrase in _CTA_PHRASES):
        return False
    return True


# --- Script text access ------------------------------------------------------

def _strip_cue_tags(text: str) -> str:
    """Fallback cue-tag stripper for duck-typed inputs without clean_narration().

    Mirrors modules.script_engine.ScriptSection.clean_narration()'s pattern
    set, kept local rather than imported so this module doesn't reach into
    script_engine's private helpers.
    """
    text = re.sub(r"\[SFX:[^\]]+\]", "", text)
    text = re.sub(r"\[MUSIC:[^\]]+\]", "", text)
    text = re.sub(r"\[PAUSE:[^\]]+\]", "", text)
    text = re.sub(r"\[VOICE:[^\]]+\]", "", text)
    return re.sub(r" {2,}", " ", text).strip()


def _narration_text(script) -> str:
    """Best-effort extraction of plain narration text from `script`.

    Accepts, in order of preference:
      - a plain string (used as-is);
      - a real modules.script_engine.Script (or anything exposing a callable
        `full_narration()`), which already returns cue-stripped text;
      - a duck-typed object with a `sections` sequence, where each section
        may expose `clean_narration()`, or else a raw `.narration` string
        that gets cue-stripped locally, or else is treated as a plain string;
      - a duck-typed object with a plain `.narration` string attribute.

    Anything else falls back to `str(script)` so this never raises on an odd
    input — callers get a (possibly empty, harmlessly wrong) string rather
    than a crash, and `extract_claims` handles the empty case gracefully.
    """
    if isinstance(script, str):
        return script

    full_narration = getattr(script, "full_narration", None)
    if callable(full_narration):
        return full_narration()

    sections = getattr(script, "sections", None)
    if sections is not None:
        parts = []
        for section in sections:
            clean = getattr(section, "clean_narration", None)
            if callable(clean):
                parts.append(clean())
            else:
                raw = getattr(section, "narration", None)
                parts.append(_strip_cue_tags(raw) if isinstance(raw, str) else str(section))
        return "\n\n".join(parts)

    narration = getattr(script, "narration", None)
    if isinstance(narration, str):
        return narration

    return str(script) if script is not None else ""


# --- Public entry point -------------------------------------------------------

def extract_claims(script) -> list[str]:
    """Extract candidate factual claims from a generated script.

    Returns a plain `list[str]`, the exact shape
    `modules.fact_checker.fact_check_claims` expects. An empty, whitespace-
    only, or very short script returns `[]` rather than raising.

    See the module docstring: this is a heuristic step (sentence-splitting +
    a lightweight non-claim filter), not a guaranteed-accurate classifier.
    """
    text = _narration_text(script)
    if not text or not text.strip():
        return []

    sentences = _split_sentences(text)
    return [s for s in sentences if _looks_like_claim(s)]


# --- Section-linked claims (claim <-> scene) ----------------------------------

@dataclass(frozen=True)
class Claim:
    """One candidate claim, tied to the script section it came from.

    ``claim_id`` is ``c{section:03d}-{n}`` (``n`` 1-based within the section),
    stable for the same section text, and ``scene_id`` is the Video IR scene id
    ``s{section:03d}`` — so a claim joins its scene without any lookup table.
    """

    claim_id: str
    section_index: int
    text: str
    #: Where the text ships: "narration" for a section's sentence, else the
    #: field it came from (``SOURCE_*``). Text that is not narration has no
    #: scene of its own (``section_index`` -1) except the alternate opening,
    #: which replaces section 0's narration when the hook A/B picks "B".
    source: str = "narration"

    @property
    def scene_id(self) -> str:
        return scene_id(self.section_index) if self.section_index >= 0 else ""


def scene_id(section_index: int) -> str:
    """The Video IR scene id for a script section index."""
    return f"s{int(section_index):03d}"


def claim_id(section_index: int, n: int) -> str:
    """The stable id of the ``n``-th (1-based) claim of a section."""
    return f"c{int(section_index):03d}-{int(n)}"


def _section_texts(script) -> list[str]:
    """Each section's cue-stripped narration, in order. A plain string, or an
    object with no ``sections``, is one section (index 0)."""
    if isinstance(script, str):
        return [script]
    sections = getattr(script, "sections", None)
    if sections is None:
        return [_narration_text(script)]
    texts = []
    for section in sections:
        clean = getattr(section, "clean_narration", None)
        if callable(clean):
            texts.append(clean() or "")
        else:
            raw = getattr(section, "narration", None)
            if raw is None and isinstance(section, dict):
                raw = section.get("narration")
            texts.append(_strip_cue_tags(raw) if isinstance(raw, str) else "")
    return texts


def section_claims(text: str, section_index: int) -> list[Claim]:
    """The claims of one section's narration, with their stable ids."""
    if not text or not text.strip():
        return []
    sentences = [s for s in _split_sentences(text) if _looks_like_claim(s)]
    return [Claim(claim_id(section_index, n), section_index, s)
            for n, s in enumerate(sentences, start=1)]


def extract_section_claims(script) -> list[Claim]:
    """Like ``extract_claims``, but each claim knows its section.

    Extraction runs per section rather than over the joined narration, so a
    sentence can never straddle two scenes. Same heuristic, same caveats (see
    the module docstring). Never raises on an odd input — returns ``[]``.
    """
    try:
        texts = _section_texts(script)
    except Exception:
        return []
    out: list[Claim] = []
    for i, text in enumerate(texts):
        out.extend(section_claims(text, i))
    return out


# --- Everything that ships, not only the narration ------------------------------

SOURCE_NARRATION = "narration"
SOURCE_HOOK_AB = "hook_ab"
SOURCE_HOOK_SENTENCE = "hook_sentence"
SOURCE_TITLE = "title"
SOURCE_TITLE_AB = "title_ab"
SOURCE_DESCRIPTION = "description"
SOURCE_THUMBNAIL = "thumbnail_text"

#: Short texts that are not narration. The checker judges each one as an isolated
#: phrase with no context, so "I cannot tell" (``unverifiable``) is the usual
#: answer to a bare title; the gate (publish_gate._check_fact_results) holds on
#: a fragment only for ``likely_inaccurate`` or when it carries a digit or year.
#: The alternate hook is NOT here: it replaces section 0's narration.
FRAGMENT_SOURCES = frozenset({SOURCE_TITLE, SOURCE_TITLE_AB, SOURCE_DESCRIPTION,
                              SOURCE_THUMBNAIL, SOURCE_HOOK_SENTENCE})

#: A description line that is only hashtags or only a link carries no claim.
_HASHTAG_OR_URL_LINE = re.compile(r"^\s*(?:(?:#\w+|https?://\S+|www\.\S+)\s*)+$", re.IGNORECASE)
#: Invented chapter marks (the uploader strips these lines too, see
#: modules/youtube_uploader.TIMESTAMP_LINE); the real chapters are measured.
_TIMESTAMP_LINE = re.compile(r"^\s*(?:[-*•]\s*)?\d{1,2}:\d{2}(?::\d{2})?\b")
_URL = re.compile(r"https?://|www\.", re.IGNORECASE)
_URL_WHOLE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)

_APOSTROPHES = str.maketrans({"ʻ": "'", "ʼ": "'", "‘": "'", "’": "'", "`": "'", "´": "'"})


def normalize_text(text: str) -> str:
    """Case-folded text with every apostrophe look-alike as ``'``, so the word
    lists below match Uzbek ``o'g'ri`` however the model typed its apostrophes."""
    return (text or "").translate(_APOSTROPHES).casefold()


#: Description lines that are a thank-you, a call to action or a credit, not a
#: statement about the video's subject. Description-only: narration keeps the
#: shorter ``_CTA_PHRASES`` above (a loosened narration filter would check less
#: than before). Data, one language per row; matched against ``normalize_text``.
_DESCRIPTION_NOISE = (
    # en
    "thanks for watching", "thank you for watching", "don't forget", "dont forget", "follow us",
    "share this", "subscribe", "like and", "hit the bell", "music:", "music by", "credits:", "credit:",
    "sources:", "source:", "follow me", "turn on notifications", "check out our",
    # ru
    "спасибо за просмотр", "спасибо, что смотр", "подписывай", "подписывайся", "подписаться", "не забудьте",
    "не забывайте", "ставьте лайк", "ставь лайк", "музыка:", "источники:", "источник:", "жмите колокол",
    # uz
    "musiqa:", "obuna bo'ling", "obuna bo'l", "ko'rgani uchun rahmat", "ko'rganingiz uchun",
    "tomosha qilganingiz uchun", "unutmang", "yoqtiring", "like bosing", "manbalar:", "manba:",
)

#: Words that make a short text a CLAIM rather than a rhetorical hook (title,
#: title_ab, thumbnail text, hook_sentence): an accusation, or a superlative or
#: absolute. A digit or a year is the third trigger (``has_number``). Data, en / ru / uz.
#: Stems match a word's start (``\bkill\w*``); apostrophes are normalized first.
_ACCUSATION_STEMS = (
    # en
    "murder", "kill", "poison", "assassin", "stole", "steal", "thie", "theft", "fraud", "framed", "betray",
    "conspir", "execut", "massacr", "genocid", "rape", "abus", "corrupt", "guilty", "crimin", "crime",
    "liar", "lied", "tortur", "slaughter", "behead", "bribe", "blackmail", "traitor", "cover-up", "coverup",
    # ru
    "убий", "убил", "убит", "убь", "отрав", "украл", "краж", "предал", "предател", "казн", "виновн",
    "преступ", "мошенн", "заговор", "резн", "геноцид", "лжец", "обман", "пытк", "взятк", "шантаж",
    # uz
    "o'ldir", "o'ldi", "qotil", "zaharla", "o'g'ri", "o'g'irla", "xiyonat", "aybdor", "jinoyat", "firibgar",
    "fitna", "qatl", "genotsid", "yolg'on", "qiynoq", "poraxo'r", "josus",
)
_ABSOLUTE_WORDS = (
    # en
    "most", "biggest", "deadliest", "worst", "greatest", "largest", "smallest", "oldest", "first", "last",
    "only", "never", "always", "every", "everyone", "everything", "nobody", "nothing", "all", "entire",
    "whole", "truth", "proof", "proven", "secret", "secrets", "revealed", "impossible", "forever", "ever",
    "real", "really", "true", "hidden",
    # ru
    "самый", "самая", "самое", "самые", "худший", "лучший", "первый", "последний", "единственный",
    "никогда", "всегда", "все", "всё", "каждый", "никто", "вся", "весь", "правда", "истина", "тайна",
    "раскрыта", "раскрыт", "навсегда", "невозможно", "доказано",
    # uz
    "eng", "birinchi", "oxirgi", "yagona", "hech", "doim", "har", "hamma", "butun", "haqiqat", "isbot",
    "sir", "ochildi", "abadiy", "imkonsiz",
)
_ACCUSATION_RE = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in _ACCUSATION_STEMS) + r")\w*")
_ABSOLUTE_RE = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in _ABSOLUTE_WORDS) + r")\b|\bno one\b")


def has_number(text: str) -> bool:
    """A digit of any script (``\d`` is Unicode-aware): a number or a year."""
    return bool(re.search(r"\d", text or ""))


def carries_checkable_content(text: str) -> bool:
    """Whether a short text asserts something checkable: it has a number or a
    year, an accusation word, or a superlative or absolute (en / ru / uz lists
    above). A bare phrase with none of them is a rhetorical hook, not a claim."""
    norm = normalize_text(text)
    return has_number(norm) or bool(_ACCUSATION_RE.search(norm)) or bool(_ABSOLUTE_RE.search(norm))


def narration_word_count(script) -> int:
    """Words of narration in ``script`` (cue tags stripped; unspaced scripts
    counted by characters, see ``count_words``). Never raises."""
    try:
        return sum(count_words(t) for t in _section_texts(script))
    except Exception:
        return 0


def narration_char_count(script) -> int:
    """Non-space characters of narration: a floor that does not depend on how a
    language writes its words. Never raises."""
    try:
        return sum(len(re.sub(r"\s", "", t)) for t in _section_texts(script))
    except Exception:
        return 0


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def _field_text(script, name: str) -> str:
    value = script.get(name) if isinstance(script, dict) else getattr(script, name, "")
    return value.strip() if isinstance(value, str) else ""


def _description_lines(description: str) -> list[str]:
    """The description's lines that can hold a statement: no invented chapter
    marks, no hashtag-only or link-only lines (split on LINES first, so a
    "Music: ..." credit is never glued to the paragraph above it)."""
    return [ln for ln in (description or "").splitlines()
            if ln.strip() and not _TIMESTAMP_LINE.match(ln) and not _HASHTAG_OR_URL_LINE.match(ln)]


def _description_sentences(description: str) -> list[str]:
    out: list[str] = []
    for line in _description_lines(description):
        for sentence in _split_sentences(line):
            norm = normalize_text(sentence)
            if _URL.search(sentence) or any(noise in norm for noise in _DESCRIPTION_NOISE):
                continue
            if _looks_like_claim(sentence):
                out.append(sentence)
    return out


def extract_shipped_claims(script) -> list[Claim]:
    """The narration claims of ``extract_section_claims`` plus every other text
    that reaches the audience, so one fact-check covers what actually ships.

    Added after the narration claims, in this order: the sentences of the
    alternate opening (``hook_ab``, which the hook A/B swaps in AFTER the check
    ran, so its claims are filed under section 0 where they will play), the
    ``hook_sentence`` (the Short's description), the title, the A/B title, the
    description's sentences and the thumbnail text.

    A title, A/B title, thumbnail text or hook sentence is extracted only when it
    asserts something (``carries_checkable_content``: a number or year, an
    accusation, a superlative or absolute); a rhetorical hook or a bare phrase is
    not a claim. A title or thumbnail text is one claim as a whole (a two-word
    "NEVER OPENED!" is a claim the sentence filter would drop), a pure question
    is skipped as in narration, and a text that is the same as one already
    listed is not checked twice. Description sentences are all extracted except
    links, thank-yous, calls to action and credits (``_DESCRIPTION_NOISE``).
    Never raises: a failure returns what was extracted so far.
    """
    out = list(extract_section_claims(script))
    try:
        seen_in_section = {(c.section_index, _normalize(c.text)) for c in out}
        seen_text = {_normalize(c.text) for c in out}

        def add(source: str, texts, section_index: int, ids) -> None:
            n = 0
            for text in texts:
                key = _normalize(text)
                if not key or (section_index, key) in seen_in_section or (
                        section_index < 0 and key in seen_text):
                    continue
                n += 1
                seen_in_section.add((section_index, key))
                seen_text.add(key)
                out.append(Claim(ids(n), section_index, text, source))

        hook_ab = _strip_cue_tags(_field_text(script, "hook_ab"))
        if hook_ab:
            add(SOURCE_HOOK_AB, [s for s in _split_sentences(hook_ab) if _looks_like_claim(s)],
                0, lambda n: f"c000-h{n}")

        def whole(name: str) -> list[str]:
            text = _strip_cue_tags(_field_text(script, name))
            if (text and not text.endswith(_QUESTION_MARKS) and re.search(r"\w", text)
                    and carries_checkable_content(text)):
                return [text]
            return []

        hook_sentence = _strip_cue_tags(_field_text(script, "hook_sentence"))
        add(SOURCE_HOOK_SENTENCE,
            [s for s in _split_sentences(hook_sentence)
             if _looks_like_claim(s) and carries_checkable_content(s)],
            -1, lambda n: f"x-hook_sentence-{n}")
        add(SOURCE_TITLE, whole("title"), -1, lambda n: f"x-title-{n}")
        add(SOURCE_TITLE_AB, whole("title_ab"), -1, lambda n: f"x-title_ab-{n}")
        add(SOURCE_DESCRIPTION, _description_sentences(_field_text(script, "description")),
            -1, lambda n: f"x-description-{n}")
        add(SOURCE_THUMBNAIL, whole("thumbnail_overlay_text"), -1, lambda n: f"x-thumbnail_text-{n}")
    except Exception:
        pass
    return out


# --- A free check: a number that ships must be in the narration --------------------

_NUMBER_RE = re.compile(r"\d[\d.,  ]*\d|\d")
_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split())
         if w != "_"}
_MULTIPLIERS = {"thousand": 10 ** 3, "million": 10 ** 6, "billion": 10 ** 9}


def _ascii_digits(text: str) -> str:
    """Digits of any script as ASCII digits (``unicodedata.digit``); other characters unchanged."""
    return "".join(str(unicodedata.digit(c)) if c.isdigit() and unicodedata.digit(c, None) is not None else c
                   for c in text or "")


def _number_forms(token: str) -> set:
    return {token, re.sub(r"\D", "", token)}


def _spoken_numbers(text: str) -> set:
    """Numbers written as English words ("forty thousand", "nineteen hundred"),
    as digit strings. Only English: a Russian or Uzbek narration that spells a
    number out does not support a title that writes it in digits (see the PR)."""
    found, total, current, in_run = set(), 0, 0, False

    def flush():
        nonlocal total, current, in_run
        if in_run:
            found.add(str(total + current))
        total = current = 0
        in_run = False

    for word in re.findall(r"[a-z]+", (text or "").lower()):
        if word in _UNITS or word in _TENS:
            current += _UNITS.get(word, _TENS.get(word, 0))
            in_run = True
        elif word == "hundred" and in_run:
            current = max(current, 1) * 100
        elif word in _MULTIPLIERS and in_run:
            total += max(current, 1) * _MULTIPLIERS[word]
            current = 0
        elif word == "and" and in_run:
            continue
        else:
            flush()
    flush()
    return found


def _numbers_in(text: str) -> set:
    out: set = set()
    for m in _NUMBER_RE.finditer(_ascii_digits(text)):
        out |= _number_forms(m.group())
    return out


def unsupported_numbers(script) -> list:
    """``[(field, number), ...]``: every number or year in the title, the A/B
    title, the thumbnail text or the description that the narration never says.

    Free and deterministic: no model. A figure that ships but is not in the
    script is not backed by it, whatever the checker thinks of the sentence.
    A number matches however it is grouped ("1,000,000" is "1000000") and an
    English spelled-out number counts ("three" is 3). Links, timestamp lines and
    hashtag lines of the description are not read. Never raises."""
    try:
        narration = " ".join(_section_texts(script))
        known = _numbers_in(narration) | _spoken_numbers(narration)
        fields = [(SOURCE_TITLE, _field_text(script, "title")),
                  (SOURCE_TITLE_AB, _field_text(script, "title_ab")),
                  (SOURCE_THUMBNAIL, _field_text(script, "thumbnail_overlay_text")),
                  (SOURCE_DESCRIPTION, "\n".join(_URL_WHOLE.sub(" ", ln) for ln in
                                                 _description_lines(_field_text(script, "description"))))]
        missing, seen = [], set()
        for field, text in fields:
            for m in _NUMBER_RE.finditer(_ascii_digits(text)):
                forms = _number_forms(m.group())
                if forms & known or (field, m.group()) in seen:
                    continue
                seen.add((field, m.group()))
                missing.append((field, m.group()))
        return missing
    except Exception:
        return []
