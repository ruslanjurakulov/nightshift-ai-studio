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
_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


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
    if stripped.endswith("?"):
        return False
    if len(stripped.split()) < MIN_CLAIM_WORDS:
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

    @property
    def scene_id(self) -> str:
        return scene_id(self.section_index)


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
