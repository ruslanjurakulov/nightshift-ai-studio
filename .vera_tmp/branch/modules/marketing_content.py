"""What the marketing worker may draft (docs/MARKETING_POSTS.md): news and promo from reviewed files, and the price post.

Pure functions, no I/O except reading ``docs/news/*.json`` and ``docs/promo/*.json``. Three sources, and only these:

* ``docs/news/<yyyy-mm-dd>-<slug>.json`` with ``"public": true``: words a person wrote and reviewed in a pull
  request. The worker re-checks the shape and the banned-claims list at runtime because the image it runs in is
  built from a commit, not from a green CI run.
* ``docs/promo/<slug>.json`` with ``"public": true`` (migration 0110): a promo post, words a person wrote and
  reviewed in a pull request, each with the evidence (a file or page in this repository) that proves what it says.
  Same re-check at runtime, plus: not past ``valid_until``, no AI media flag, every figure named in an evidence claim.
* The plans the database holds (names, credits per month, concurrency). **No currency amount, ever**: the
  database has none, and a figure typed from memory is exactly what rule 5 of CLAUDE.md forbids. If any fact is
  missing or unreadable the price post is NOT produced; there is no default.

Nothing here approves, schedules or sends anything. A draft is a row a person has yet to read.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import math
import re
import stat as stat_mod
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

REPO_DIR = Path(__file__).resolve().parent.parent
NEWS_DIR = REPO_DIR / "docs" / "news"
PROMO_DIR = REPO_DIR / "docs" / "promo"

LANGS = ("uz", "ru", "en")
#: A news item whose `shipped` date is older than this is not drafted. The worker cannot see the database
#: switch, and a draft nobody approves expires after 30 days and uses up its key for good, so drafting a
#: backlog at the first start would burn it. Flip an item to `public: true` within this many days of
#: shipping, or edit its date (docs/MARKETING_POSTS.md).
NEWS_MAX_AGE_DAYS = 30
TEXT_MIN, TEXT_MAX = 20, 260
_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$")
_LINK = re.compile(r"^/[a-z0-9][a-z0-9/_-]{0,78}$")
_APOSTROPHES = str.maketrans({"ʻ": "'", "ʼ": "'", "‘": "'", "’": "'", "`": "'", "´": "'", "ё": "е"})

# ── banned wording ──────────────────────────────────────────────────────────


def _normal(text: str) -> str:
    return text.casefold().translate(_APOSTROPHES)


def banned_hits(text: str, news_dir: Path = NEWS_DIR) -> List[str]:
    """Rule ids and ``provider:<name>`` that ``text`` trips, from docs/news/banned-claims.json.

    Raises when the list cannot be read: a post must never be drafted against a list that is missing."""
    data = json.loads((news_dir / "banned-claims.json").read_text(encoding="utf-8"))
    t = _normal(text)
    hits = [r["id"] for r in data["rules"] if any(re.search(p, t, re.I) for p in r["patterns"])]
    for name in data["provider_names"]["names"]:
        if re.search(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", t, re.I):
            hits.append("provider:" + name)
    return hits


#: A reviewed file is a few hundred bytes to a few kilobytes; anything bigger is not read at all.
MAX_FILE_BYTES = 64 * 1024


class _DuplicateKey(ValueError):
    pass


def _no_duplicate_keys(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in pairs:
        if k in out:
            raise _DuplicateKey(k)           # the last of two equal keys silently winning is how a review is bypassed
        out[k] = v
    return out


def _read_json(path: Path) -> Tuple[Any, Optional[str]]:
    """(parsed value, None) or (None, reason): ``symlink`` (a link may point outside the folder), ``too_large``,
    ``unreadable`` (cannot be read, not JSON, a repeated key, or nested so deeply that parsing gives up). Never raises."""
    try:
        st = path.lstat()
        if not stat_mod.S_ISREG(st.st_mode):
            return None, "symlink" if stat_mod.S_ISLNK(st.st_mode) else "unreadable"
        if st.st_size > MAX_FILE_BYTES:
            return None, "too_large"
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_no_duplicate_keys), None
    except (OSError, ValueError, RecursionError):
        return None, "unreadable"


# ── a draft, as marketing_draft_upsert takes it ─────────────────────────────

@dataclass(frozen=True)
class Draft:
    key: str
    kind: str
    texts: Dict[str, str]
    source_ref: str
    link: Optional[str] = None
    facts: Dict[str, Any] = field(default_factory=dict)
    facts_as_of: Optional[str] = None


# ── news ────────────────────────────────────────────────────────────────────

def _news_problem(item: Any, stem_date: str, today: _dt.date) -> Optional[str]:
    if not isinstance(item, dict):
        return "not_an_object"
    pr = item.get("pr")
    if isinstance(pr, bool) or not isinstance(pr, int) or pr < 1:
        return "bad_pr"
    shipped = item.get("shipped")
    try:
        if not isinstance(shipped, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", shipped):
            raise ValueError
        day = _dt.date.fromisoformat(shipped)
    except ValueError:
        return "bad_shipped"
    if shipped != stem_date or day > today:
        return "bad_shipped"
    if item.get("kind") not in ("feature", "fix"):
        return "bad_kind"
    text = item.get("text")
    if not isinstance(text, dict) or set(text) != set(LANGS):
        return "bad_text"
    for lang in LANGS:
        v = text[lang]
        if not isinstance(v, str) or not (TEXT_MIN <= len(v.strip()) <= TEXT_MAX) or v != v.strip():
            return "bad_text"
    link = item.get("link")
    if link is not None and (not isinstance(link, str) or not _LINK.match(link) or "//" in link or ".." in link):
        return "bad_link"
    return None


def load_news(news_dir: Path = NEWS_DIR, today: Optional[_dt.date] = None) -> Tuple[List[Draft], Dict[str, int]]:
    """Every ``public: true`` item that passes the runtime checks, and a count of what was skipped and why.

    ``public`` must be the JSON value ``true``; a missing key, ``"true"`` or ``1`` is a no. A file that
    cannot be read or parsed is skipped by name-free reason code, never raised: one bad file must not stop
    the others, and its path is not logged."""
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    drafts: List[Draft] = []
    skipped: Dict[str, int] = {}

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for path in sorted(news_dir.glob("*.json")):
        m = _FILE.match(path.name)
        if not m:
            continue                         # schema.json, banned-claims.json
        item, bad = _read_json(path)
        if bad:
            skip(bad)
            continue
        if not isinstance(item, dict) or item.get("public") is not True:
            skip("not_public")
            continue
        problem = _news_problem(item, m.group(1), today)
        if problem:
            skip(problem)
            continue
        if (today - _dt.date.fromisoformat(item["shipped"])).days > NEWS_MAX_AGE_DAYS:
            skip("too_old")
            continue
        try:
            joined = "\n".join(item["text"][lang] for lang in LANGS)
            if banned_hits(joined, news_dir):
                skip("banned_claim")
                continue
        except (OSError, ValueError, KeyError, RecursionError):
            skip("banned_list_unreadable")
            continue
        slug = m.group(2)
        drafts.append(Draft(
            key=f"news:{slug}", kind="news", texts={lang: item["text"][lang].strip() for lang in LANGS},
            source_ref=f"pr:#{item['pr']}", link=item.get("link"),
            facts={"file": path.name, "shipped": item["shipped"], "item_kind": item["kind"]}))
    return drafts, skipped


# ── promo: docs/promo/<slug>.json (migration 0110) ──────────────────────────

PROMO_KEYS = ("slug", "public", "link", "texts", "evidence", "valid_until", "ai_media")
PROMO_TEXT_MIN, PROMO_TEXT_MAX = 20, 700
EVIDENCE_MAX, CLAIM_MIN, CLAIM_MAX = 10, 10, 300
#: marketing_posts.facts holds at most 8192 bytes; the worker keeps clear of it.
PROMO_FACTS_MAX_BYTES = 8000
PROMO_FILE = re.compile(r"^([a-z0-9-]{1,60})\.json$")
#: A repository path (no leading slash, no ``..``; the brackets and parentheses of Next.js route folders are allowed)
#: or an https URL.
_EVIDENCE_PATH = re.compile(r"^[A-Za-z0-9._/\[\]()@+-]{1,200}$")
_EVIDENCE_URL = re.compile(r"^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/%?&=#:@+-]*)?$")
_HIDDEN = re.compile("[​-‏ -‮⁠-⁤⁦-⁩﻿­]")
_CONTROL_NO_NEWLINE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def evidence_source_ok(source: Any) -> bool:
    """A path in this repository (shape only; CI checks that it exists) or an https URL."""
    if not isinstance(source, str) or len(source) > 200:
        return False
    if _EVIDENCE_URL.match(source):
        return True
    return bool(_EVIDENCE_PATH.match(source)) and not source.startswith("/") and ".." not in source and "//" not in source


def promo_problem(item: Any, stem: str, today: _dt.date) -> Optional[str]:
    """The reason code a promo file is refused for (``bad_*``, ``expired``, ``numbers_differ``), or None.

    ``stem`` is the file name without ``.json``: it must equal ``slug``. ``public`` is the caller's concern (a file
    that is not ``public: true`` is not a candidate at all). Does NOT check the banned-claims list (the caller does,
    against the list it was given) and does NOT check that an evidence path exists (the image holds no command-center/;
    tests/test_promo_format.py checks the paths in CI)."""
    if not isinstance(item, dict):
        return "not_an_object"
    if set(item) != set(PROMO_KEYS):
        return "bad_keys"
    slug = item["slug"]
    if not isinstance(slug, str) or not PROMO_FILE.match(slug + ".json") or slug != stem:
        return "bad_slug"
    if not isinstance(item["public"], bool):
        return "bad_public"
    link = item["link"]
    if link is not None and (not isinstance(link, str) or not _LINK.match(link) or "//" in link or ".." in link):
        return "bad_link"
    if item["ai_media"] is not False:
        return "bad_ai_media"       # no promo carries media in this slice: a flag that says otherwise is a mistake
    until = item["valid_until"]
    if until is not None:
        try:
            if not isinstance(until, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", until):
                raise ValueError
            last_day = _dt.date.fromisoformat(until)
        except ValueError:
            return "bad_valid_until"
        if today > last_day:
            return "expired"
    texts = item["texts"]
    if not isinstance(texts, dict) or set(texts) != set(LANGS):
        return "bad_texts"
    for lang in LANGS:
        v = texts[lang]
        if (not isinstance(v, str) or v != v.strip() or not (PROMO_TEXT_MIN <= len(v) <= PROMO_TEXT_MAX)
                or _CONTROL_NO_NEWLINE.search(v) or _HIDDEN.search(v)):
            return "bad_texts"
    evidence = item["evidence"]
    if not isinstance(evidence, list) or not (1 <= len(evidence) <= EVIDENCE_MAX):
        return "bad_evidence"
    for e in evidence:
        if (not isinstance(e, dict) or set(e) != {"claim", "source"} or not isinstance(e["claim"], str)
                or e["claim"] != e["claim"].strip() or not (CLAIM_MIN <= len(e["claim"]) <= CLAIM_MAX)
                or not evidence_source_ok(e["source"])):
            return "bad_evidence"
    # A figure must be the same in every language, and be named in an evidence claim (which is what proves it).
    figures = {lang: sorted(_NUMBER.findall(texts[lang])) for lang in LANGS}
    if len({tuple(v) for v in figures.values()}) != 1:
        return "numbers_differ"
    claimed = "\n".join(e["claim"] for e in evidence)
    if any(n not in _NUMBER.findall(claimed) for n in figures["en"]):
        return "bad_evidence"
    facts = _promo_facts(item, stem)
    if len(json.dumps(facts, ensure_ascii=False).encode("utf-8")) > PROMO_FACTS_MAX_BYTES:
        return "bad_evidence"
    return None


def _promo_facts(item: Mapping[str, Any], stem: str) -> Dict[str, Any]:
    """What is stored beside the words so the owner can see what backs them. Deterministic: the same file gives the
    same facts, so a second pass changes nothing."""
    return {"file": stem + ".json", "valid_until": item["valid_until"],
            "evidence": [{"claim": e["claim"], "source": e["source"]} for e in item["evidence"]]}


def load_promo(promo_dir: Path = PROMO_DIR, today: Optional[_dt.date] = None,
               news_dir: Path = NEWS_DIR) -> Tuple[List[Draft], Dict[str, int], List[Tuple[str, str, str]]]:
    """Every ``public: true`` promo file that passes the runtime checks, a count of what was skipped and why, and
    ``(slug, reason, detail)`` notes for the log (detail: the banned rule ids, otherwise empty; never the words).

    ``public`` must be the JSON value ``true``. One bad file never stops the others. The banned list is read from
    ``news_dir`` (one list for every kind of post); if it cannot be read nothing is drafted."""
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    drafts: List[Draft] = []
    skipped: Dict[str, int] = {}
    notes: List[Tuple[str, str, str]] = []

    def skip(slug: str, reason: str, detail: str = "") -> None:
        skipped[reason] = skipped.get(reason, 0) + 1
        notes.append((slug, reason, detail))

    for path in sorted(promo_dir.glob("*.json")):
        m = PROMO_FILE.match(path.name)
        if not m:
            continue
        stem = m.group(1)
        item, bad = _read_json(path)
        if bad:
            skip(stem, bad)
            continue
        if not isinstance(item, dict) or item.get("public") is not True:
            skipped["not_public"] = skipped.get("not_public", 0) + 1
            continue
        problem = promo_problem(item, stem, today)
        if problem:
            skip(stem, problem)
            continue
        try:
            hits = banned_hits("\n".join(item["texts"][lang] for lang in LANGS), news_dir)
        except (OSError, ValueError, KeyError, RecursionError):
            skip(stem, "banned_list_unreadable")
            continue
        if hits:
            skip(stem, "banned_claim", ",".join(hits))
            continue
        drafts.append(Draft(
            key=f"promo:{stem}:telegram", kind="promo", texts={lang: item["texts"][lang] for lang in LANGS},
            source_ref=f"promo:{stem}", link=item["link"], facts=_promo_facts(item, stem)))
    return drafts, skipped, notes


# ── the price post: plans and entitlements, and nothing else ────────────────

_PLAN_ID = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
_PLAN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 +&._-]{0,39}$")


def _number(value: Any) -> Optional[Decimal]:
    """A finite, positive number as the database returned it, or None. A bool, a string, NaN is not one."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        d = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
    except InvalidOperation:
        return None
    return d if d.is_finite() and d > 0 else None


def _fmt(d: Decimal) -> str:
    text = format(d.normalize(), "f")
    return text


def _plan_facts(plans: Sequence[Mapping[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """Validate rows ``{id, name, monthly_credits, concurrency}``; None when any is unusable."""
    out: List[Dict[str, Any]] = []
    for p in plans:
        pid, name = p.get("id"), p.get("name")
        credits = _number(p.get("monthly_credits"))
        conc = p.get("concurrency")
        if not isinstance(pid, str) or not _PLAN_ID.match(pid) or not isinstance(name, str) or not _PLAN_NAME.match(name):
            return None
        if credits is None or isinstance(conc, bool) or not isinstance(conc, int) or not (1 <= conc <= 100000):
            return None
        out.append({"id": pid, "name": name, "monthly_credits": int(credits) if credits == credits.to_integral_value()
                    else float(credits), "concurrency": conc, "_credits_text": _fmt(credits)})
    return out or None


_TEMPLATES = {
    "en": ("Nightshift plans and what they include:", "{name} — credits per month: {credits}; runs at once: {conc}"),
    "ru": ("Тарифы Nightshift и что в них входит:", "{name} — кредитов в месяц: {credits}; одновременных запусков: {conc}"),
    "uz": ("Nightshift tariflari va ularga nimalar kiradi:", "{name} — oyiga kredit: {credits}; bir vaqtda ishga tushirishlar: {conc}"),
}


def price_draft(plans: Sequence[Mapping[str, Any]], now: _dt.datetime, news_dir: Path = NEWS_DIR) -> Optional[Draft]:
    """The price post for this month from verified plan facts, or None.

    No currency amount appears in it: only the plan name, credits per month and concurrency, all read from
    ``plans`` / ``plan_entitlements`` by the caller. One key per month per plan set
    (``price:<plan ids>:<yyyy-mm>``), so the database never lets a second one be drafted. A text that trips the
    banned-claims list (a plan renamed to "Free", say) yields no post."""
    facts = _plan_facts(plans)
    if facts is None:
        return None
    now = now.astimezone(_dt.timezone.utc)
    texts: Dict[str, str] = {}
    for lang in LANGS:
        head, row = _TEMPLATES[lang]
        texts[lang] = "\n".join([head] + [row.format(name=f["name"], credits=f["_credits_text"], conc=f["concurrency"])
                                          for f in facts])
    try:
        if banned_hits("\n".join(texts.values()), news_dir):
            return None
    except (OSError, ValueError, KeyError):
        return None
    ids = ",".join(f["id"] for f in facts)
    plan_set = ids if len(ids) <= 60 else "h" + hashlib.sha256(ids.encode()).hexdigest()[:20]
    month = f"{now.year:04d}-{now.month:02d}"
    return Draft(
        key=f"price:{plan_set}:{month}", kind="price", texts=texts, source_ref=f"plan:{plan_set}", link="/pricing",
        facts={"plans": [{k: v for k, v in f.items() if not k.startswith("_")} for f in facts],
               "source": "plans+plan_entitlements"},
        facts_as_of=now.replace(microsecond=0).isoformat())
