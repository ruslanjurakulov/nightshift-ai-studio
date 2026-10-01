"""The words a captions job (migration 0059) is allowed to keep.

A speech-to-text provider hears a recording the customer uploaded and answers
with words and their times. Whatever was SAID in it is data from outside:
this module turns the provider's answer (or the pipeline's own Whisper
timestamps, ``SubtitleGenerator.transcribe``) into one list of words the
database accepts — and nothing else gets through:

* only words survive (the vendor's "spacing" and "audio event" entries such as
  "(laughter)" are not caption text), with control characters, zero-width and
  bidi marks removed and whitespace collapsed, at most 80 characters each;
* times are seconds rounded to milliseconds, never negative, never NaN, and
  strictly forward: a word never starts before the one before it ended, and a
  word is never zero-length (a zero-length word cannot be shown);
* with a known recording length, times are clamped inside it — a provider's
  rounding past the end is not a caption after the video;
* more than :data:`MAX_WORDS` words is refused, not cut: a track missing its
  tail would read as a complete transcript (CLAUDE.md #4, #5);
* nothing usable at all (a silent recording) is :class:`NoSpeech` — the job
  fails and the hold is released, an empty transcript is never charged.

What is stored is ``[{"t": word, "s": start, "e": end}, ...]``. Lines on screen
(cues), their style and the SRT / WebVTT files are made from it in the browser
(command-center/lib/captions.ts).
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any, Iterable, List, Mapping, Optional, Tuple

#: 0059's bound on a track (store_caption_track).
MAX_WORDS = 20000
MAX_WORD_CHARS = 80
#: The shortest a word is shown for when the provider gave none (seconds).
MIN_WORD_S = 0.05
#: A word may run this far past the recording's end (provider rounding).
END_SLACK_S = 1.0

#: The base language tag the database stores, from the three-letter code some
#: providers answer with (ISO 639-3). Unknown codes stay as given (2-3 letters).
_THREE_TO_TWO = {"uzb": "uz", "uzn": "uz", "rus": "ru", "eng": "en", "tur": "tr", "kaz": "kk", "tgk": "tg",
                 "ukr": "uk", "deu": "de", "fra": "fr", "spa": "es", "ara": "ar", "zho": "zh", "kir": "ky"}
_LANG = re.compile(r"^[a-z]{2,3}$")


class CaptionsError(ValueError):
    """The answer cannot become a caption track. ``code`` is stored on the job
    (a lower-case word) and names the remedy for the person."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class NoSpeech(CaptionsError):
    def __init__(self, message: str = "no speech was found in the recording"):
        super().__init__("no_speech", message)


def base_language(code: Any) -> Optional[str]:
    """``uz`` from "uz", "UZB", "uz-Latn"; None when it is not a language tag."""
    if not isinstance(code, str):
        return None
    c = code.strip().lower().replace("_", "-").split("-")[0]
    c = _THREE_TO_TWO.get(c, c)
    return c if _LANG.match(c) else None


def _clean_word(text: Any) -> str:
    s = str(text if text is not None else "")
    out = []
    for ch in s:
        cat = unicodedata.category(ch)
        if ch in "\n\t\r":
            out.append(" ")
        elif cat.startswith("C"):
            # Control, format (zero-width, bidi overrides), private use.
            continue
        else:
            out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).strip()[:MAX_WORD_CHARS].strip()


def _seconds(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def clean_words(raw: Iterable[Mapping[str, Any]], *, duration_s: Optional[float] = None) -> List[dict]:
    """``[{"t", "s", "e"}]`` from ``[{"t"|"text"|"word", "s"|"start", "e"|"end"}]``
    (module doc). Raises :class:`NoSpeech` when nothing is left and
    :class:`CaptionsError` (``too_many_words``) past :data:`MAX_WORDS`."""
    items: List[Tuple[float, float, str]] = []
    for w in raw:
        if not isinstance(w, Mapping):
            continue
        text = _clean_word(w.get("t", w.get("text", w.get("word"))))
        start = _seconds(w.get("s", w.get("start")))
        end = _seconds(w.get("e", w.get("end")))
        # A word with no usable time cannot be shown; it is skipped, not guessed.
        if not text or start is None or end is None or start < 0:
            continue
        items.append((start, end, text))
    # Providers answer in time order; a stable sort repairs a rare swap
    # without reordering words that share a start.
    items.sort(key=lambda x: x[0])
    limit = None if duration_s is None or duration_s <= 0 else float(duration_s) + END_SLACK_S
    out: List[dict] = []
    prev_end = 0.0
    for start, end, text in items:
        start = max(start, prev_end)
        if limit is not None:
            if start >= limit:
                continue
            end = min(end, limit)
        if end <= start:
            end = start + MIN_WORD_S
        out.append({"t": text, "s": round(start, 3), "e": round(end, 3)})
        prev_end = out[-1]["e"]
    if not out:
        raise NoSpeech()
    if len(out) > MAX_WORDS:
        raise CaptionsError("too_many_words", f"the recording has more than {MAX_WORDS} words; trim it first")
    return out


def words_from_vendor(body: Any) -> Tuple[Optional[str], List[dict]]:
    """(language, raw words) from a speech-to-text answer of the shape
    ``{"language_code", "text", "words": [{"text", "start", "end", "type"}]}``.
    Only ``type == "word"`` entries are words. The multichannel shape
    (``transcripts``) is not asked for and is refused: reading one channel of
    two would be a silent partial transcript."""
    if not isinstance(body, Mapping):
        raise CaptionsError("bad_response", "the transcript is not an object")
    words = body.get("words")
    if not isinstance(words, list):
        raise CaptionsError("bad_response", "the transcript has no words")
    kept = [w for w in words if isinstance(w, Mapping) and w.get("type", "word") == "word"]
    return base_language(body.get("language_code")), kept


def words_from_whisper(words: Iterable[Mapping[str, Any]]) -> List[dict]:
    """The pipeline's own word timestamps (``SubtitleGenerator.transcribe``:
    ``{"word", "start", "end"}``) as track words — timing the pipeline already
    paid for is reused, never transcribed twice."""
    return clean_words(words)


def track_json(language: Optional[str], words: List[dict]) -> dict:
    """What an adapter hands the worker: the language the words are in (None =
    unknown) and the raw words; the worker cleans them again."""
    return {"language": language, "words": words}
