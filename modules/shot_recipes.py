"""Shot recipe catalogue — a CLOSED library of named edit treatments.

Roadmap Y4 / PR 3.1. The AI (and Director Mode) never invents an animation per
video: every scene gets exactly one **recipe id** from this catalogue, and each
render backend implements a fixed set of recipes. The id is what the Video IR
stores in ``scene.shot.recipe`` (see ``modules/video_ir.py``), so it is part of
the contract between the director, the render compilers and QC.

Design
------
* **Pure data + a deterministic chooser.** No I/O, no randomness, no API. The
  same scene list always yields the same recipes.
* **Closed.** :func:`is_valid` is the gate; anything that reads a recipe from
  outside (an edited IR, an operator override) should run it through
  :func:`normalize`, which maps an unknown id to :data:`DEFAULT_RECIPE`.
* **Degradable.** ``backends`` lists the render backends *designed* to execute a
  recipe (the first is the preferred one). Remotion is optional and off by
  default, so every recipe that some backend cannot run names a ``fallback``;
  :func:`resolve_for_backends` walks that chain to a recipe the available
  backends can run, ending at a universally executable motion recipe.
* **Duration-aware.** ``min_s``/``max_s`` are the default bounds a single shot of
  the recipe is meant to hold. When a scene's duration is known the chooser only
  picks recipes whose bounds contain it (a 45 s section never becomes a 45 s
  stat card); when it is unknown (None — not 0) the bounds are not applied.

Choosing
--------
:func:`choose_recipe` scores the eligible scene recipes (``motion`` and
``graphic``; transitions are chosen separately by :func:`choose_transition`):

  * +3 for each *content* context the scene shows that the recipe fits
    (numbers → ``stat_counter``, a quotation → ``quote_card``, geography →
    ``map_zoom``, archival cues → ``archival_reveal``, a chapter/title scene →
    ``chapter_card``/``title_card``); a recipe that needs a content context is
    only eligible when the scene has it;
  * +1 when the recipe fits the scene's narrative beat (hook/reveal/body/close);
  * +1 when the channel's style bible prefers it;
  * +1 for the footage recipe when the scene's asset is known to be video;
  * the recipe used on the previous scene is excluded, so consecutive scenes
    never repeat a recipe;
  * ties break by catalogue order — deterministic;
  * recipes marked ``auto_select=False`` (``timeline``, ``evidence_card``) are
    never picked here — they are valid ids that are set explicitly
    (``modules/graphic_recipes.py`` does it in the IR compiler, behind
    ``CHRONOS_GRAPHIC_RECIPES``, once the scene's years/claims/map are known).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, List, Mapping, Optional, Sequence

KIND_MOTION = "motion"
KIND_GRAPHIC = "graphic"
KIND_TRANSITION = "transition"
KINDS = (KIND_MOTION, KIND_GRAPHIC, KIND_TRANSITION)

BACKEND_FFMPEG = "ffmpeg"
BACKEND_REMOTION = "remotion"
BACKEND_MOVIEPY = "moviepy"
BACKENDS = (BACKEND_FFMPEG, BACKEND_REMOTION, BACKEND_MOVIEPY)

# Narrative beats (mirrors modules/director._beat).
BEAT_HOOK = "hook"
BEAT_REVEAL = "reveal"
BEAT_BODY = "body"
BEAT_CLOSE = "close"
BEATS = (BEAT_HOOK, BEAT_REVEAL, BEAT_BODY, BEAT_CLOSE)

# Content contexts detected from a scene's name/narration/type.
CTX_NUMERIC = "numeric"
CTX_QUOTE = "quote"
CTX_GEOGRAPHY = "geography"
CTX_ARCHIVAL = "archival"
CTX_CHAPTER = "chapter"
CTX_TITLE = "title"
CONTENT_CONTEXTS = (CTX_NUMERIC, CTX_QUOTE, CTX_GEOGRAPHY, CTX_ARCHIVAL, CTX_CHAPTER, CTX_TITLE)

MEDIA_IMAGE = "image"
MEDIA_VIDEO = "video"


@dataclass(frozen=True)
class ShotRecipe:
    """One named treatment.

    ``beats``   narrative beats it suits (scored, never required).
    ``contexts`` content contexts it suits; when ``requires_context`` is True
                the scene must show at least one of them to be eligible.
    ``media``   asset kinds it animates (``image``/``video``); empty for a
                graphic that needs no source asset. Only applied when the
                caller knows the scene's asset kind.
    ``scene_types`` IR scene types it is limited to; empty = any type.
    ``backends`` render backends designed to execute it, preferred first.
    ``fallback`` recipe to degrade to when none of ``backends`` is available.
    ``auto_select`` False = a valid, executable id that :func:`choose_recipe`
                never picks on its own; it is set explicitly (an operator
                override, or a later director/IR step that has the signal).
    """

    id: str
    kind: str
    description: str
    min_s: float
    max_s: float
    backends: tuple
    beats: tuple = field(default_factory=tuple)
    contexts: tuple = field(default_factory=tuple)
    requires_context: bool = False
    media: tuple = field(default_factory=tuple)
    scene_types: tuple = field(default_factory=tuple)
    fallback: Optional[str] = None
    auto_select: bool = True

    @property
    def backend(self) -> str:
        """The preferred backend for this recipe."""
        return self.backends[0]

    def fits_duration(self, duration_s: Optional[float]) -> bool:
        """True when ``duration_s`` is unknown (None) or within the bounds."""
        if duration_s is None:
            return True
        return self.min_s <= duration_s <= self.max_s

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "description": self.description,
            "min_s": self.min_s,
            "max_s": self.max_s,
            "backends": list(self.backends),
            "beats": list(self.beats),
            "contexts": list(self.contexts),
            "requires_context": self.requires_context,
            "media": list(self.media),
            "scene_types": list(self.scene_types),
            "fallback": self.fallback,
            "auto_select": self.auto_select,
        }


_ALL = (BACKEND_FFMPEG, BACKEND_REMOTION, BACKEND_MOVIEPY)

#: The catalogue. Order matters: it is the deterministic tie-break.
RECIPES: tuple = (
    # --- motion: animate a still (or footage) over the scene -------------
    ShotRecipe(
        "slow_push", KIND_MOTION,
        "Slow Ken Burns push-in on the scene's image/footage; builds tension.",
        2.0, 120.0, _ALL,
        beats=(BEAT_HOOK, BEAT_REVEAL, BEAT_BODY), media=(MEDIA_IMAGE, MEDIA_VIDEO),
    ),
    ShotRecipe(
        "slow_pull", KIND_MOTION,
        "Slow Ken Burns pull-back revealing context; resolves and settles.",
        2.0, 120.0, _ALL,
        beats=(BEAT_CLOSE, BEAT_BODY), media=(MEDIA_IMAGE, MEDIA_VIDEO),
    ),
    ShotRecipe(
        "lateral_pan", KIND_MOTION,
        "Slow horizontal pan across a wide image; surveys a place or scene.",
        3.0, 90.0, _ALL,
        beats=(BEAT_BODY,), contexts=(CTX_GEOGRAPHY,), media=(MEDIA_IMAGE,),
    ),
    ShotRecipe(
        "parallax", KIND_MOTION,
        "2.5D parallax: foreground and background layers drift at different speeds.",
        3.0, 60.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY, BEAT_REVEAL), media=(MEDIA_IMAGE,), fallback="slow_push",
    ),
    ShotRecipe(
        "broll_cut", KIND_MOTION,
        "Stock/generated footage played as-is with straight cuts between clips.",
        1.0, 180.0, _ALL,
        beats=(BEAT_HOOK, BEAT_REVEAL, BEAT_BODY, BEAT_CLOSE), media=(MEDIA_VIDEO,),
    ),
    ShotRecipe(
        "archival_reveal", KIND_MOTION,
        "Desaturated, vignetted archival photo/document revealed with a slow push.",
        3.0, 60.0, (BACKEND_REMOTION, BACKEND_FFMPEG),
        beats=(BEAT_BODY, BEAT_REVEAL), contexts=(CTX_ARCHIVAL,), requires_context=True,
        media=(MEDIA_IMAGE,), fallback="slow_push",
    ),
    ShotRecipe(
        "map_zoom", KIND_MOTION,
        "Zoom from a wide map into the place the narration names.",
        3.0, 30.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY, BEAT_HOOK), contexts=(CTX_GEOGRAPHY,), requires_context=True,
        media=(MEDIA_IMAGE,), fallback="slow_push",
    ),
    # --- graphic: a designed card, needs no source asset ------------------
    ShotRecipe(
        "quote_card", KIND_GRAPHIC,
        "A quotation set in the style bible's heading font over the palette background.",
        3.0, 20.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY, BEAT_REVEAL), contexts=(CTX_QUOTE,), requires_context=True,
        fallback="slow_push",
    ),
    ShotRecipe(
        "stat_counter", KIND_GRAPHIC,
        "A number that counts up to its value with a short label.",
        2.0, 15.0, (BACKEND_REMOTION,),
        beats=(BEAT_HOOK, BEAT_BODY, BEAT_REVEAL), contexts=(CTX_NUMERIC,), requires_context=True,
        fallback="slow_push",
    ),
    ShotRecipe(
        "chapter_card", KIND_GRAPHIC,
        "Chapter/part heading card between acts.",
        2.0, 8.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY,), contexts=(CTX_CHAPTER,), requires_context=True,
        fallback="slow_push",
    ),
    ShotRecipe(
        "title_card", KIND_GRAPHIC,
        "Full-screen video title card.",
        2.0, 10.0, (BACKEND_REMOTION,),
        beats=(BEAT_HOOK, BEAT_BODY), contexts=(CTX_TITLE,), requires_context=True,
        fallback="slow_push",
    ),
    # Explicit-only graphics (auto_select=False). Added after the chooser's
    # recipes so catalogue order — the tie-break — is unchanged for them.
    # timeline: a scene naming years also reads as archival, so letting the
    # chooser pick it would silently re-rank every dated scene; evidence_card
    # needs the scene's claims + fact-check status, which the chooser does not
    # see (and a card on every claim would be noise). Both are set explicitly —
    # by modules/graphic_recipes.py in the IR compiler (CHRONOS_GRAPHIC_RECIPES).
    ShotRecipe(
        "timeline", KIND_GRAPHIC,
        "Dated events from the narration (years) on a line that draws in, oldest first.",
        3.0, 20.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY, BEAT_REVEAL), fallback="slow_push", auto_select=False,
    ),
    ShotRecipe(
        "evidence_card", KIND_GRAPHIC,
        "The scene's claim(s) with the advisory fact-check status; neutral when none is known.",
        3.0, 15.0, (BACKEND_REMOTION,),
        beats=(BEAT_BODY, BEAT_REVEAL), fallback="slow_push", auto_select=False,
    ),
    # --- transition: how a scene enters (chosen by choose_transition) -----
    ShotRecipe(
        "crossfade", KIND_TRANSITION,
        "Dissolve from the previous scene into this one.",
        0.3, 1.5, _ALL,
    ),
    ShotRecipe(
        "dip_to_black", KIND_TRANSITION,
        "Fade the previous scene to black, then up into this one.",
        0.4, 2.0, _ALL,
    ),
    ShotRecipe(
        "hard_cut", KIND_TRANSITION,
        "A straight cut — no transition frames.",
        0.0, 0.0, _ALL,
    ),
)

_BY_ID = {r.id: r for r in RECIPES}

#: The universally executable scene recipe every fallback chain ends at.
DEFAULT_RECIPE = "slow_push"
#: The transition used when a style bible names none (or an unknown one).
DEFAULT_TRANSITION = "crossfade"


# --------------------------------------------------------------------------
# Catalogue access
# --------------------------------------------------------------------------

def ids(kind: Optional[str] = None) -> List[str]:
    """Recipe ids in catalogue order, optionally only one ``kind``."""
    return [r.id for r in RECIPES if kind is None or r.kind == kind]


def get(recipe_id) -> Optional[ShotRecipe]:
    """The recipe for an id, or None when unknown (never raises)."""
    if not isinstance(recipe_id, str):
        return None
    return _BY_ID.get(recipe_id.strip().lower())


def is_valid(recipe_id) -> bool:
    return get(recipe_id) is not None


def normalize(recipe_id, *, default: str = DEFAULT_RECIPE) -> str:
    """A catalogue id for any input: the id itself when known, else ``default``."""
    r = get(recipe_id)
    return r.id if r is not None else default


def catalog() -> List[dict]:
    """The catalogue as plain dicts, for an API or the Command Center."""
    return [r.to_dict() for r in RECIPES]


def resolve_for_backends(recipe_id, available: Iterable[str]) -> str:
    """Degrade ``recipe_id`` along its ``fallback`` chain until one of the
    ``available`` backends can execute it. Unknown ids start at the default.
    If nothing in the chain is executable, :data:`DEFAULT_RECIPE` is returned
    (the legacy MoviePy path can always show a still/clip)."""
    have = {str(b).strip().lower() for b in (available or ())}
    r = get(recipe_id) or _BY_ID[DEFAULT_RECIPE]
    seen = set()
    while r is not None and r.id not in seen:
        seen.add(r.id)
        if have.intersection(r.backends):
            return r.id
        r = get(r.fallback) if r.fallback else None
    return DEFAULT_RECIPE


# --------------------------------------------------------------------------
# Reading a scene (IR dict, script-section dict, or ScriptSection object)
# --------------------------------------------------------------------------

def _field(scene, *names, default=None):
    for n in names:
        if isinstance(scene, Mapping):
            if n in scene and scene[n] is not None:
                return scene[n]
        else:
            v = getattr(scene, n, None)
            if v is not None:
                return v
    return default


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def scene_duration(scene) -> Optional[float]:
    """Seconds the scene lasts: IR ``end_s - start_s`` when both are known,
    else a script section's ``duration_hint``/``duration``. None when unknown
    or non-positive — a missing time is never read as 0."""
    start, end = _num(_field(scene, "start_s")), _num(_field(scene, "end_s"))
    if start is not None and end is not None:
        d = end - start
        return d if d > 0 else None
    hint = _num(_field(scene, "duration_hint", "duration"))
    return hint if hint is not None and hint > 0 else None


def scene_type(scene) -> str:
    return str(_field(scene, "type", "section_type", default="story") or "story").strip().lower()


def _scene_text(scene) -> str:
    return f"{_field(scene, 'name', default='')} {_field(scene, 'narration', default='')}"


_NUMERIC_RE = re.compile(
    r"(\d[\d,.]*\s*(%|percent\b|per cent\b|million\b|billion\b|trillion\b|thousand\b|times\b))"
    r"|([$€£]\s?\d)",
    re.IGNORECASE,
)
# A quoted span of at least four words, straight or curly quotes.
_QUOTE_RE = re.compile(r"[\"“]([^\"”]+?\s+){3,}[^\"”]+?[\"”]")
_YEAR_RE = re.compile(r"\b1[0-9]{3}\b")
_ARCHIVAL_CUES = (
    "archive", "archival", "photograph", "old photo", "newspaper", "diary", "letter",
    "log book", "logbook", "manuscript", "document", "records show", "century",
)
_GEO_CUES = (
    "map", "miles", "kilometers", "kilometres", "coast", "island", "border", "continent",
    "ocean", "river", "mountain", "empire", "north of", "south of", "east of", "west of",
)


def _cue_re(cues) -> "re.Pattern":
    """Whole-word match for any cue, allowing a plural (map/maps, not mapping;
    document/documents, not documentary)."""
    return re.compile(r"\b(?:" + "|".join(re.escape(c) for c in cues) + r")(?:s|es)?\b")


_ARCHIVAL_RE = _cue_re(_ARCHIVAL_CUES)
_GEO_RE = _cue_re(_GEO_CUES)
_CHAPTER_TYPES = ("chapter", "part", "act")
_TITLE_TYPES = ("title", "intro", "opening")
_CHAPTER_NAME_RE = re.compile(r"^\s*(chapter|part|act)\b", re.IGNORECASE)


def scene_contexts(scene) -> tuple:
    """The content contexts a scene shows, in :data:`CONTENT_CONTEXTS` order."""
    text = _scene_text(scene)
    low = text.lower()
    stype = scene_type(scene)
    name = str(_field(scene, "name", default="") or "")
    found = set()
    if _NUMERIC_RE.search(text):
        found.add(CTX_NUMERIC)
    if _QUOTE_RE.search(text):
        found.add(CTX_QUOTE)
    if _GEO_RE.search(low):
        found.add(CTX_GEOGRAPHY)
    if _YEAR_RE.search(text) or _ARCHIVAL_RE.search(low):
        found.add(CTX_ARCHIVAL)
    if stype in _CHAPTER_TYPES or _CHAPTER_NAME_RE.match(name):
        found.add(CTX_CHAPTER)
    if stype in _TITLE_TYPES:
        found.add(CTX_TITLE)
    return tuple(c for c in CONTENT_CONTEXTS if c in found)


_REVEAL_CUES = ("reveal", "secret", "truth", "finally", "discover", "hidden", "shock", "twist")
_CLOSE_CUES = ("subscribe", "next time", "in the end", "conclusion", "thanks for", "outro")


def scene_beat(scene, index: int, total: int) -> str:
    """Narrative beat — the same rule as ``modules/director._beat``, so a scene
    read straight from the IR gets the beat Director Mode gave its section."""
    if index == 0 or scene_type(scene) == "hook":
        return BEAT_HOOK
    low = _scene_text(scene).lower()
    if any(c in low for c in _CLOSE_CUES) or (total > 1 and index == total - 1):
        return BEAT_CLOSE
    if any(c in low for c in _REVEAL_CUES):
        return BEAT_REVEAL
    return BEAT_BODY


# --------------------------------------------------------------------------
# The chooser
# --------------------------------------------------------------------------

def _preferred(style) -> tuple:
    """Preferred recipe ids from a StyleBible, a bible dict, or None."""
    if style is None:
        return ()
    prefs = style.get("preferred_recipes") if isinstance(style, Mapping) else getattr(style, "preferred_recipes", ())
    if not isinstance(prefs, (list, tuple)):
        return ()
    return tuple(p for p in (normalize(x, default="") for x in prefs) if p)


def choose_recipe(
    scene,
    *,
    index: int = 0,
    total: int = 1,
    previous: Optional[str] = None,
    style=None,
    beat: Optional[str] = None,
    duration_s: Optional[float] = None,
    asset_kind: Optional[str] = None,
) -> str:
    """Pick one scene recipe id (``motion``/``graphic``) for ``scene``.

    ``scene`` is an IR scene dict, a script section dict or a ScriptSection.
    ``previous`` is the recipe of the scene before (never repeated).
    ``style`` is a :class:`modules.style_presets.StyleBible` (or its dict).
    ``beat`` overrides the beat detection (Director passes its own).
    ``duration_s`` overrides :func:`scene_duration`; None = read from scene.
    ``asset_kind`` (``image``/``video``) filters by ``media`` when known.
    Deterministic and never raises; always returns a catalogue id.
    """
    try:
        total = max(int(total or 1), 1)
        index = int(index or 0)
        b = beat if beat in BEATS else scene_beat(scene, index, total)
        dur = _num(duration_s) if duration_s is not None else scene_duration(scene)
        if dur is not None and dur <= 0:
            dur = None
        ctx = set(scene_contexts(scene))
        stype = scene_type(scene)
        prefs = _preferred(style)
        prev = normalize(previous, default="") if previous else ""
        kind = str(asset_kind).strip().lower() if asset_kind else ""

        best_id, best_score = None, None
        for r in RECIPES:
            if r.kind == KIND_TRANSITION or r.id == prev or not r.auto_select:
                continue
            if r.scene_types and stype not in r.scene_types:
                continue
            if not r.fits_duration(dur):
                continue
            if kind and r.media and kind not in r.media:
                continue
            if r.media == (MEDIA_VIDEO,) and kind != MEDIA_VIDEO:
                continue  # footage-only recipe needs known footage
            matched = ctx.intersection(r.contexts)
            if r.requires_context and not matched:
                continue
            score = 3 * len(matched)
            if b in r.beats:
                score += 1
            if r.id in prefs:
                score += 1
            if kind == MEDIA_VIDEO and r.media == (MEDIA_VIDEO,):
                score += 1  # known footage: prefer showing it as footage
            if best_score is None or score > best_score:
                best_id, best_score = r.id, score
        if best_id is not None:
            return best_id
        # Nothing eligible (e.g. an odd duration): the default, unless that
        # would repeat — then its mirror, which fits the same bounds.
        return "slow_pull" if prev == DEFAULT_RECIPE else DEFAULT_RECIPE
    except Exception:  # noqa: BLE001 — the chooser must never break a run
        return "slow_pull" if previous == DEFAULT_RECIPE else DEFAULT_RECIPE


def choose_transition(index: int, style=None) -> str:
    """The transition *into* scene ``index``: the first scene opens on a hard
    cut; later ones use the style bible's preference when it names a known
    transition, else :data:`DEFAULT_TRANSITION`."""
    try:
        if int(index or 0) <= 0:
            return "hard_cut"
    except (TypeError, ValueError):
        pass
    pref = style.get("transition") if isinstance(style, Mapping) else getattr(style, "transition", None)
    r = get(pref)
    return r.id if r is not None and r.kind == KIND_TRANSITION else DEFAULT_TRANSITION


def assign_recipes(scenes: Sequence, style=None, asset_kinds: Optional[Mapping] = None) -> List[str]:
    """One recipe per scene, in order, threading ``previous`` so no two
    consecutive scenes share a recipe. ``asset_kinds`` optionally maps a scene
    index to its primary asset kind. [] for no scenes."""
    items = [s for s in (scenes or []) if s is not None]
    total = len(items)
    out: List[str] = []
    prev: Optional[str] = None
    for i, s in enumerate(items):
        kind = (asset_kinds or {}).get(i) if isinstance(asset_kinds, Mapping) else None
        rid = choose_recipe(s, index=i, total=total, previous=prev, style=style, asset_kind=kind)
        out.append(rid)
        prev = rid
    return out
