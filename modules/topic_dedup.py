"""Cheap, deterministic topic de-duplication — no model, no network, no cost.

Why this exists. ``TopicManager`` used to compare a new topic against history
only through the Gemini prompt ("do not repeat these") and the semantic
``OriginalityEngine``. The semantic check is skipped whenever the embedding
model cannot load (``_safe_originality_check`` returns None), and it was
configured with one store for every channel. This module is the floor under
both: it normalises a topic to a set of content words, so "The Fall of Rome",
"why ROME fell" and "Rome's falling" collapse to the same key, and it compares
that key to the channel's own recent topics.

What it is NOT: a semantic matcher. "The Roman Empire's collapse" shares no
content word with "Why Rome fell", and no word list will fix that — catching
paraphrases of that kind needs the embedding check (or a paid model call,
which is deliberately not made here). The stop-word and lemma lists are
English only; for another script it still folds case and accents and compares
whole words, which catches exact and reordered repeats but not inflections.
"""

from __future__ import annotations

import re
import unicodedata

# Words that carry no topic: articles, question words, and the filler a title
# generator adds to every title ("The Untold Story of ...", "... Explained").
_STOP = frozenset("""
a an the of in on at to for from by with and or but is are was were be been being
did do does done has have had it its this that these those you your we our their
why how what when where who whom which whose
story truth secret untold mystery explained revealed real really actually true
behind shocking ever
""".split())

# The few irregular forms that make "the fall of X" and "why X fell" the same
# topic. Deliberately tiny: every entry is a pair a title generator really
# produces, and a long list would start merging genuinely different topics.
_LEMMA = {
    "fell": "fall", "fallen": "fall", "falls": "fall", "falling": "fall",
    "rose": "rise", "risen": "rise",
    "sank": "sink", "sunk": "sink",
    "died": "death", "dead": "death", "dies": "death",
    "vanished": "vanish", "disappeared": "disappear",
}

#: Two topics are the same topic at or above this Jaccard overlap of content words.
JACCARD_THRESHOLD = 0.7
#: A topic whose content words are all inside a longer one's counts too, once it
#: has this many of them ("Lost Colony of Roanoke" inside "The Lost Colony of
#: Roanoke Island"); with fewer, containment is just a shared common word.
MIN_CONTAINED_WORDS = 3

_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _fold(text: str) -> str:
    """Case- and accent-insensitive form: 'Pompéi' and 'POMPEI' fold alike."""
    decomposed = unicodedata.normalize("NFKD", str(text or "").casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def _stem(word: str) -> str:
    word = _LEMMA.get(word, word)
    if len(word) > 4:
        if word.endswith("ies"):
            word = word[:-3] + "y"
        elif word.endswith("ing") and len(word) > 5:
            word = word[:-3]
        elif word.endswith("ed") and len(word) > 5:
            word = word[:-2]
        elif word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
    # 'empire'/'empires', 'rome'/'rome's' meet on the same stem.
    if len(word) > 3 and word.endswith("e"):
        word = word[:-1]
    return word


# 'secrets', 'mysteries', 'explaining' are filler too: compare stems to stems.
_STOP_STEMS = frozenset(_stem(w) for w in _STOP)


def content_words(topic: str) -> frozenset:
    """The topic reduced to its content words, folded and stemmed.

    Single letters are dropped (the ``s`` of "Rome's"); digits are kept, since
    "The Battle of 1066" and "The Battle of 1067" are different videos.
    """
    words = set()
    for raw in _WORD_RE.findall(_fold(topic)):
        stem = _stem(raw)
        if len(raw) >= 2 and stem not in _STOP_STEMS:
            words.add(stem)
    return frozenset(words)


def is_same_topic(a: str, b: str) -> bool:
    """Do these two topic strings name the same video?"""
    wa, wb = content_words(a), content_words(b)
    if not wa or not wb:
        # Nothing but stop words on one side: only the same words in the same order count.
        raw_a, raw_b = tuple(_WORD_RE.findall(_fold(a))), tuple(_WORD_RE.findall(_fold(b)))
        return bool(raw_a) and raw_a == raw_b
    if wa == wb:
        return True
    inter = len(wa & wb)
    if inter / len(wa | wb) >= JACCARD_THRESHOLD:
        return True
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return len(small) >= MIN_CONTAINED_WORDS and small <= big


def find_repeat(candidate: str, history) -> str | None:
    """The first topic in ``history`` that ``candidate`` repeats, or None."""
    for past in history:
        if is_same_topic(candidate, past):
            return past
    return None
