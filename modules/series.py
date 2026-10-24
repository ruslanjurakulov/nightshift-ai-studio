"""Series model — a recurring content line within one channel.

A *channel* is a YouTube account the bot publishes to. A *series* is finer:
one recurring line of content within that channel — its niche, output format,
visual and voice style, cadence, target platforms and automation level. One
channel can run several (a long-form documentary line and a daily Shorts line
are two series on the same channel), which is exactly what the channel model
alone could not express.

Where this sits
---------------
This module is read-side and configuration-only, mirroring
``modules/channels.py``: it turns the ``content_series`` rows the Command
Center writes into immutable ``Series`` objects the rest of the system can
consult. It is deliberately NOT wired into the pipeline run yet — resolving a
run against a series (so topic/style/cadence come from the series rather than
the channel) is a later, separate change. Adding the noun first, without
touching how a run behaves today, keeps this safe and additive.

Loading, like ``ChannelRegistry``, degrades rather than raises:
``content_series`` in Supabase → a local ``series.json`` → an empty list. A
channel with no series defined simply has none; nothing breaks. Any failure to
read a source is logged and falls through to the next, so a malformed file or a
Supabase outage can never stop a production run.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

# Mirrors modules.channels.DEFAULT_CHANNEL_ID, kept local so this module has no
# import dependency on the channel model.
DEFAULT_CHANNEL_ID = "default"

STATUS_ACTIVE = "ACTIVE"
STATUS_PAUSED = "PAUSED"
STATUS_ARCHIVED = "ARCHIVED"
_STATUSES = {STATUS_ACTIVE, STATUS_PAUSED, STATUS_ARCHIVED}

# Automation levels, lowest to highest autonomy. full_autopilot is intentionally
# the ceiling and is NOT a licence to publish unattended: every publish still
# passes modules/publish_gate.py. It exists so the model can express the intent;
# enforcement of anything beyond "assisted" is a later, gated decision.
AUTOMATION_LEVELS = (
    "manual",
    "assisted",
    "autopilot_approval",
    "full_autopilot",
)
DEFAULT_AUTOMATION_LEVEL = "manual"

_SERIES_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def normalize_status(status: str | None) -> str:
    """Map any casing to a known status, defaulting unknown/empty to PAUSED —
    the same fail-safe default the table uses (a half-configured series must
    not run)."""
    if not status:
        return STATUS_PAUSED
    upper = str(status).strip().upper()
    return upper if upper in _STATUSES else STATUS_PAUSED


def normalize_automation_level(level: str | None) -> str:
    if not level:
        return DEFAULT_AUTOMATION_LEVEL
    lowered = str(level).strip().lower()
    return lowered if lowered in AUTOMATION_LEVELS else DEFAULT_AUTOMATION_LEVEL


def validate_series_id(series_id: str) -> str:
    """A series id names DB rows and log lines, so keep it a conservative slug
    rather than a free-form string. Raises ValueError on anything else."""
    sid = str(series_id).strip()
    if not _SERIES_ID_RE.match(sid):
        raise ValueError(
            f"Invalid series id {series_id!r}: use lowercase letters, digits, "
            "'.', '_' or '-', 1–64 chars, not starting with a separator."
        )
    return sid


@dataclass(frozen=True)
class Series:
    """One recurring content line. Immutable; a change is a new row read."""

    series_id: str
    channel_id: str = DEFAULT_CHANNEL_ID
    name: str = ""
    description: str = ""
    niche: str = ""
    language: str = "English"
    format: str = ""
    content_type: str = "mixed"
    visual_style: str = ""
    voice_style: str = ""
    cadence: dict = field(default_factory=dict)
    platforms: tuple[str, ...] = ("youtube",)
    automation_level: str = DEFAULT_AUTOMATION_LEVEL
    status: str = STATUS_PAUSED
    # The YouTube playlist this series' videos are added to after publishing.
    # Empty (the default) means no playlist — reading it never needs a schema
    # change, since a missing column/key simply reads as "". See modules/playlist.py.
    playlist_id: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @property
    def is_active(self) -> bool:
        return self.status == STATUS_ACTIVE

    @staticmethod
    def from_row(row: dict) -> "Series":
        """Build from a ``content_series`` row (Supabase) or an equivalent dict
        from series.json. Tolerant of missing keys and of `platforms`/`cadence`
        arriving as JSON strings (a file may store them either way)."""
        platforms = _as_list(row.get("platforms"))
        cadence = _as_dict(row.get("cadence"))
        return Series(
            series_id=validate_series_id(row["series_id"]),
            channel_id=str(row.get("channel_id") or DEFAULT_CHANNEL_ID),
            name=str(row.get("name") or ""),
            description=str(row.get("description") or ""),
            niche=str(row.get("niche") or ""),
            language=str(row.get("language") or "English"),
            format=str(row.get("format") or ""),
            content_type=str(row.get("content_type") or "mixed"),
            visual_style=str(row.get("visual_style") or ""),
            voice_style=str(row.get("voice_style") or ""),
            cadence=cadence,
            platforms=tuple(platforms) if platforms else ("youtube",),
            automation_level=normalize_automation_level(row.get("automation_level")),
            status=normalize_status(row.get("status")),
            playlist_id=str(row.get("playlist_id") or ""),
            created_at=row.get("created_at"),
            updated_at=row.get("updated_at"),
        )

    def to_dict(self) -> dict:
        return {
            "series_id": self.series_id,
            "channel_id": self.channel_id,
            "name": self.name,
            "description": self.description,
            "niche": self.niche,
            "language": self.language,
            "format": self.format,
            "content_type": self.content_type,
            "visual_style": self.visual_style,
            "voice_style": self.voice_style,
            "cadence": dict(self.cadence),
            "platforms": list(self.platforms),
            "automation_level": self.automation_level,
            "status": self.status,
            "playlist_id": self.playlist_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return []
        try:
            value = json.loads(value)
        except Exception:
            return [value]
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if str(v).strip()]
    return []


def _as_dict(value) -> dict:
    if value is None:
        return {}
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return {}
        try:
            value = json.loads(value)
        except Exception:
            return {}
    return dict(value) if isinstance(value, dict) else {}


def _default_file_path() -> Path:
    override = os.getenv("NIGHTSHIFT_SERIES_FILE") or os.getenv("CHRONOS_SERIES_FILE")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent / "series.json"


def _parse_rows(rows, source: str) -> list[Series]:
    out: list[Series] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        try:
            out.append(Series.from_row(row))
        except Exception as e:
            logger.warning(
                "Skipping malformed series row from %s (%s: %s)",
                source, type(e).__name__, e,
            )
    return out


class SeriesRegistry:
    """Loads series configuration and hands out ``Series`` objects.

    Loading is lazy and cached per instance (mirrors ``ChannelRegistry``):
    Supabase ``content_series`` → local ``series.json`` → empty. Construct a
    fresh registry, or call ``reload()``, to pick up changes.
    """

    def __init__(
        self,
        series: Optional[Iterable[Series]] = None,
        *,
        file_path: Optional[Path | str] = None,
        sync=None,
    ):
        # An explicit list short-circuits every source — how tests inject a
        # fixed set without touching Supabase or the filesystem.
        self._explicit = list(series) if series is not None else None
        self._file_path = Path(file_path) if file_path is not None else _default_file_path()
        self._sync = sync
        self._cache: Optional[dict[str, Series]] = None

    def reload(self) -> "SeriesRegistry":
        self._cache = None
        return self

    def _load(self) -> dict[str, Series]:
        if self._cache is not None:
            return self._cache
        if self._explicit is not None:
            items = list(self._explicit)
        else:
            items = self._load_from_supabase()
            if not items:
                items = self._load_from_file()
        self._cache = {s.series_id: s for s in items}
        return self._cache

    def _load_from_supabase(self) -> list[Series]:
        """Read the `content_series` table. Returns [] when Supabase isn't
        configured or the read fails — never raises."""
        try:
            sync = self._sync
            if sync is None:
                from modules.supabase_sync import SupabaseSync

                sync = SupabaseSync()
            if not getattr(sync, "enabled", False):
                return []
            rows = sync.select("content_series")
        except Exception as e:
            logger.warning(
                "Failed loading series from Supabase (%s: %s) — falling back to local config",
                type(e).__name__, e,
            )
            return []
        return _parse_rows(rows, source="supabase")

    def _load_from_file(self) -> list[Series]:
        path = self._file_path
        try:
            if not path or not path.exists():
                return []
            raw = path.read_text(encoding="utf-8").strip()
            if not raw:
                return []
            data = json.loads(raw)
        except Exception as e:
            logger.warning(
                "Failed reading series file %s (%s: %s) — proceeding with no series",
                path, type(e).__name__, e,
            )
            return []
        rows = data.get("series") if isinstance(data, dict) else data
        return _parse_rows(rows if isinstance(rows, list) else [], source=str(path))

    # -- public API --------------------------------------------------------

    def get(self, series_id: str) -> Series:
        """Resolve one series by id. Raises KeyError for an unknown id — a
        typo must fail loudly rather than resolve to the wrong content line."""
        wanted = validate_series_id(str(series_id))
        items = self._load()
        if wanted not in items:
            known = ", ".join(sorted(items)) or "(none)"
            raise KeyError(f"Unknown series {wanted!r}. Known series: {known}")
        return items[wanted]

    def list(self, channel_id: str | None = None, status: str | None = None) -> list[Series]:
        """Series, optionally filtered by channel and/or status, ordered
        newest-first by created_at (None sorts last) then by id — a stable
        order for logs and UI."""
        items = list(self._load().values())
        if channel_id is not None:
            items = [s for s in items if s.channel_id == str(channel_id)]
        if status is not None:
            wanted = normalize_status(status)
            items = [s for s in items if s.status == wanted]
        items.sort(key=lambda s: (s.created_at or "", s.series_id), reverse=True)
        return items

    def active(self, channel_id: str | None = None) -> list[Series]:
        """Series a scheduler may run: status ACTIVE. Scoped to one channel
        when given. (Automation level governs how much a run may do on its own,
        never whether the publish gate is consulted — it always is.)"""
        return self.list(channel_id=channel_id, status=STATUS_ACTIVE)


# -- pipeline helpers -------------------------------------------------------
# Kept here rather than in main.py so they can be unit-tested without importing
# the whole pipeline (which pulls heavy render dependencies).

def resolve_series(series_id, registry: Optional["SeriesRegistry"] = None) -> Optional[Series]:
    """Resolve a Series by id, or None when none is asked for or it can't be
    found. Never raises: a series is an optional overlay on a channel, so a
    missing or misconfigured one must not stop a run — it just runs unscoped.
    `registry` is injectable for tests."""
    if not series_id:
        return None
    try:
        reg = registry or SeriesRegistry()
        series = reg.get(str(series_id))
        logger.info("Run scoped to series %s (%s)", series.series_id, series.name)
        return series
    except Exception as e:
        logger.warning(
            "Could not resolve series %r (%s: %s) — running without a series",
            series_id, type(e).__name__, e,
        )
        return None


def effective_niche(explicit: Optional[str], series_obj: Optional[Series], ctx_niche: Optional[str]) -> str:
    """Niche precedence, most specific first: an explicit override wins, then
    the series' own niche, then the channel's, then the long-standing default."""
    series_niche = series_obj.niche if series_obj and series_obj.niche else None
    return explicit or series_niche or ctx_niche or "history mysteries"


def effective_visual_style(explicit: Optional[str], series_obj: Optional[Series],
                           channel_default: Optional[str] = None) -> str:
    """The visual style a run should aim for. Precedence, most specific first:
    an explicit override, the series' own ``visual_style``, then a channel
    default. Empty string when nothing is set — a run with no style opinion is
    valid and must not be forced to invent one."""
    series_style = series_obj.visual_style if series_obj and series_obj.visual_style else None
    return (explicit or series_style or channel_default or "").strip()


def effective_voice_style(explicit: Optional[str], series_obj: Optional[Series],
                          channel_default: Optional[str] = None) -> str:
    """The narration style a run should aim for, same precedence as
    ``effective_visual_style``. Empty when unset — this is a descriptive hint
    recorded and passed downstream, never a substitute for the channel's
    configured TTS voice (which audio_mixer.verify_voice still governs)."""
    series_voice = series_obj.voice_style if series_obj and series_obj.voice_style else None
    return (explicit or series_voice or channel_default or "").strip()


def effective_cadence(series_obj: Optional[Series]) -> dict:
    """The series' publishing cadence (e.g. ``{"long_per_week": 2}``), or an
    empty dict when there is no series or it declares none. A copy, so a caller
    can't mutate the immutable Series' cadence through the returned dict."""
    if series_obj and isinstance(series_obj.cadence, dict):
        return dict(series_obj.cadence)
    return {}


# Words that carry no visual meaning as a stock-footage search term. Kept small
# and generic; the point is to drop connective tissue, not to curate a taxonomy.
_STYLE_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "with", "of", "in", "on", "to", "for", "very",
    "style", "look", "feel", "vibe", "aesthetic", "tone", "video", "footage",
})
_STYLE_TOKEN_RE = re.compile(r"[a-z0-9]+")


def style_keywords(visual_style: Optional[str], limit: int = 4) -> list[str]:
    """Turn a free-text visual style ("dark, cinematic, moody") into a few
    search tokens ("dark", "cinematic", "moody") that can bias b-roll toward the
    series' look. Order-preserving and de-duplicated, connective words dropped,
    capped at ``limit``. Empty in → empty out; this only ever *adds* a handful
    of style terms alongside the topic's own keywords, never replaces them."""
    if not visual_style:
        return []
    seen: list[str] = []
    for token in _STYLE_TOKEN_RE.findall(str(visual_style).lower()):
        if len(token) < 3 or token in _STYLE_STOPWORDS or token in seen:
            continue
        seen.append(token)
        if len(seen) >= max(1, limit):
            break
    return seen
