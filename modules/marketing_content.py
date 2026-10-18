"""What the marketing worker may draft (docs/MARKETING_POSTS.md): news from reviewed files, and the price post.

Pure functions, no I/O except reading ``docs/news/*.json``. Two sources, and only two:

* ``docs/news/<yyyy-mm-dd>-<slug>.json`` with ``"public": true``: words a person wrote and reviewed in a pull
  request. The worker re-checks the shape and the banned-claims list at runtime because the image it runs in is
  built from a commit, not from a green CI run.
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
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

REPO_DIR = Path(__file__).resolve().parent.parent
NEWS_DIR = REPO_DIR / "docs" / "news"

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
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            skip("unreadable")
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
        except (OSError, ValueError, KeyError):
            skip("banned_list_unreadable")
            continue
        slug = m.group(2)
        drafts.append(Draft(
            key=f"news:{slug}", kind="news", texts={lang: item["text"][lang].strip() for lang in LANGS},
            source_ref=f"pr:#{item['pr']}", link=item.get("link"),
            facts={"file": path.name, "shipped": item["shipped"], "item_kind": item["kind"]}))
    return drafts, skipped


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
