"""Storyboard review — stop before the expensive render until a person approves.

Off unless a channel turns it on (``channels.agent_config.storyboard_review``,
only an explicit ``true``). With it on, a run walks topic → research → script →
fact-check exactly as before and then stops at "Storyboard ready": before the
narration is synthesized, before any footage or still is generated, before the
render. What it stops with is one ``storyboards`` row (migration 0057) — the
scene cards a person reads (number, narration line, visual description, length)
and the script the render will resume from — and an exit code the runners know.

Why here and not later: the first paid generation for the scenes is the voice
(``AudioMixer.build``), then the b-roll and stills, then the render. Everything
before this point is the planning the run has always paid for; everything after
it is what the person is now asked to approve, at one price.

Before approving, a person may edit the storyboard (migration 0058): change a
scene's narration or visual description, delete, reorder or add scenes. The
database rewrites the scene cards AND the stored script together, so the
approved script below is the edited one; nothing here re-derives it.

How it continues: approving (``approve_storyboard`` in the Command Center)
places the render's credit hold and starts the SAME run again with
``--resume --topic <its topic>``. :func:`approved_for_resume` finds the approved
row for that run and writes its script to ``output/<slug>/script.json``, so the
existing resume path (``--script-file``) skips the planning stages and goes
straight on to the audio. No new runner, and no dependency on the planning
run's disk: an Actions runner that never saw the first half still resumes.

The money, which the runners handle (``tools/queue_worker.py``,
``tools/credits_settle.py``): a run that stops here exits with
:data:`PAUSED_EXIT`, and its hold is RELEASED in full — the planning step is
never charged on its own. The render is paid by the hold placed at approve.

Fail closed. With the switch on, a run that cannot write or read its storyboard
does not render: :class:`StoryboardUnavailable` stops it with the remedy. With
the switch off, nothing here makes a request, except on ``--resume``, where an
earlier storyboard of the same run is honoured (an undecided one still waits; a
discarded one never renders).

The stored storyboard is data. Its text is never put into a shell command or an
ffmpeg filter by this module; the script it carries goes through the same
``ScriptEngine.load`` parser as any saved script.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

#: main.py's exit code for "stopped at the storyboard, waiting for a person"
#: (EX_TEMPFAIL). The runners treat it as neither success nor failure: the job
#: ends cleanly and its credit hold is released, never captured.
PAUSED_EXIT = 75

STATUS_READY = "ready"
STATUS_APPROVED = "approved"
STATUS_RENDERED = "rendered"
STATUS_DISCARDED = "discarded"

# Bounds, mirrored by storyboard_scenes_valid() and the table's checks (0057)
# and by command-center/lib/storyboardReview.ts.
MAX_SCENES = 60
MAX_NARRATION = 4000
MAX_VISUAL = 1000
MAX_NAME = 120
MAX_TYPE = 40
MIN_SCENE_SECONDS = 1
MAX_SCENE_SECONDS = 600
MIN_DURATION = 30
MAX_DURATION = 3600
MAX_TOPIC = 300
MAX_TITLE = 300
#: The script JSON the render resumes from (0057: pg_column_size <= 256 KiB).
MAX_SCRIPT_BYTES = 200_000

_TIMEOUT = 15  # seconds
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,49}$")
_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class StoryboardUnavailable(RuntimeError):
    """The storyboard could not be written or read. With the switch on the run
    stops here, before anything is spent on the render; the message names the
    fix and never carries a key or a response body."""


class StoryboardPaused(Exception):
    """The run stops at the storyboard. ``reason`` is ``ready`` (a new
    storyboard is waiting), ``waiting`` (one was already waiting), ``discarded``
    (a person said no) or ``not_applied`` (an approved one this run could not
    resume from)."""

    def __init__(self, storyboard_id: str, reason: str):
        super().__init__(f"storyboard {storyboard_id}: {reason}")
        self.storyboard_id = storyboard_id
        self.reason = reason


def slugify(text: str) -> str:
    # main.slugify, repeated so this module never imports main.
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:50]


def enabled(ctx) -> bool:
    """This channel's switch. Only an explicit true (AgentConfig.from_dict)."""
    return getattr(getattr(ctx, "agent", None), "storyboard_review", False) is True


# ── the cards ───────────────────────────────────────────────────────────────

def _clip(text: Any, limit: int) -> str:
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _seconds(value: Any) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        n = MIN_SCENE_SECONDS
    return max(MIN_SCENE_SECONDS, min(MAX_SCENE_SECONDS, n))


def scene_cards(script) -> List[dict]:
    """One card per script section, in order: what a person reads before the
    render is paid for. The narration is the cue-free text that will be spoken;
    the visual description is the footage the section asks for. Raises
    StoryboardUnavailable when the plan cannot be shown honestly (no scenes, or
    more than a storyboard holds) — the run stops rather than pausing on a
    storyboard that hides part of what it would render."""
    sections = list(getattr(script, "sections", None) or [])
    if not sections:
        raise StoryboardUnavailable("the script has no scenes to review")
    if len(sections) > MAX_SCENES:
        raise StoryboardUnavailable(f"the script has {len(sections)} scenes; a storyboard holds at most {MAX_SCENES}")
    cards = []
    for i, s in enumerate(sections):
        clean = s.clean_narration() if hasattr(s, "clean_narration") else getattr(s, "narration", "")
        keywords = [str(k).strip() for k in (getattr(s, "keywords", None) or []) if str(k).strip()]
        cards.append({
            "n": i + 1,
            "name": _clip(getattr(s, "name", "") or f"Scene {i + 1}", MAX_NAME),
            "type": _clip(getattr(s, "section_type", "") or "story", MAX_TYPE),
            "narration": _clip(clean, MAX_NARRATION),
            "visual": _clip(", ".join(keywords), MAX_VISUAL),
            "duration_s": _seconds(getattr(s, "duration_hint", MIN_SCENE_SECONDS)),
        })
    return cards


def priced_duration(cards: List[Mapping]) -> int:
    """The length the render is priced for: the scenes' lengths, summed, held
    to the 30..3600 seconds every run is (render_jobs, Run now). This is the
    number the hold at approve is priced from and the queued job is frozen at."""
    total = sum(_seconds(c.get("duration_s")) for c in cards)
    return max(MIN_DURATION, min(MAX_DURATION, total))


def build_row(*, channel_id: str, slug: str, topic: str, script, hook_variant: str) -> dict:
    """The ``storyboards`` row for this paused run."""
    if not _SLUG_RE.match(slug or ""):
        raise StoryboardUnavailable("this run's topic has no usable run key (slug) — give it a topic "
                                    "with letters or digits")
    topic = str(topic or "").strip()
    if not topic or len(topic) > MAX_TOPIC:
        raise StoryboardUnavailable(f"the topic must be 1..{MAX_TOPIC} characters to be resumed after approval")
    cards = scene_cards(script)
    body = script.to_dict()
    if len(json.dumps(body, ensure_ascii=False).encode("utf-8")) > MAX_SCRIPT_BYTES:
        raise StoryboardUnavailable("the script is too large to store for review")
    title = str(getattr(script, "title", "") or "").strip()[:MAX_TITLE] or None
    return {
        "channel_id": channel_id,
        "slug": slug,
        "topic": topic,
        "title": title,
        "scenes": cards,
        "script": body,
        "hook_variant": "B" if hook_variant == "B" else "A",
        "duration_s": priced_duration(cards),
    }


# ── the store (PostgREST, service key) ──────────────────────────────────────

class StoryboardStore:
    """``storyboards`` over Supabase's REST API with the pipeline's service key.

    Unlike the mirror (supabase_sync), a failure here is not swallowed: the
    caller decides, and with the switch on it stops the run. Errors carry the
    HTTP status only — never the key, the URL's query, or a response body."""

    def __init__(self, url: Optional[str] = None, service_key: Optional[str] = None, *,
                 session=None, timeout: float = _TIMEOUT):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).strip().rstrip("/")
        self._key = (service_key if service_key is not None else os.getenv("SUPABASE_SERVICE_KEY", "")).strip()
        self.enabled = bool(self.url and self._key)
        self._session = session
        self._timeout = timeout

    def _http(self):
        if self._session is None:
            import requests  # noqa: PLC0415 — keep the module import-light

            self._session = requests.Session()
        return self._session

    def _headers(self, prefer: str = "") -> dict:
        h = {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        if prefer:
            h["Prefer"] = prefer
        return h

    def _require(self) -> None:
        if not self.enabled:
            raise StoryboardUnavailable("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, so the storyboard "
                                        "cannot be stored for review")

    def latest(self, channel_id: str, slug: str) -> Optional[dict]:
        """The newest storyboard of this run, or None. Raises StoryboardUnavailable."""
        self._require()
        try:
            # "*" rather than a column list: opening_edited exists only once
            # migration 0058 is applied, and naming it would make every resume
            # fail on a database without it.
            r = self._http().get(
                f"{self.url}/rest/v1/storyboards",
                params={"select": "*",
                        "channel_id": f"eq.{channel_id}", "slug": f"eq.{slug}",
                        "order": "created_at.desc", "limit": "1"},
                headers=self._headers(), timeout=self._timeout)
        except Exception as e:
            raise StoryboardUnavailable(f"storyboard lookup failed ({type(e).__name__})") from None
        if r.status_code >= 300:
            raise StoryboardUnavailable(f"storyboard lookup failed: HTTP {r.status_code} "
                                        "(is migration 0057 applied?)")
        try:
            rows = r.json()
        except ValueError:
            raise StoryboardUnavailable("storyboard lookup returned no JSON") from None
        if not isinstance(rows, list):
            raise StoryboardUnavailable("storyboard lookup returned an unexpected shape")
        return dict(rows[0]) if rows else None

    def create(self, row: Mapping) -> Optional[str]:
        """Insert the row; its id, or None when a ready/approved storyboard of
        this run already exists (another run got there first). Raises
        StoryboardUnavailable on anything else."""
        self._require()
        try:
            r = self._http().post(
                f"{self.url}/rest/v1/storyboards", params={"select": "id"}, json=dict(row),
                headers=self._headers("return=representation"), timeout=self._timeout)
        except Exception as e:
            raise StoryboardUnavailable(f"storyboard write failed ({type(e).__name__})") from None
        if r.status_code == 409:
            return None
        if r.status_code >= 300:
            raise StoryboardUnavailable(f"storyboard write failed: HTTP {r.status_code} "
                                        "(is migration 0057 applied?)")
        try:
            rows = r.json()
            sid = str(rows[0]["id"]) if isinstance(rows, list) and rows else ""
        except (ValueError, KeyError, TypeError):
            sid = ""
        if not _ID_RE.match(sid):
            raise StoryboardUnavailable("storyboard write returned no id")
        return sid

    def mark_rendered(self, storyboard_id: str) -> bool:
        """approved -> rendered, once the render exists. Best-effort; never raises."""
        if not self.enabled or not _ID_RE.match(str(storyboard_id or "")):
            return False
        try:
            from datetime import datetime, timezone  # noqa: PLC0415

            r = self._http().patch(
                f"{self.url}/rest/v1/storyboards",
                params={"id": f"eq.{storyboard_id}", "status": f"eq.{STATUS_APPROVED}"},
                json={"status": STATUS_RENDERED, "rendered_at": datetime.now(timezone.utc).isoformat()},
                headers=self._headers("return=minimal"), timeout=self._timeout)
            if r.status_code >= 300:
                logger.warning("Could not mark storyboard %s rendered: HTTP %s", storyboard_id, r.status_code)
                return False
            return True
        except Exception as e:
            logger.warning("Could not mark storyboard %s rendered (%s)", storyboard_id, type(e).__name__)
            return False


# ── resume from an approved storyboard ──────────────────────────────────────

@dataclass(frozen=True)
class Approved:
    """An approved storyboard this run renders: its script is on disk now."""
    storyboard_id: str
    script_path: Path
    hook_variant: str
    duration_s: int
    #: A person changed the first scene before approving (migration 0058). The
    #: opening is then theirs, not either hook arm's: the render records no
    #: hook variant, so the A/B readback is never credited to it.
    opening_edited: bool = False


def materialize(script: Any, path: Path) -> Path:
    """Write an approved storyboard's script where ``--script-file`` reads it.
    Only the Script JSON shape is accepted (an object with a list of section
    objects whose narration is text); anything else is refused, never fixed up.
    The text is written as JSON data — nothing here interprets it."""
    if not isinstance(script, Mapping):
        raise StoryboardUnavailable("the approved storyboard carries no script")
    sections = script.get("sections")
    if not isinstance(sections, list) or not sections or len(sections) > MAX_SCENES:
        raise StoryboardUnavailable("the approved storyboard's script has no usable scenes")
    for s in sections:
        if not isinstance(s, Mapping) or not isinstance(s.get("narration"), str):
            raise StoryboardUnavailable("the approved storyboard's script has a malformed scene")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(script), indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def approved_for_resume(channel_id: str, topic: str, *, store: Optional[StoryboardStore] = None,
                        output_dir: Optional[Path] = None,
                        slugs: Optional[Sequence[str]] = None) -> Optional[Approved]:
    """On ``--resume``: the approved storyboard of this run, its script written
    to ``output/<slug>/script.json``; else None. A lookup that fails returns
    None here — :func:`checkpoint` then decides, failing closed when the
    channel has the switch on.

    ``slugs`` are the names the run may be stored under, best first (a run's
    directory is keyed by its channel: modules/run_slug.py, BR-G-007); the
    topic's own slug when not given. A storyboard row is per (channel, slug)."""
    wanted = [s for s in (slugs if slugs is not None else [slugify(topic or "")]) if _SLUG_RE.match(s or "")]
    if not wanted:
        return None
    store = store or StoryboardStore()
    if not store.enabled:
        return None
    slug, row = wanted[0], None
    for cand in wanted:
        try:
            row = store.latest(channel_id, cand)
        except StoryboardUnavailable as e:
            logger.warning("[channel: %s] %s — checking again before the render", channel_id, e)
            return None
        if row:
            slug = cand
            break
    if not row or row.get("status") != STATUS_APPROVED:
        return None
    if output_dir is None:
        from config import OUTPUT_DIR as output_dir  # noqa: PLC0415 — config reads the env
    path = materialize(row.get("script"), Path(output_dir) / slug / "script.json")
    try:
        duration = int(row.get("duration_s") or 0)
    except (TypeError, ValueError):
        duration = 0
    logger.info("[channel: %s] Rendering approved storyboard %s", channel_id, row.get("id"))
    return Approved(str(row.get("id")), path, "B" if row.get("hook_variant") == "B" else "A", duration,
                    opening_edited=row.get("opening_edited") is True)


# ── the checkpoint ──────────────────────────────────────────────────────────

def checkpoint(ctx, *, slug: str, topic: str, script, hook_variant: str, resume: bool,
               approved: Optional[Approved], store: Optional[StoryboardStore] = None,
               notify=None) -> Optional[str]:
    """Called once, after the fact-check and the hook choice and before the
    first paid generation for the scenes. Returns normally when the run may go
    on to the render; raises StoryboardPaused when it stops here, and
    StoryboardUnavailable when it must stop because the storyboard cannot be
    stored or read (switch on).

    * an approved storyboard this run resumed from → go on;
    * switch off and not a resume → go on, with no request at all (exactly as
      before this module existed);
    * otherwise the run's latest storyboard decides: one waiting → stop and
      keep waiting; discarded → stop, never render; approved but not the one
      this run loaded → stop rather than render something else;
    * none (or only a rendered one) with the switch on → store a new one and
      stop. Returns the id of a new storyboard only via StoryboardPaused."""
    if approved is not None:
        return None
    on = enabled(ctx)
    if not on and not resume:
        return None
    channel_id = str(getattr(ctx, "channel_id", "") or "")
    store = store or StoryboardStore()
    if not store.enabled and not on:
        return None
    try:
        row = store.latest(channel_id, slug) if _SLUG_RE.match(slug or "") else None
    except StoryboardUnavailable:
        if on:
            raise
        logger.warning("[channel: %s] Could not check for an earlier storyboard — continuing "
                       "(review is off for this channel)", channel_id)
        return None
    status = (row or {}).get("status")
    if status == STATUS_READY:
        raise StoryboardPaused(str(row.get("id")), "waiting")
    if status == STATUS_DISCARDED:
        # Only a run started for a storyboard (a resume) can meet a discarded
        # one of its own; a fresh plan of the same topic is a new storyboard.
        if resume or not on:
            raise StoryboardPaused(str(row.get("id")), "discarded")
    elif status == STATUS_APPROVED:
        raise StoryboardPaused(str(row.get("id")), "not_applied")
    if not on:
        return None
    new_row = build_row(channel_id=channel_id, slug=slug, topic=topic, script=script,
                        hook_variant=hook_variant)
    sid = store.create(new_row)
    if sid is None:
        # A ready/approved storyboard of this run appeared between the read and
        # the write (two runs of one topic): wait on that one.
        existing = store.latest(channel_id, slug)
        raise StoryboardPaused(str((existing or {}).get("id") or ""), "waiting")
    (notify or notify_ready)(ctx, new_row)
    raise StoryboardPaused(sid, "ready")


def notify_ready(ctx, row: Mapping) -> None:
    """Tell a person a storyboard is waiting, on whichever notification
    channels this deployment has (modules/notifier.py: the log always, Slack /
    Telegram when configured). Counts only — no script text leaves the run.
    Best-effort: a notification failure never changes what the run does."""
    try:
        from modules.notifier import Notifier  # noqa: PLC0415

        name = str(getattr(ctx, "name", "") or getattr(ctx, "channel_id", "") or "a channel")
        scenes = len(row.get("scenes") or [])
        minutes = int(row.get("duration_s") or 0) / 60.0
        Notifier().send(f"Storyboard ready for {name}: {scenes} scenes, about {minutes:.1f} min. "
                        "It renders only after someone approves it in the Command Center.")
    except Exception as e:
        logger.warning("Storyboard notification skipped (%s)", type(e).__name__)


def mark_rendered(approved: Optional[Approved], store: Optional[StoryboardStore] = None) -> bool:
    if approved is None:
        return False
    return (store or StoryboardStore()).mark_rendered(approved.storyboard_id)
