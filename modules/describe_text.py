"""The text a "Describe image" job (migration 0055) is allowed to keep.

A vision model reads a picture the customer uploaded. Whatever is written IN
that picture — a sign, a caption, a screenshot of a chat — reaches the model
as part of its input, and a picture can be made to say "ignore your
instructions and …". The model is told not to copy such text, but a model is
not a filter, so its answer is cleaned here as well, before it is stored, shown
in the Studio or put into a prompt box:

* only plain prose survives: control characters, markdown fences, bullets,
  headings and "Prompt:"-style labels are removed, whitespace is collapsed;
* web addresses, e-mail addresses and @handles are removed — nothing in a
  description should send anyone anywhere;
* a sentence that reads as an instruction to a system (ignore / disregard the
  previous instructions, "system prompt", "you are now …", a role label, a
  template token) is dropped whole, not edited;
* the result is cut to :data:`MAX_CHARS` on a word boundary.

What is left is text a person reads and edits before anything is generated
from it: "Make similar" only fills the text-to-image form.
"""

from __future__ import annotations

import re
import unicodedata

#: The longest description kept (0055's CHECK on creative_jobs.result.text).
MAX_CHARS = 600

_URL = re.compile(r"(?i)\b(?:https?://|ftp://|www\.)\S+")
_DOMAIN = re.compile(r"(?i)\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|ru|uz|app|dev|co)\b(?:/\S*)?")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{2,}")
_FENCE = re.compile(r"```(?:[a-zA-Z]+\n)?|`")
_LABEL = re.compile(r"(?im)^\s*(?:#+\s*)?(?:\*\*)?\s*(?:prompt|description|image prompt|caption|tavsif|описание|промпт)\s*(?:\*\*)?\s*[:：-]\s*")
_BULLET = re.compile(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+")
_EMPHASIS = re.compile(r"\*{1,3}|_{2,}")

#: A sentence that addresses a system rather than describing a picture.
_INSTRUCTION = re.compile(
    r"(?i)("
    r"\b(ignore|disregard|forget|override|bypass)\b[^.!?]{0,40}\b(instruction|instructions|prompt|rules|above|previous|prior|system)\b"
    r"|\bsystem\s*prompt\b|\bdeveloper\s*mode\b|\bjail\s*break\b"
    r"|\byou\s+(are|must|should|will)\s+(now\s+)?(an?\s+)?(ai|assistant|model|chatbot|gpt)\b"
    r"|\bas\s+an?\s+(ai|language\s+model)\b"
    r"|\b(do\s+not|don't)\s+follow\b"
    r"|^\s*(system|assistant|user|developer)\s*[:：]"
    r"|<\|[^|]*\|>|\[/?inst\]|\{\{|\}\}|<\s*/?\s*(system|script|instructions?)\b"
    r"|игнорир\w*\s+(все\s+)?(предыдущ|инструкц)|системн\w+\s+промпт"
    r"|oldingi\s+ko'rsatma|ko'rsatmalarni\s+e'tiborsiz"
    r")"
)
_SENTENCE = re.compile(r"[^.!?。]+[.!?。]*")


def _strip_controls(text: str) -> str:
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if ch in "\n\t":
            out.append(" ")
        elif cat.startswith("C"):
            # Control, format (zero-width, bidi overrides), private use: none
            # belongs in a description, and bidi marks can hide text.
            continue
        else:
            out.append(ch)
    return "".join(out)


def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = text[:limit]
    # End on a sentence if one ends late enough, else on a word.
    stop = max(head.rfind(". "), head.rfind("! "), head.rfind("? "))
    if stop >= limit * 0.6:
        return head[: stop + 1].strip()
    space = head.rfind(" ")
    return (head[:space] if space > limit * 0.5 else head).rstrip(" ,;:-")


def clean_description(text: str, max_chars: int = MAX_CHARS) -> str:
    """The description as it may be stored and shown (module doc). '' when
    nothing usable is left — the caller then fails the job and the hold is
    released, rather than charging for an empty answer."""
    s = str(text or "")
    s = _FENCE.sub(" ", s)
    s = _LABEL.sub("", s)
    s = _BULLET.sub("", s)
    s = _strip_controls(s)
    s = _EMPHASIS.sub("", s)
    s = _URL.sub(" ", s)
    s = _EMAIL.sub(" ", s)
    s = _DOMAIN.sub(" ", s)
    s = _HANDLE.sub(" ", s)
    kept = [m.group(0).strip() for m in _SENTENCE.finditer(s)]
    kept = [k for k in kept if k and not _INSTRUCTION.search(k)]
    s = " ".join(kept)
    s = re.sub(r"\s+", " ", s).strip().strip("\"'«»“”")
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    # Nothing but punctuation is not a description.
    if not re.search(r"\w", s):
        return ""
    return _cut(s, max_chars)
