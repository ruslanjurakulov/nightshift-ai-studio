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


def _looks_like_claim(sentence: str, cta: bool = True) -> bool:
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
    if cta and any(phrase in lowered for phrase in _CTA_PHRASES):
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
#: a fragment only for ``likely_inaccurate`` or when it names an accusation
#: (``has_accusation``). A number in a fragment is the free check's business
#: (``shipped_number_findings``). The alternate hook is NOT here: it replaces
#: section 0's narration.
FRAGMENT_SOURCES = frozenset({SOURCE_TITLE, SOURCE_TITLE_AB, SOURCE_DESCRIPTION,
                              SOURCE_THUMBNAIL, SOURCE_HOOK_SENTENCE})

#: A description line that is only hashtags or only a link carries no claim.
_HASHTAG_OR_URL_LINE = re.compile(r"^\s*(?:(?:#\w+|https?://\S+|www\.\S+)\s*)+$", re.IGNORECASE)
#: Invented chapter marks (the uploader strips these lines too, see
#: modules/youtube_uploader.TIMESTAMP_LINE); the real chapters are measured.
_TIMESTAMP_LINE = re.compile(r"^\s*(?:[-*•]\s*)?\d{1,2}:\d{2}(?::\d{2})?\b")
_URL = re.compile(r"https?://|www\.", re.IGNORECASE)
_URL_WHOLE = re.compile(r"(?:https?://|www\.)[^\s)\]>,;]+", re.IGNORECASE)

_APOSTROPHES = str.maketrans({"ʻ": "'", "ʼ": "'", "‘": "'", "’": "'", "`": "'", "´": "'"})


def normalize_text(text: str) -> str:
    """Case-folded text with every apostrophe look-alike as ``'``, so the word
    lists below match Uzbek ``o'g'ri`` however the model typed its apostrophes."""
    return (text or "").translate(_APOSTROPHES).casefold()


#: Description sentences that are a thank-you, a call to action or a credit, not a
#: statement about the video's subject. Description-only: narration keeps the
#: shorter ``_CTA_PHRASES`` above (a loosened narration filter would check less
#: than before). Data, one language per row; matched against ``normalize_text``,
#: and only where the sentence STARTS with it or is short (``_is_noise``): a long
#: sentence that merely contains "source:" or "subscribe" is still a statement.
_DESCRIPTION_NOISE = (
    # en
    "thanks for watching", "thank you for watching", "don't forget", "dont forget", "follow us",
    "share this", "subscribe", "like and", "hit the bell", "music:", "music by", "credits:", "credit:",
    "follow me", "turn on notifications", "check out our",
    # ru
    "спасибо за просмотр", "спасибо, что смотр", "подписывай", "подписывайся", "подписаться", "не забудьте",
    "не забывайте", "ставьте лайк", "ставь лайк", "музыка:", "жмите колокол",
    # uz
    "musiqa:", "obuna bo'ling", "obuna bo'l", "ko'rgani uchun rahmat", "ko'rganingiz uchun",
    "tomosha qilganingiz uchun", "unutmang", "yoqtiring", "like bosing",
)
#: A label that introduces a citation. For claims the LABEL is dropped and what follows is judged ("Source:
#: Napoleon died of poison" is a statement); for the number check the whole line is dropped (a citation year
#: such as "Smith (2019)" is not a figure the video states).
_SOURCE_LABELS = ("sources:", "source:", "источники:", "источник:", "manbalar:", "manba:")

#: Words that make a fragment an ACCUSATION (a crime, a betrayal, a killing) that
#: the checker could not confirm: such a fragment holds the run even when the
#: verdict is only ``unverifiable``, because "Napoleon Was Poisoned" is exactly the
#: defamation shape the gate exists for. Data, en / ru / uz: WHOLE WORDS and explicit
#: inflections, never open prefixes ("The Crimean War", "Poison Dart Frogs", "Killer
#: Whales", "The Executive Branch", "Казна Рима" are not accusations). Matched against
#: ``normalize_text`` (case-folded, apostrophes unified).
_ACCUSATION_WORDS = (
    # en
    "murder", "murdered", "murders", "murderer", "murderers", "killed", "kills", "poisoned", "poisons", "poisoning",
    "assassinated", "assassinates", "assassination", "stole", "steals", "betrayed", "betrays", "betrayal",
    "conspired", "massacre", "massacred", "tortured", "tortures", "slaughtered", "stabbed", "stabbing", "beheaded",
    "executed", "executes", "bribed", "blackmailed", "abused", "raped", "lied", "cheated", "framed for", "fraud",
    "genocide", "guilty", "liar", "traitor",
    # ru
    "убил", "убила", "убили", "убит", "убита", "убиты", "убийца", "убийцы", "отравил", "отравила", "отравили",
    "отравлен", "отравлена", "отравлены", "украл", "украла", "украли", "предал", "предала", "предали",
    "предатель", "предательство", "казнил", "казнила", "казнили", "казнён", "казнен", "казнены", "обманул",
    "обманула", "обманули", "лжец", "виновен", "виновна", "виновны", "мошенник", "мошенники", "пытал", "пытали",
    "зарезал", "зарезали", "зарезан", "зарезана", "зарезаны", "убийство", "убийства", "отравление", "резня",
    # uz
    "o'ldirdi", "o'ldirgan", "o'ldirilgan", "o'ldirildi", "qotil", "qotillar", "qotillik", "zaharladi", "zaharlangan",
    "zaharlandi", "o'g'irladi",
    "o'g'ri", "xiyonat", "aybdor", "jinoyatchi", "firibgar", "qatl", "poraxo'r", "yolg'onchi", "qiynadi", "josus",
)
_ACCUSATION_RE = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(w) for w in _ACCUSATION_WORDS) + r")(?!\w)")


def has_accusation(text: str) -> bool:
    """Whether ``text`` contains an accusation word or inflection (en / ru / uz list above, whole words)."""
    return bool(_ACCUSATION_RE.search(normalize_text(text)))


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


#: A sentence this short that contains a noise phrase anywhere is still noise.
_NOISE_SHORT_WORDS = 5
#: "Part 2 of our series", "Chapter 3", "Эпизод 4", "Qism 2": a series marker, not a statement.
_SERIES_MARKER = re.compile(
    r"^(?:part|chapter|episode|season|vol(?:ume)?|ep|часть|глава|серия|эпизод|сезон|выпуск|qism|epizod|bob|mavsum)\b\.?\s*[\divxl#]+\b")


def _is_noise(sentence: str) -> bool:
    """A thank-you, a call to action, a credit or a series marker: not a statement."""
    norm = normalize_text(sentence)
    core = re.sub(r"^[^\w]+", "", norm)
    if _SERIES_MARKER.match(core) or any(core.startswith(p) for p in _DESCRIPTION_NOISE):
        return True
    return count_words(sentence) <= _NOISE_SHORT_WORDS and any(p in norm for p in _DESCRIPTION_NOISE)


def _description_units(description: str, keep_sources: bool = True) -> list[str]:
    """The description's statements, one per sentence: lines first, links stripped
    (the rest of the sentence is still judged), noise dropped. A sentence that
    names a link or a source in passing stays. A sentence that STARTS with a source
    label ("Source: ...") loses the label and the rest is judged; with
    ``keep_sources=False`` it is dropped whole."""
    out: list[str] = []
    for line in _description_lines(description):
        for sentence in _split_sentences(_URL_WHOLE.sub(" ", line)):
            sentence = re.sub(r"\(\s*(?:see|cf\.?)?\s*\)", "", sentence)       # what a stripped link leaves
            sentence = re.sub(r"\s+([.,;!?])", r"\1", re.sub(r"\s+", " ", sentence)).strip()
            core = re.sub(r"^[^\w]+", "", normalize_text(sentence))
            label = next((lab for lab in _SOURCE_LABELS if core.startswith(lab)), None)
            if label:
                if not keep_sources:
                    continue
                sentence = sentence[sentence.casefold().find(label[:-1]) + len(label):].strip()
            if sentence and not _is_noise(sentence):
                out.append(sentence)
    return out


def _description_sentences(description: str) -> list[str]:
    # cta=False: a description sentence that merely mentions "subscribe" is judged whole; its real calls to
    # action were already dropped as noise (a sentence that STARTS with one, or is short).
    return [s for s in _description_units(description) if _looks_like_claim(s, cta=False)]


def extract_shipped_claims(script) -> list[Claim]:
    """The narration claims of ``extract_section_claims`` plus every other text
    that reaches the audience, so one fact-check covers what actually ships.

    Added after the narration claims, in this order: the sentences of the
    alternate opening (``hook_ab``, which the hook A/B swaps in AFTER the check
    ran, so its claims are filed under section 0 where they will play), the
    ``hook_sentence`` (the Short's description), the title, the A/B title, the
    description's sentences and the thumbnail text.

    Every title, A/B title, thumbnail text and hook sentence is extracted (a
    plain false claim such as "Einstein Failed Math" has no trigger word in any
    language): the gate decides what an unverifiable fragment means (a warning,
    or a block when it is an accusation). A title or thumbnail text is one claim
    as a whole (a two-word "NEVER OPENED!" is a claim the sentence filter would
    drop), a pure question is skipped as in narration, and a text that is the
    same as one already listed is not checked twice. Description sentences are
    all extracted except thank-yous, calls to action, credits and series markers
    (``_is_noise``); a link is stripped and the rest judged. All of it rides in the
    one batch of claims the checker already gets.
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
            if text and not text.endswith(_QUESTION_MARKS) and re.search(r"\w", text):
                return [text]
            return []

        hook_sentence = _strip_cue_tags(_field_text(script, "hook_sentence"))
        add(SOURCE_HOOK_SENTENCE,
            [s for s in _split_sentences(hook_sentence) if _looks_like_claim(s)],
            -1, lambda n: f"x-hook_sentence-{n}")
        add(SOURCE_TITLE, whole("title"), -1, lambda n: f"x-title-{n}")
        add(SOURCE_TITLE_AB, whole("title_ab"), -1, lambda n: f"x-title_ab-{n}")
        add(SOURCE_DESCRIPTION, _description_sentences(_field_text(script, "description")),
            -1, lambda n: f"x-description-{n}")
        add(SOURCE_THUMBNAIL, whole("thumbnail_overlay_text"), -1, lambda n: f"x-thumbnail_text-{n}")
    except Exception:
        pass
    return out


# --- A free check: a figure that ships must be backed by the narration -----------------

#: A number with grouped digits ("1,000,000", "900 000", "1.500"), or a plain one. A space-grouped number
#: ends at a 3-digit group that is not followed by another digit, so "March 5 1953" is 5 and 1953.
_NUMBER_RE = re.compile(r"\d{1,3}(?:[ \u00a0\u202f]\d{3}(?!\d))+(?:[.,]\d+)?|\d[\d.,\u00a0\u202f]*\d|\d")
#: Right after a number: an ordinal suffix ("20th", "1st", Russian "20-й"), which is not a quantity.
_ORDINAL_SUFFIX = re.compile(r"(?:st|nd|rd|th)\b|-(?:й|я|е|го|му|ом|ый|ая|ое|ые|х)\b", re.IGNORECASE)
_MULTIPLIER_WORD = re.compile(r"\s*(thousand|million|billion)\b", re.IGNORECASE)
_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split())
         if w != "_"}
_MULTIPLIERS = {"thousand": 10 ** 3, "million": 10 ** 6, "billion": 10 ** 9}
_NUMBER_WORD = {**{v: k for k, v in _UNITS.items()}, **{v: k for k, v in _TENS.items()}}
_ENUMERATORS = re.compile(
    r"\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final)\b|\bnumber (\w+)\b",
    re.IGNORECASE)
#: A small number (2-30) in a title, A/B title or thumbnail is a candidate COUNT ("5 Battles That Changed Rome",
#: "Top 10 Mysteries of Rome", "Rome: 7 Facts"): it is backed when the narration enumerates that many items, the
#: script has that many sections, or the narration says "N <noun>". Unbacked, it is a WARNING when the headline
#: is a list (a listicle word within the next three words, or top / best / worst right before it) and a figure
#: otherwise ("The 12 Senators Who Stabbed Caesar"). The words are data (en / ru / uz) and kept modest. A number
#: directly followed by a person or an event ("12 Dead", "25 Years Later", "3 Men") is never a candidate: it is a
#: FIGURE, exactly like a number over 30.
_SMALL_COUNT = range(2, 31)
_LISTICLE_WORDS = frozenset(
    # en
    "facts fact things thing ways way reasons reason secrets secret mysteries mystery wonders wonder signs sign "
    "myths myth lessons lesson mistakes mistake tips tricks rules steps places questions theories clues stories "
    "moments best worst greatest top "
    # ru
    "фактов факта факты вещей вещи причин причины тайн тайны загадок загадки способов способа чудес чуда уроков "
    "ошибок мифов признаков правил шагов мест теорий лучших худших "
    # uz
    "fakt faktlar sir sirlar sabab sabablar usul usullar jumboq jumboqlar mo''jiza ta".replace("''", "'").split())
#: Only the superlative lead-ins say "a list": "the", "these", "those", "are" do not (they need a listicle word).
_LISTICLE_LEAD_INS = frozenset("top best worst топ лучших худших eng".split())
_FIGURE_NOUNS = frozenset(
    # en
    "dead killed died deaths men women people children soldiers victims survivors years months weeks days hours "
    "minutes "
    # ru
    "погибших погибли убитых человек людей лет года год дней дня часов минут жертв солдат мужчин женщин детей "
    # uz
    "o'lgan halok kishi odam yil kun soat daqiqa qurbon askar erkak ayol bola".split())
#: A narration that writes no number as digits but SPELLS a magnitude ("тысяч", "миллион", "ming") may be saying
#: the figure in words; one that has neither digits nor a magnitude word is the shape of a made-up figure.
_THOUSAND_WORDS = re.compile(r"(?<!\w)(?:тысяч\w*|миллион\w*|миллиард\w*|ming|million\w*|milliard\w*|miliard\w*)(?!\w)")
_MILLION_WORDS = re.compile(r"(?<!\w)(?:миллион\w*|миллиард\w*|million\w*|milliard\w*|miliard\w*)(?!\w)")


def _ascii_digits(text: str) -> str:
    """Digits of any script as ASCII digits (``unicodedata.digit``); other characters unchanged."""
    return "".join(str(unicodedata.digit(c)) if c.isdigit() and unicodedata.digit(c, None) is not None else c
                   for c in text or "")


def _fmt(value) -> str:
    return str(int(value)) if float(value).is_integer() else str(round(float(value), 6))


def _digit_tokens(text: str) -> list:
    """``[(token, start, end, forms, is_ordinal)]`` for each number in ``text``. A number followed by
    thousand / million / billion also carries its value ("1.5 million" is 1500000), and
    separators are ignored in the other form ("1,000,000" is "1000000")."""
    ascii_text = _ascii_digits(text)
    out = []
    for m in _NUMBER_RE.finditer(ascii_text):
        token, after = m.group(), ascii_text[m.end():m.end() + 24]
        forms = {token, re.sub(r"\D", "", token)}
        mult = _MULTIPLIER_WORD.match(after)
        if mult:
            try:
                forms.add(_fmt(float(re.sub(r"[,\u00a0\u202f ]", "", token)) * _MULTIPLIERS[mult.group(1).lower()]))
            except ValueError:
                pass
        out.append((token, m.start(), m.end(), forms, bool(_ORDINAL_SUFFIX.match(after))))
    return out


def _group(tokens, first: bool = False):
    """The value 0-99 (1-99 for ``first``) of one or two spoken words, or None."""
    t = list(tokens)
    if len(t) == 1 and (t[0] in _UNITS or t[0] in _TENS):
        v = _UNITS.get(t[0], _TENS.get(t[0]))
        return v if (v >= 1 or not first) else None
    if len(t) == 2 and t[0] in _TENS and t[1] in _UNITS and 1 <= _UNITS[t[1]] <= 9:
        return _TENS[t[0]] + _UNITS[t[1]]
    if len(t) == 2 and t[0] == "oh" and not first and t[1] in _UNITS and 1 <= _UNITS[t[1]] <= 9:
        return _UNITS[t[1]]
    return None


def _spoken_run(run) -> set:
    found = set()
    total = current = 0.0
    for tok in run:
        if tok in _UNITS or tok in _TENS:
            current += _UNITS.get(tok, _TENS.get(tok))
        elif tok == "hundred":
            current = max(current, 1) * 100
        elif tok in _MULTIPLIERS:
            total += max(current, 1) * _MULTIPLIERS[tok]
            current = 0
        elif tok == "and_a_half":
            current += 0.5
    found.add(_fmt(total + current))
    # A year read as two pairs: "nineteen eighty-four", "eighteen twelve", "four seventy-six", "nineteen oh five".
    if len(run) >= 2 and all(t in _UNITS or t in _TENS or t == "oh" for t in run):
        for k in range(1, len(run)):
            hi, lo = _group(run[:k], first=True), _group(run[k:])
            if hi is not None and lo is not None:
                found.add(str(hi * 100 + lo))
    return found


def _spoken_numbers(text: str) -> set:
    """Numbers written as English words ("forty thousand", "nineteen hundred", "one and a half
    million", the years "nineteen eighty-four" / "eighteen twelve"), as digit strings.
    English only: a Russian or Uzbek narration is not read (see ``shipped_number_findings``)."""
    # Anything that is not a letter, a space or a hyphen (a comma, a full stop, a digit) is a token of its
    # own, which ends a run: "nineteen eighty-four, eighteen twelve" is two years, not one number.
    words = re.findall(r"[a-z]+|[^a-z\s\-]", (text or "").lower())
    found, run, i = set(), [], 0

    def flush():
        nonlocal run
        if run:
            found.update(_spoken_run(run))
        run = []

    while i < len(words):
        w, nxt = words[i], (words[i + 1] if i + 1 < len(words) else "")
        if w in _UNITS or w in _TENS or w in _MULTIPLIERS or w == "hundred":
            run.append(w)
        elif w == "and" and run and nxt == "a" and words[i + 2:i + 3] == ["half"]:
            run.append("and_a_half")
            i += 3
            continue
        elif w == "and" and run and (nxt in _UNITS or nxt in _TENS):
            pass
        elif w == "oh" and run and nxt in _UNITS and 1 <= _UNITS[nxt] <= 9:
            run.append("oh")
        else:
            flush()
        i += 1
    flush()
    return found


def _enumerators(narration: str) -> int:
    """How many list items the narration enumerates in words: distinct first / second / ... / last
    and "number one". A count in a headline ("5 Strange Facts") is backed when the script walks
    through that many."""
    return len({(m.group(1) or "number " + m.group(2)).lower() for m in _ENUMERATORS.finditer(narration)})


def _words_after(text: str, end: int, n: int) -> list:
    return re.findall(r"[\w']+", normalize_text(text[end:]))[:n]


def _word_before(text: str, start: int) -> str:
    found = re.findall(r"[\w']+", normalize_text(text[:start]))
    return found[-1] if found else ""


#: Words of 4+ letters that are not a noun a count could refer to.
_NOUN_STOP = frozenset("that what which this these those were went have from with about into your their".split())


def _count_nouns(text: str, end: int) -> list:
    """The words a count may refer to: a listicle word within three words ("facts" in "5 Strange Facts") and the
    first two noun-like words after the number (4+ letters, not a stop word: "roman", "emperors" in "7 Roman
    Emperors Who Went Mad"). Short words and stop words would back anything."""
    after = _words_after(text, end, 3)
    noun_like = [w for w in after if len(w) >= 4 and w not in _NOUN_STOP][:2]
    return list(dict.fromkeys([w for w in after if w in _LISTICLE_WORDS] + noun_like))


#: Words before a number that say nothing about a NAME ("Apollo 11", "Chapter 11", "Vitamin B12").
_NAME_STOP = frozenset("the these those are and for with from over only just top best worst in of by at to on a an".split())


def _name_backed(text: str, start: int, n: int, narration: str) -> bool:
    """A number that is part of a name ("Apollo 11", "Vitamin B12", "Windows 10") is backed when the narration
    has the same word, or letter, right before that number: "Apollo 11", "B12"."""
    prev = _word_before(text, start)
    if not prev or prev in _NAME_STOP:
        return False
    word = _NUMBER_WORD.get(n, "")
    number = rf"(?:{n}{'|' + word if word else ''})"
    return bool(re.search(rf"(?<!\w){re.escape(prev)}\W{{0,2}}{number}(?!\w)", narration, re.IGNORECASE))


def _listicle_context(text: str, start: int, end: int) -> bool:
    """A list headline: a listicle word within the next three words, or top / best / worst right before."""
    return (any(w in _LISTICLE_WORDS for w in _words_after(text, end, 3))
            or _word_before(text, start) in _LISTICLE_LEAD_INS)


def _is_count_candidate(field: str, token: str, forms: set, text: str, start: int, end: int) -> bool:
    """A 2-30 integer in a title / A/B title / thumbnail text. Never a percentage, a decimal or a time, and
    never one followed by a person or an event ("12 Dead", "25 Years Later")."""
    if field == SOURCE_DESCRIPTION or not token.isdigit() or int(token) not in _SMALL_COUNT or len(forms) != 1:
        return False
    if text[end:end + 1] in ("%", ".", ":", "/") or re.search(r"\d[:./,]$", text[max(0, start - 2):start]):
        return False                                   # a percentage, a decimal, a time ("7:30")
    after = _words_after(text, end, 3)
    return not (after and after[0] in _FIGURE_NOUNS)


def _count_is_backed(n: int, nouns: list, narration: str, enumerated: int, n_sections: int) -> bool:
    """A headline count is backed when the narration enumerates at least that many items, the script has
    that many sections, or the narration says "N <noun>" itself ("five facts", "5 secrets", "seven
    emperors") with nothing between the number and the noun."""
    if enumerated >= n or n_sections >= n:
        return True
    word = _NUMBER_WORD.get(n, "")
    number = rf"(?:{n}{'|' + word if word else ''})"
    return any(re.search(rf"\b{number}\s+{re.escape(noun)}\w*", narration, re.IGNORECASE)
               for noun in nouns)


@dataclass(frozen=True)
class NumberFindings:
    #: ``((field, number), ...)``: a 3+ digit number, a year or a percentage in the title, title_ab or thumbnail
    #: that the narration never says as digits, in a narration that does write numbers as digits (or, when it
    #: writes none, one that gives no magnitude word either: the shape of a made-up figure).
    large: tuple = ()
    #: Same shape, but the narration writes no number of 2+ digits and does spell the magnitude: its numbers are
    #: in words, which only English can be read, so the gate only warns outside English.
    large_soft: tuple = ()
    #: Same shape: a 1-2 digit figure that is not backed ("12 Dead", "25 Years Later", "40%", "The 12 Senators").
    small: tuple = ()
    #: Same shape: a headline count ("Top 10 Mysteries", "Rome: 7 Facts") the script does not back. A warning.
    counts: tuple = ()
    #: Same shape: any figure of the DESCRIPTION the narration does not back ("Filmed in 2019", "(c) 2024").
    #: The description is the lowest-risk shipped text: a warning in every language.
    description: tuple = ()

    @property
    def hard(self) -> tuple:
        return self.large + self.large_soft + self.small


def _has_magnitude_word(narration: str, value: int) -> bool:
    norm = normalize_text(narration)
    return bool((_MILLION_WORDS if value >= 10 ** 6 else _THOUSAND_WORDS).search(norm))


def shipped_number_findings(script) -> NumberFindings:
    """Every number or year in the title, the A/B title, the thumbnail text or the description that
    the narration does not back.

    Free and deterministic: no model. A figure matches however it is grouped ("1,000,000" is
    "1000000", "900 000" is "900,000"), with its thousand / million / billion ("1.5 million" is
    "one and a half million"), in any digits, or as an English spelled-out number or year. Not read:
    ordinals ("20th", and an ordinal in the narration is not a quantity either), links, timestamp,
    hashtag, credit, thank-you, source and series ("Part 2") lines of the description.

    A 2-30 integer in a headline (see ``_is_count_candidate``) is backed when the narration enumerates that
    many items, the script has that many sections, or the narration says "N <noun>"; its digit alone, found
    anywhere, does not back it. Unbacked, it is a ``counts`` finding (a warning) in a list headline and a
    ``small`` figure otherwise. Any other figure goes to ``large`` / ``large_soft`` (3+ digits, a year, a
    percentage) or ``small``. A figure of the description goes to ``description``. Never raises."""
    try:
        sections = _section_texts(script)
        narration = "\n\n".join(sections)
        known, big = set(), False
        for _tok, _s, _e, forms, ordinal in _digit_tokens(narration):
            if not ordinal:
                known |= forms
                big = big or len(re.sub(r"\D", "", _tok)) >= 2
        known |= _spoken_numbers(narration)
        enumerated, n_sections = _enumerators(narration), len([t for t in sections if t.strip()])
        fields = [(SOURCE_TITLE, _field_text(script, "title")),
                  (SOURCE_TITLE_AB, _field_text(script, "title_ab")),
                  (SOURCE_THUMBNAIL, _field_text(script, "thumbnail_overlay_text")),
                  (SOURCE_DESCRIPTION, " ".join(_description_units(_field_text(script, "description"),
                                                                    keep_sources=False)))]
        large, large_soft, small, counts, description, seen = [], [], [], [], [], set()
        for field, text in fields:
            ascii_text = _ascii_digits(text)
            for token, start, end, forms, ordinal in _digit_tokens(text):
                if ordinal or (field, token) in seen:
                    continue
                seen.add((field, token))
                if _is_count_candidate(field, token, forms, ascii_text, start, end):
                    if not (_count_is_backed(int(token), _count_nouns(ascii_text, end), narration, enumerated,
                                             n_sections)
                            or _name_backed(ascii_text, start, int(token), narration)):
                        (counts if _listicle_context(ascii_text, start, end) else small).append((field, token))
                    continue
                if forms & known:
                    continue
                if field == SOURCE_DESCRIPTION:
                    description.append((field, token))
                    continue
                value = max((int(f) for f in forms if f.isdigit()), default=0)
                if len(str(value)) >= 3 or ascii_text[end:end + 1] == "%":
                    year = bool(re.fullmatch(r"[12]\d{3}", token)) and 1000 <= value <= 2100
                    soft = (not big and not year
                            and not (value >= 1000 and not _has_magnitude_word(narration, value)))
                    (large_soft if soft else large).append((field, token))
                else:
                    small.append((field, token))
        return NumberFindings(tuple(large), tuple(large_soft), tuple(small), tuple(counts), tuple(description))
    except Exception:
        return NumberFindings()
