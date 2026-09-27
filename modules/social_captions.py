"""Per-platform post text from a video's existing metadata — deterministic.

The pipeline already wrote a title, a description and tags for YouTube (the
script, ``output/<slug>/script.json``) and the channel has a niche. Cross-posting
reuses those words; nothing is generated here and no model is called, so the
same video always gets the same caption. Each platform's limits are enforced
by trimming at a word boundary, never by cutting a word or a hashtag in half.

Limits (official docs):

* YouTube — title ≤ 100 characters, description ≤ 5000 bytes, tags ≤ 500
  characters in total.
  https://developers.google.com/youtube/v3/docs/videos#properties
* Instagram — caption ≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @-mentions.
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
* TikTok — the post's ``title`` (its caption, hashtags included) ≤ 2200 UTF-16
  code units.
  https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence

YT_TITLE_MAX = 100
YT_DESCRIPTION_MAX_BYTES = 5000
YT_TAGS_MAX_CHARS = 500

IG_CAPTION_MAX = 2200
IG_HASHTAGS_MAX = 30
IG_MENTIONS_MAX = 20
IG_HASHTAGS_DEFAULT = 15

TT_CAPTION_MAX_UTF16 = 2200
TT_HASHTAGS_DEFAULT = 5
TT_DESCRIPTION_MAX = 300

HASHTAG_MAX_LEN = 50
ELLIPSIS = "…"

_TIMESTAMP_LINE = re.compile(r"^\s*(\d{1,2}:)?\d{1,2}:\d{2}\b")
_WS = re.compile(r"[ \t]+")
_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9._]{1,30})")
_HASHTAG_IN_TEXT = re.compile(r"(?<![\w#])#(\w+)", re.UNICODE)


@dataclass(frozen=True)
class SourceMeta:
    """What the pipeline already has for one video."""

    title: str = ""
    description: str = ""
    tags: Sequence[str] = field(default_factory=tuple)
    niche: str = ""
    topic: str = ""


@dataclass(frozen=True)
class YouTubeMeta:
    title: str
    description: str
    tags: List[str]


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _clean(text: str) -> str:
    """Normalise whitespace; drop chapter/timestamp lines (they mean nothing
    outside YouTube); keep paragraphs."""
    lines = []
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        if _TIMESTAMP_LINE.match(line):
            continue
        lines.append(_WS.sub(" ", line).strip())
    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def trim(text: str, limit: int, measure=len) -> str:
    """``text`` cut to fit ``limit`` (by ``measure``), at a word boundary, with
    an ellipsis. Deterministic; never returns more than ``limit``."""
    text = (text or "").strip()
    if measure(text) <= limit:
        return text
    if limit <= measure(ELLIPSIS):
        return ""
    # Shrink by characters until it fits with the ellipsis, then back off to
    # the last whitespace so no word is cut.
    cut = text
    while cut and measure(cut.rstrip() + ELLIPSIS) > limit:
        cut = cut[:-1]
    space = max(cut.rfind(" "), cut.rfind("\n"))
    if space > len(cut) // 2:
        cut = cut[:space]
    cut = cut.rstrip(" \n,.;:-–—")
    return (cut + ELLIPSIS) if cut else ""


def hashtag(word: str) -> Optional[str]:
    """``"ancient rome"`` → ``"#AncientRome"``. Letters/digits/underscore only
    (Unicode letters kept); None when nothing usable is left."""
    word = unicodedata.normalize("NFKC", word or "").strip().lstrip("#")
    parts = re.findall(r"\w+", word, re.UNICODE)
    if not parts:
        return None
    if len(parts) == 1:
        body = parts[0]
    else:
        body = "".join(p[:1].upper() + p[1:] for p in parts)
    body = body[:HASHTAG_MAX_LEN]
    if not body or body.isdigit():
        return None
    return "#" + body


def hashtags(sources: Iterable[str], limit: int) -> List[str]:
    """Unique hashtags (case-insensitive), in the order given, at most ``limit``."""
    out: List[str] = []
    seen = set()
    for s in sources:
        tag = hashtag(s)
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
        if len(out) >= limit:
            break
    return out


def _tag_sources(meta: SourceMeta) -> List[str]:
    return [*(t for t in meta.tags if t), *( [meta.niche] if meta.niche else [])]


def _strip_inline_hashtags(text: str) -> str:
    return _WS.sub(" ", _HASHTAG_IN_TEXT.sub("", text)).strip()


def _limit_mentions(text: str, max_mentions: int) -> str:
    """Keep the first ``max_mentions`` @-mentions; later ones lose their @."""
    count = 0

    def repl(m):
        nonlocal count
        count += 1
        return m.group(0) if count <= max_mentions else m.group(1)

    return _MENTION.sub(repl, text)


def _compose(head: str, body: str, tags: List[str], limit: int, measure) -> str:
    """head + blank line + body + blank line + tags, within ``limit``: the BODY
    is trimmed first, then tags are dropped from the end, then the head is
    trimmed."""

    def join(h: str, b: str, t: Sequence[str]) -> str:
        return "\n\n".join(p for p in (h, b, " ".join(t)) if p)

    full = join(head, body, tags)
    if measure(full) <= limit:
        return full
    if body:
        room = limit - measure(join(head, "", tags)) - measure("\n\n")
        if room > 20:
            text = join(head, trim(body, room, measure), tags)
            if measure(text) <= limit:
                return text
    kept = list(tags)
    while kept:
        text = join(head, "", kept)
        if measure(text) <= limit:
            return text
        kept.pop()
    return trim(head, limit, measure)


def youtube_metadata(meta: SourceMeta) -> YouTubeMeta:
    """Title + description + tags within YouTube's limits."""
    title = trim(_clean(meta.title or meta.topic).replace("\n", " "), YT_TITLE_MAX)
    title = title.replace("<", "").replace(">", "")  # YouTube rejects angle brackets
    desc = trim(_clean(meta.description).replace("<", "").replace(">", ""),
                YT_DESCRIPTION_MAX_BYTES, lambda s: len(s.encode("utf-8")))
    tags: List[str] = []
    total = 0
    seen = set()
    for t in meta.tags:
        t = _WS.sub(" ", (t or "").replace("<", "").replace(">", "").replace(",", " ")).strip()
        if not t or t.lower() in seen:
            continue
        # YouTube counts a tag with a space as if it were quoted (+2).
        cost = len(t) + (2 if " " in t else 0) + (1 if tags else 0)
        if total + cost > YT_TAGS_MAX_CHARS:
            break
        seen.add(t.lower())
        tags.append(t)
        total += cost
    return YouTubeMeta(title=title, description=desc, tags=tags)


def instagram_caption(meta: SourceMeta, *, max_hashtags: int = IG_HASHTAGS_DEFAULT) -> str:
    """Title, the description, then hashtags from the tags and niche.
    ≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @-mentions."""
    max_hashtags = max(0, min(max_hashtags, IG_HASHTAGS_MAX))
    # Hashtags come only from the tag line, so the 30-hashtag cap holds.
    head = _strip_inline_hashtags(_clean(meta.title or meta.topic).replace("\n", " "))
    body = _strip_inline_hashtags(_clean(meta.description))
    body = _limit_mentions(body, IG_MENTIONS_MAX - len(_MENTION.findall(head)))
    tags = hashtags(_tag_sources(meta), max_hashtags)
    return _compose(head, body, tags, IG_CAPTION_MAX, len)


def tiktok_caption(meta: SourceMeta, *, max_hashtags: int = TT_HASHTAGS_DEFAULT) -> str:
    """Title, a short description, a few hashtags. ≤ 2200 UTF-16 code units."""
    head = _strip_inline_hashtags(_clean(meta.title or meta.topic).replace("\n", " "))
    body = _strip_inline_hashtags(_clean(meta.description)).split("\n\n", 1)[0]
    body = trim(body, TT_DESCRIPTION_MAX)
    tags = hashtags(_tag_sources(meta), max(0, max_hashtags))
    return _compose(head, body, tags, TT_CAPTION_MAX_UTF16, utf16_len)


def caption_for(platform: str, meta: SourceMeta) -> str:
    if platform == "instagram":
        return instagram_caption(meta)
    if platform == "tiktok":
        return tiktok_caption(meta)
    raise ValueError("unknown platform")
