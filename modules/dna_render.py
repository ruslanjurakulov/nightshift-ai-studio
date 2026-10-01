"""Channel DNA in a video run: the look, the recurring characters, the format.

PR #313 (migration 0056) gave a channel one place for its look and voice; a run
used only the tone (script_engine). This module is the rest of it, for the
scheduled run and Run now alike (both are ``main.run``):

* **Format and aspect** (``resolve_format``) pick the frame the video renders
  in and the script's target length, where the run itself did not say:
  ``dna_aspect`` wins over the aspect ``dna_format`` implies (Shorts -> 9:16,
  long -> 16:9); with neither the frame is ``config``'s, exactly as before. A
  Shorts format caps the target length at ``SHORTS_TARGET_SECONDS``. A value
  set on the run (``--duration``) always wins. It never touches publishing:
  a Shorts *format* is how this video is cut, not a second upload —
  ``agent_config.shorts`` (opted into separately, it spends quota),
  auto publish, approvals and the publish gate read nothing from here.

* **The style kit and the characters** (``load_look`` -> ``DnaLook``) reach
  each generated picture's and clip's prompt through the Studio's own
  mechanism (``modules/creative_style.py``): the kit's description as the
  ``Look:`` line of the style guide on every scene, and a DNA character's
  description as its ``@name:`` line on each scene whose narration or
  keywords name it. The pipeline's image and video clients take no reference
  pictures (only the Studio's adapters do), so descriptions are what carries
  the look here; a kit or character with no description would reach the
  provider as nothing, and the run stops before it spends anything, as the
  Studio refuses the same job (``creative_style.unusable``, CLAUDE.md #4).

DNA text is data. Every description is flattened to one line, stripped of
control characters and of the guide's own markers, and length-capped before
it is put in a prompt; nothing here builds a shell command or a filter graph.
Rows are read with the service role, filtered to the channel's own
organization in the query AND checked again here: a kit or character of any
other organization is never used, whatever the database answers. Nothing here
logs a prompt or a description.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

from modules import creative_style as cs

logger = logging.getLogger(__name__)

#: A Shorts-format channel's target length when the run names none. Under
#: YouTube's classic 60 s so narration that runs a little long still fits.
SHORTS_TARGET_SECONDS = 55

#: Caps on what DNA text may add to one prompt. The database's limits (2000
#: per description) are for the Studio, where the prompt is one picture; a
#: b-roll prompt also carries the subject, the shot direction and the
#: negative clauses, and some video models stop at ~2000 characters.
KIT_DESCRIPTION_MAX = 500
CHARACTER_DESCRIPTION_MAX = 300
#: At most this many characters are described in one scene's prompt.
MAX_CHARACTERS_PER_SCENE = 3
#: 0056's own limit; a longer answer is cut, never trusted.
MAX_DNA_CHARACTERS = 8

ASPECT_16_9, ASPECT_9_16, ASPECT_1_1 = "16:9", "9:16", "1:1"
ASPECTS = (ASPECT_16_9, ASPECT_9_16, ASPECT_1_1)
_FORMAT_ASPECT = {"shorts": ASPECT_9_16, "long": ASPECT_16_9}

#: Generated-still sizes per frame (the clients take pixels; 16:9 is the
#: 1024x576 every run has always asked for).
_IMAGE_SIZE = {ASPECT_16_9: (1024, 576), ASPECT_9_16: (576, 1024), ASPECT_1_1: (1024, 1024)}

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_NAME_RE = re.compile(r"^[a-z0-9_]{2,32}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_MARKER_RE = re.compile(re.escape(cs.GUIDE_START) + "|" + re.escape(cs.GUIDE_END), re.IGNORECASE)


class DnaUnavailable(RuntimeError):
    """The channel's DNA asks for something this run cannot honour. Raised
    before anything is spent; the message names the remedy and no DNA text."""

    def __init__(self, reason: str, remedy: str):
        self.reason = reason
        self.remedy = remedy
        super().__init__(f"{reason}. Fix: {remedy}")


# ── format and aspect ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class RenderFormat:
    """The frame and target length this run renders with, and where each came
    from ("run", "dna_aspect", "dna_format", "channel" or "default")."""
    aspect: str
    width: int
    height: int
    target_seconds: int
    aspect_source: str
    length_source: str

    @property
    def image_size(self) -> Tuple[int, int]:
        return _IMAGE_SIZE.get(self.aspect, _IMAGE_SIZE[ASPECT_16_9])

    def to_metadata(self) -> dict:
        return {"aspect": self.aspect, "width": self.width, "height": self.height,
                "target_seconds": self.target_seconds, "aspect_source": self.aspect_source,
                "length_source": self.length_source}


def frame_size(aspect: str, base: Tuple[int, int]) -> Tuple[int, int]:
    """Pixels for ``aspect`` at the deployment's resolution: ``base`` is the
    configured 16:9 frame (1920x1080), whose long and short sides are reused so
    a vertical frame costs the render exactly what a landscape one does."""
    long_side, short_side = max(base), min(base)
    if aspect == ASPECT_9_16:
        return short_side, long_side
    if aspect == ASPECT_1_1:
        return short_side, short_side
    return int(base[0]), int(base[1])


def resolve_format(dna, *, channel_target_seconds: int, base_size: Tuple[int, int],
                   run_duration: Optional[int] = None, run_aspect: Optional[str] = None) -> RenderFormat:
    """The frame and the target length for one run.

    Aspect: the run's own, else ``dna_aspect``, else the aspect ``dna_format``
    implies, else the deployment's frame (``base_size``, unchanged).
    Length: the run's own ``--duration``, else for a Shorts format the
    channel's target capped at ``SHORTS_TARGET_SECONDS``, else the channel's
    own target (``agent_config.target_duration_seconds``, unchanged)."""
    fmt = getattr(dna, "format", "") or ""
    dna_aspect = getattr(dna, "aspect", "") or ""

    if run_aspect in ASPECTS:
        aspect, a_src = run_aspect, "run"
    elif dna_aspect in ASPECTS:
        aspect, a_src = dna_aspect, "dna_aspect"
    elif fmt in _FORMAT_ASPECT:
        aspect, a_src = _FORMAT_ASPECT[fmt], "dna_format"
    else:
        aspect, a_src = "", "default"

    if aspect:
        width, height = frame_size(aspect, base_size)
    else:
        width, height = int(base_size[0]), int(base_size[1])
        aspect = ASPECT_9_16 if height > width else (ASPECT_1_1 if height == width else ASPECT_16_9)

    channel_target = int(channel_target_seconds)
    if run_duration and int(run_duration) > 0:
        target, l_src = int(run_duration), "run"
    elif fmt == "shorts" and channel_target > SHORTS_TARGET_SECONDS:
        target, l_src = SHORTS_TARGET_SECONDS, "dna_format"
    else:
        target, l_src = channel_target, "channel"
    return RenderFormat(aspect, width, height, target, a_src, l_src)


# ── the look: style kit + characters ────────────────────────────────────────


def clean_text(value, limit: int) -> str:
    """One line of DNA text, safe to put in a prompt: control characters and
    the style guide's own markers removed, whitespace collapsed, cut at a word
    boundary to at most ``limit`` characters."""
    if not isinstance(value, str):
        return ""
    text = _MARKER_RE.sub(" ", _CONTROL_RE.sub(" ", value))
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:-")


def _name_pattern(name: str) -> "re.Pattern[str]":
    # captain_ali is spoken "Captain Ali": underscores match a space, '_' or
    # '-', and the name must stand alone (not inside "alibi").
    parts = [re.escape(p) for p in name.split("_") if p]
    return re.compile(r"(?<![A-Za-z0-9])@?" + r"[\s_\-]+".join(parts) + r"(?![A-Za-z0-9])", re.IGNORECASE)


@dataclass(frozen=True)
class DnaLook:
    """A channel's DNA style kit and characters, resolved for one run."""
    kit: Optional[cs.StyleOwner] = None
    characters: Tuple[cs.StyleOwner, ...] = ()
    #: Rows the loader refused (another organization's, malformed). Counts only.
    ignored: int = 0
    _patterns: Tuple = field(default=(), repr=False, compare=False)

    def __post_init__(self):
        object.__setattr__(self, "_patterns", tuple(_name_pattern(c.name or "") for c in self.characters))

    @property
    def empty(self) -> bool:
        return self.kit is None and not self.characters

    @property
    def character_names(self) -> Tuple[str, ...]:
        return tuple(c.name for c in self.characters if c.name)

    def characters_in(self, text: str) -> List[cs.StyleOwner]:
        """The DNA characters ``text`` names, in order of first mention, at
        most ``MAX_CHARACTERS_PER_SCENE``."""
        hits = []
        for owner, pattern in zip(self.characters, self._patterns):
            m = pattern.search(text or "")
            if m:
                hits.append((m.start(), owner))
        hits.sort(key=lambda h: h[0])
        return [o for _, o in hits[:MAX_CHARACTERS_PER_SCENE]]

    def inputs_for(self, text: str) -> cs.StyleInputs:
        return cs.StyleInputs(self.kit, tuple(self.characters_in(text)))

    def apply(self, prompt: str, scene_text: str) -> str:
        """``prompt`` with this scene's style guide appended — the kit's look
        and each named character — exactly as the Studio composes one (no
        reference pictures: the pipeline's clients take none). Unchanged when
        there is nothing to add."""
        if self.empty:
            return prompt
        return cs.compose_prompt(prompt, self.inputs_for(scene_text), ())

    def to_metadata(self) -> dict:
        """What the run records: counts and @names, never a description."""
        return {"style_kit": self.kit is not None, "characters": list(self.character_names),
                "ignored_rows": self.ignored}


def scene_text(section) -> str:
    """What a scene is matched on: its narration and its footage keywords."""
    def get(key):
        return section.get(key) if isinstance(section, dict) else getattr(section, key, None)
    parts = [str(get("narration") or "")]
    kws = get("keywords")
    if isinstance(kws, str):
        parts.append(kws)
    elif isinstance(kws, (list, tuple)):
        parts.extend(str(k) for k in kws)
    return " ".join(parts)


def _uuid(v) -> Optional[str]:
    s = str(v or "").lower()
    return s if _UUID_RE.match(s) else None


def build_look(org_id: str, kit_id: str, kit_rows: Sequence, link_rows: Sequence,
               character_rows: Sequence) -> DnaLook:
    """The look from the rows read for a channel — pure, so it is tested
    without a database. Only rows that carry the channel's own organization
    are used; anything else is counted in ``ignored`` and never reaches a
    prompt. The characters keep the channel's DNA order (``position``)."""
    org = _uuid(org_id)
    ignored = 0
    kit = None
    want_kit = _uuid(kit_id)
    for r in kit_rows or ():
        if (isinstance(r, dict) and org and want_kit and _uuid(r.get("id")) == want_kit
                and _uuid(r.get("org_id")) == org and kit is None):
            kit = cs.StyleOwner(want_kit, None, clean_text(r.get("description"), KIT_DESCRIPTION_MAX), ())
        else:
            ignored += 1

    order = []
    for r in link_rows or ():
        cid = _uuid(r.get("character_id")) if isinstance(r, dict) else None
        if cid and org and _uuid(r.get("org_id")) == org and cid not in [c for _, c in order]:
            try:
                pos = int(r.get("position"))
            except (TypeError, ValueError):
                pos = 99
            order.append((pos, cid))
        else:
            ignored += 1
    order.sort()
    wanted = [cid for _, cid in order][:MAX_DNA_CHARACTERS]

    by_id = {}
    for r in character_rows or ():
        cid = _uuid(r.get("id")) if isinstance(r, dict) else None
        name = str(r.get("name") or "") if isinstance(r, dict) else ""
        if (cid in wanted and cid not in by_id and org and _uuid(r.get("org_id")) == org
                and _NAME_RE.match(name)):
            by_id[cid] = cs.StyleOwner(cid, name, clean_text(r.get("description"), CHARACTER_DESCRIPTION_MAX), ())
        else:
            ignored += 1
    # A link whose character did not come back (deleted, another org's) is
    # not used either.
    ignored += sum(1 for cid in wanted if cid not in by_id)
    chars = tuple(by_id[cid] for cid in wanted if cid in by_id)
    return DnaLook(kit=kit, characters=chars, ignored=ignored)


def check_usable(look: DnaLook, kit_id: str) -> None:
    """Raise ``DnaUnavailable`` when the DNA would reach a provider as nothing:
    a kit the channel names that is not its organization's (or is gone), or a
    kit / character with no description — the pipeline sends no reference
    pictures, so a description is all it has (``creative_style.unusable``)."""
    if _uuid(kit_id) and look.kit is None:
        raise DnaUnavailable(
            "the channel's default style kit is not one of its organization's kits",
            "pick the style kit again in the channel's DNA, or clear it")
    lost = cs.unusable(cs.StyleInputs(look.kit, look.characters), ())
    if lost:
        raise DnaUnavailable(
            f"{' and '.join(lost)} in the channel's DNA {'has' if len(lost) == 1 else 'have'} no description, "
            "and generated pictures in a video run take none of its reference pictures",
            "add a description in the Studio, or remove it from the channel's DNA")


def _read(sync, table: str, params: dict, *, missing_ok: bool = False) -> Optional[list]:
    """Rows, or None when the table does not exist and ``missing_ok`` (a
    deployment without that migration). Any other failure is DnaUnavailable."""
    from modules.supabase_sync import SupabaseReadError

    try:
        return sync.select_strict(table, params)
    except SupabaseReadError as e:
        if missing_ok and e.table_missing:
            return None
        raise DnaUnavailable(f"the channel's DNA could not be read ({table}: {e.detail})",
                             "re-run; if it repeats, check the Supabase project is reachable") from None


def load_look(ctx, sync=None) -> DnaLook:
    """Read the channel's DNA style kit and characters (0047 / 0056) and check
    they can be used. Raises ``DnaUnavailable`` (before anything is spent) when
    they cannot. An empty DNA — or a deployment without 0056's character table
    — is an empty look: the run generates exactly as before."""
    dna = getattr(ctx, "dna", None)
    kit_id = getattr(dna, "style_kit_id", "") or ""
    org = _uuid(getattr(ctx, "org_id", ""))
    channel_id = str(getattr(ctx, "channel_id", "") or "")
    if sync is None:
        from modules.supabase_sync import SupabaseSync
        sync = SupabaseSync()
    if not getattr(sync, "enabled", False) or org is None:
        if kit_id:
            raise DnaUnavailable("the channel names a style kit, but this deployment cannot read style kits",
                                 "set SUPABASE_URL and SUPABASE_SERVICE_KEY for the run, or clear the kit")
        return DnaLook()

    kit_rows = []
    if _uuid(kit_id):
        kit_rows = _read(sync, "style_kits", {"select": "id,org_id,description",
                                              "id": f"eq.{_uuid(kit_id)}", "org_id": f"eq.{org}"}) or []
    links = _read(sync, "channel_dna_characters",
                  {"select": "character_id,org_id,position", "channel_id": f"eq.{channel_id}",
                   "org_id": f"eq.{org}", "order": "position.asc", "limit": str(MAX_DNA_CHARACTERS)},
                  missing_ok=True) or []
    ids = [i for i in (_uuid(r.get("character_id")) for r in links if isinstance(r, dict)) if i]
    char_rows = []
    if ids:
        char_rows = _read(sync, "characters", {"select": "id,org_id,name,description",
                                               "id": f"in.({','.join(ids[:MAX_DNA_CHARACTERS])})",
                                               "org_id": f"eq.{org}"}) or []
    look = build_look(org, kit_id, kit_rows, links, char_rows)
    if look.ignored:
        logger.warning("[channel: %s] Channel DNA: %d row(s) not of this channel's organization were ignored",
                       channel_id, look.ignored)
    check_usable(look, kit_id)
    return look


def generates_pictures() -> bool:
    """Will this run generate any picture or clip a look could steer? With
    neither generated b-roll nor generated stills on, footage is stock and
    the DNA look has nothing to apply to."""
    try:
        from modules import image_providers, video_providers
        return bool(video_providers.is_enabled() or image_providers.is_enabled())
    except Exception:
        return False


def scene_prompt_hook(look: Optional[DnaLook], sections: Iterable) -> Optional[Callable[[int, str], str]]:
    """``(index, prompt) -> prompt`` for media_fetcher / minimax_broll: each
    scene's prompt with its style guide. None when there is no look."""
    if look is None or look.empty:
        return None
    texts = [scene_text(s) for s in (sections or [])]

    def hook(index: int, prompt: str) -> str:
        text = texts[index] if 0 <= index < len(texts) else ""
        return look.apply(prompt, text)
    return hook
