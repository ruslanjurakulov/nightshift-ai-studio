"""Graphic recipes in the IR compiler — when a scene earns a designed treatment.

Roadmap Faza 3 (PR 3.3 follow-up). ``modules/shot_recipes.py`` has recipes the
chooser never picks on its own (``timeline``, ``evidence_card`` —
``auto_select=False``), and ``map_zoom``, which only makes sense with a map
*image*. The Director plans shots before any asset or claim is attached to a
scene, so it cannot know when one of these is earned. This module is the step
that can: it runs in the IR compiler (:func:`modules.video_ir.write_for_run`)
once the project has its assets, its claim ids and the channel's elements, and
upgrades a scene's ``shot.recipe`` only when the data the card will show is
really there.

Off by default
--------------
Nothing changes unless ``CHRONOS_GRAPHIC_RECIPES`` is truthy. It is not purely
additive: the recipe it writes into ``project.json`` is part of a scene's
render-cache key (``modules/scene_render.py``) and, once Remotion is wired in,
decides the scene's pixels. With the flag off, ``project.json`` is byte-for-byte
what it was and no sidecar is written.

The rules (deterministic, no randomness, conservative)
------------------------------------------------------
A scene is a *candidate* only when all of these hold:

* its current recipe is a known ``motion`` recipe that is not already a
  graphic treatment (a card the chooser picked, e.g. ``quote_card``, is kept);
* its duration is known (``start_s``/``end_s``) and inside the target recipe's
  catalogue bounds — a 45 s scene never becomes a 45 s card;
* its narrative beat is one the target recipe lists (the catalogue's
  ``beats``), so e.g. the closing scene is never turned into a card;
* the rule's data exists:

  - ``map_zoom`` — the scene's FIRST image asset (the one ``MapScene`` draws)
    is a map by its own recorded metadata (Pexels page URL slug, the
    generation prompt's subject, or its file name say ``map``/``maps``), AND
    the scene names exactly one place (a channel ``location`` element it
    mentions, or a place in a locative phrase such as "off the coast of X");
  - ``timeline`` — the narration has >= 2 distinct years, counted exactly the
    way ``video-engine/src/text.ts`` ``extractTimeline`` reads them (this is
    its Python twin; ``samples/timeline_year_cases.json`` keeps them in step);
  - ``evidence_card`` — at least one of the scene's ``claim_ids`` has a
    definite fact-check verdict (``likely_accurate``/``likely_inaccurate``).
    ``unverifiable`` is also the checker's safe default when it failed, and
    ``not_checked`` is not a verdict, so neither counts.

Candidates are ranked ``map_zoom`` > ``timeline`` > ``evidence_card`` (most
specific data first), then by scene order, and accepted greedily while:

* graphic treatments (every ``graphic`` recipe plus ``map_zoom``, including
  the ones already in the video) stay <= 25 % of the scenes (floor), and
* no two graphic treatments are adjacent.

Everything that does not qualify keeps exactly the recipe it had.

Props sources (never invented)
------------------------------
Alongside the recipes, :func:`apply` returns one entry per scene — written to
``output/<slug>/scene_graphics.json`` — with what the Remotion props need
(``remotion_renderer.build_props`` context keys ``claims``, ``map``,
``lower_third``):

* ``map`` — ``{focus: None, label: <place>}`` for a ``map_zoom`` scene with a
  known place. ``focus`` is always null: no source tells us where a place sits
  on a stock image, and a pin at a guessed point would claim a location nobody
  supplied (``MapScene`` then zooms on the centre, no pin).
* ``lower_third`` — ``{name, label: None}`` when the scene names exactly one
  channel ``character`` element; null otherwise (two names = ambiguous).
* ``claims`` — the scene's claims (``id``, ``text``, ``status`` as the checker
  gave it), limited to the scene's ``claim_ids``; null when none are known.

Never raises: any failure returns the project unchanged and no entries.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from pathlib import Path
from typing import Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

from modules import shot_recipes

logger = logging.getLogger(__name__)

FLAG_ENV = "CHRONOS_GRAPHIC_RECIPES"
_TRUTHY = ("1", "true", "yes", "on")
SIDECAR_FILENAME = "scene_graphics.json"
SIDECAR_VERSION = 1

#: At most this share of a video's scenes carry a graphic treatment (floor).
MAX_GRAPHIC_SHARE = 0.25

RULE_MAP = "map_zoom"
RULE_TIMELINE = "timeline"
RULE_EVIDENCE = "evidence_card"
#: Rule priority: the most specific data first.
RULE_ORDER = (RULE_MAP, RULE_TIMELINE, RULE_EVIDENCE)

#: The fact-check verdicts that count as "checked" for an evidence card.
DEFINITE_VERDICTS = ("likely_accurate", "likely_inaccurate")

#: Minimum distinct years in the narration for a timeline.
MIN_TIMELINE_YEARS = 2


def is_enabled(value: Optional[str] = None) -> bool:
    """True only when ``CHRONOS_GRAPHIC_RECIPES`` is truthy. Default off."""
    if value is None:
        value = os.environ.get(FLAG_ENV, "")
    return str(value or "").strip().lower() in _TRUTHY


def is_graphic_treatment(recipe_id) -> bool:
    """A designed card (every ``graphic`` recipe) or ``map_zoom`` — what the
    per-video cap and the no-two-in-a-row rule count."""
    r = shot_recipes.get(recipe_id)
    return r is not None and (r.kind == shot_recipes.KIND_GRAPHIC or r.id == RULE_MAP)


# ── timeline years: the Python twin of video-engine/src/text.ts ─────────────
#
# Written to match JavaScript regex semantics exactly: JS `\s` (Unicode
# whitespace, spelled out below), ASCII `\d`/`\b`. Shared cases:
# samples/timeline_year_cases.json (tests/test_graphic_recipes.py and
# video-engine/tests/text-cases.test.mts both read it).

_JS_WS = ("\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B))
          + "\u2028\u2029\u202f\u205f\u3000\ufeff")
_S = f"[{_JS_WS}]"
_W = "A-Za-z0-9_"
_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august",
           "september", "october", "november", "december")

_CUE_RE = re.compile(r"\[(SFX|MUSIC|PAUSE|VOICE):[^\]]*\]")
_MULTI_WS_RE = re.compile(f"{_S}{{2,}}")
_YEAR_RE = re.compile(
    rf"(?<![0-9$€£,.])(?:(?<![{_W}])({'|'.join(_MONTHS)}){_S}+(?:[0-9]{{1,2}}(?:st|nd|rd|th)?,?{_S}+)?)?"
    rf"(?<![{_W}])(1[0-9]{{3}}|20[0-9]{{2}})(s)?(?![{_W}])(?![.,][0-9])"
    rf"(?!{_S}*(?:%|percent|per cent|miles?|kilomet|km|metres?|meters?|feet|foot|tons?|tonnes?"
    rf"|people|men|women|soldiers|dollars|pounds|years? (?:ago|old)))",
    re.IGNORECASE | re.ASCII,
)
_CLAUSE_RE = re.compile(
    rf"(?<=[.!?]){_S}+|{_S}*[;:—–]{_S}*|,{_S}+(?=(?:and{_S}+|but{_S}+|then{_S}+)?[a-z])"
)


def clean_narration(text) -> str:
    """``cleanNarration``: strip cue tags, collapse runs of whitespace, trim."""
    src = _CUE_RE.sub("", text if isinstance(text, str) else "")
    return _MULTI_WS_RE.sub(" ", src).strip(_JS_WS)


def timeline_dates(text, max_events: int = 5) -> List[dict]:
    """``extractTimeline`` without the labels: ``[{date, year, month}]`` in
    date order, one per distinct date, at most ``max_events`` — exactly the
    markers the ``Timeline`` component would draw. [] when there are none."""
    try:
        src = clean_narration(text)
        seen = set()
        events: List[Tuple[int, int, int, str]] = []
        for clause in _CLAUSE_RE.split(src):
            for m in _YEAR_RE.finditer(clause or ""):
                month_name = m.group(1)
                month = _MONTHS.index(month_name.lower()) + 1 if month_name else 0
                year = int(m.group(2))
                prefix = f"{month_name[0].upper()}{month_name[1:3].lower()} " if month_name else ""
                date = f"{prefix}{m.group(2)}{'s' if m.group(3) else ''}"
                if date in seen:
                    continue
                seen.add(date)
                events.append((year, month, len(events), date))
        events.sort(key=lambda e: (e[0], e[1], e[2]))
        return [{"date": d, "year": y, "month": mo} for y, mo, _, d in events[: max(int(max_events), 0)]]
    except Exception:  # noqa: BLE001 — a reader never breaks a run
        return []


def timeline_years(text) -> List[int]:
    """Distinct years among the markers the ``Timeline`` component draws."""
    return sorted({e["year"] for e in timeline_dates(text)})


# ── places and people: only what the scene or the channel actually names ────

_PLACE_LEAD = (r"off the coast of|the coast of|coast of|north of|south of|east of|west of"
               r"|city of|town of|village of|port of|province of|region of")
_NAME_WORD = r"[A-Z][A-Za-z'’\-]*"
_PLACE_RE = re.compile(
    rf"(?<![A-Za-z])(?i:{_PLACE_LEAD})\s+(?:(?i:the)\s+)?({_NAME_WORD}(?:\s+{_NAME_WORD}){{0,3}})"
)
_NOT_PLACES = set(_MONTHS) | {"monday", "tuesday", "wednesday", "thursday", "friday",
                              "saturday", "sunday", "i", "he", "she", "they", "it", "we"}


def _clean_place(raw: str) -> Optional[str]:
    words = [w.rstrip(".,;:'’-") for w in raw.split()]
    words = [w for w in words if w]
    if not words:
        return None
    if any(w.lower().endswith(("'s", "’s")) for w in raw.split()):
        return None  # "north of Scotland's capital" is not the place "Scotland"
    if words[0].lower() in _NOT_PLACES:
        return None
    return " ".join(words)


def text_places(text) -> List[str]:
    """Places the narration names in a locative phrase ("off the coast of
    Lewis", "west of the Outer Hebrides"), in order, de-duplicated."""
    out: List[str] = []
    for m in _PLACE_RE.finditer(clean_narration(text)):
        place = _clean_place(m.group(1))
        if place and place.lower() not in {p.lower() for p in out}:
            out.append(place)
    return out


def _scene_elements(scene: Mapping, elements: Sequence, kind: str) -> List:
    """The channel elements of ``kind`` this scene names (via its IR
    ``element_ids``), in library order."""
    try:
        from modules.video_ir import element_id
    except Exception:  # pragma: no cover
        return []
    ids = set(scene.get("element_ids") or ())
    out = []
    for e in elements or ():
        if getattr(e, "kind", None) == kind and element_id(e.kind, e.name) in ids:
            out.append(e)
    return out


def scene_place(scene: Mapping, elements: Sequence = ()) -> Optional[str]:
    """The ONE place the scene names — a channel location element it mentions
    or a place in a locative phrase. None when it names none or several."""
    names = [e.name for e in _scene_elements(scene, elements, "location")]
    names += text_places(scene.get("narration"))
    distinct = []
    for n in names:
        if n and n.lower() not in {d.lower() for d in distinct}:
            distinct.append(n)
    return distinct[0] if len(distinct) == 1 else None


def lower_third(scene: Mapping, elements: Sequence = ()) -> Optional[dict]:
    """``{name, label: None}`` when the scene names exactly one channel
    character element; None otherwise. No label: nothing real supplies one."""
    people = _scene_elements(scene, elements, "character")
    if len(people) != 1:
        return None
    name = str(getattr(people[0], "name", "") or "").strip()
    return {"name": name, "label": None} if name else None


# ── map images ──────────────────────────────────────────────────────────────

_MAP_WORDS = {"map", "maps"}
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text) -> set:
    return set(_TOKEN_RE.findall(str(text or "").lower()))


def is_map_image(asset: Mapping) -> bool:
    """True when an IMAGE asset's own recorded metadata says it is a map: the
    last path segment of its source URL (Pexels page slugs describe the
    photo), the subject part of its generation prompt (before " — ", where the
    topic follows), or its file name."""
    if not isinstance(asset, Mapping) or asset.get("kind") != "image":
        return False
    sources = []
    url = asset.get("url")
    if isinstance(url, str) and url.strip():
        try:
            segs = [s for s in urlparse(url).path.split("/") if s]
            if segs:
                sources.append(segs[-1])
        except Exception:  # noqa: BLE001
            pass
    prompt = asset.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        sources.append(prompt.split(" — ")[0])
    path = asset.get("path")
    if isinstance(path, str) and path.strip():
        sources.append(Path(path).stem)
    return any(_tokens(s) & _MAP_WORDS for s in sources)


def _first_image(scene: Mapping, assets_by_id: Mapping) -> Optional[Mapping]:
    for aid in scene.get("asset_ids") or ():
        a = assets_by_id.get(aid)
        if isinstance(a, Mapping) and a.get("kind") == "image":
            return a
    return None


# ── claims ──────────────────────────────────────────────────────────────────

def scene_claims(scene: Mapping, rows) -> Optional[List[dict]]:
    """The scene's claims (``id``, ``text``, ``status``) from its
    ``claim_scenes.annotate_scenes`` row, limited to the IR scene's
    ``claim_ids``. The status is passed through as given (a missing one stays
    None). None when the scene has no known claims."""
    ids = [str(i) for i in (scene.get("claim_ids") or ()) if i]
    if not ids or not isinstance(rows, (list, tuple)):
        return None
    wanted = set(ids)
    out = []
    for c in rows:
        if not isinstance(c, Mapping):
            continue
        cid, text = c.get("id"), c.get("text")
        if cid is None or str(cid) not in wanted or not isinstance(text, str) or not text.strip():
            continue
        status = c.get("status")
        out.append({"id": str(cid), "text": text.strip(),
                    "status": status if isinstance(status, str) and status else None})
    return out or None


def has_checked_claim(claims: Optional[Sequence[Mapping]]) -> bool:
    return any(isinstance(c, Mapping) and c.get("status") in DEFINITE_VERDICTS for c in claims or ())


# ── the selection ───────────────────────────────────────────────────────────

def _duration(scene: Mapping) -> Optional[float]:
    s, e = scene.get("start_s"), scene.get("end_s")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (s, e)):
        return None
    d = float(e) - float(s)
    return d if math.isfinite(d) and d > 0 else None


def _rule_data(rule: str, scene: Mapping, *, place, first_image, claims) -> bool:
    if rule == RULE_MAP:
        return place is not None and first_image is not None and is_map_image(first_image)
    if rule == RULE_TIMELINE:
        return len(timeline_years(scene.get("narration"))) >= MIN_TIMELINE_YEARS
    if rule == RULE_EVIDENCE:
        return has_checked_claim(claims)
    return False


def select(scenes: Sequence[Mapping], *, assets: Iterable[Mapping] = (),
           claims_by_index: Optional[Mapping] = None, elements: Sequence = ()) -> List[dict]:
    """One entry per scene (IR scene dicts, in order)::

        {scene_id, recipe_before, recipe, rule, map, lower_third, claims}

    ``rule`` is the rule that upgraded the scene, or None when its recipe is
    unchanged (``recipe == recipe_before``). ``claims_by_index`` maps a scene's
    position to its ``annotate_scenes`` claim rows. Pure and deterministic."""
    scenes = [s for s in scenes if isinstance(s, Mapping)]
    total = len(scenes)
    by_id = {a.get("id"): a for a in assets or () if isinstance(a, Mapping)}
    info = []
    for pos, sc in enumerate(scenes):
        info.append({
            "place": scene_place(sc, elements),
            "first_image": _first_image(sc, by_id),
            "claims": scene_claims(sc, (claims_by_index or {}).get(pos)),
        })

    recipes = [(sc.get("shot") or {}).get("recipe") for sc in scenes]
    graphic = [is_graphic_treatment(r) for r in recipes]
    budget = int(math.floor(total * MAX_GRAPHIC_SHARE)) - sum(graphic)

    candidates = []
    for pos, sc in enumerate(scenes):
        current = shot_recipes.get(recipes[pos])
        if current is None or current.kind != shot_recipes.KIND_MOTION or graphic[pos]:
            continue
        dur = _duration(sc)
        if dur is None:
            continue
        beat = shot_recipes.scene_beat(sc, pos, total)
        for rank, rule in enumerate(RULE_ORDER):
            target = shot_recipes.get(rule)
            if target is None or not target.fits_duration(dur) or beat not in target.beats:
                continue
            if _rule_data(rule, sc, **info[pos]):
                candidates.append((rank, pos, rule))
                break

    chosen = {}
    for _, pos, rule in sorted(candidates):
        if budget <= 0:
            break
        if (pos > 0 and graphic[pos - 1]) or (pos + 1 < total and graphic[pos + 1]):
            continue
        chosen[pos] = rule
        graphic[pos] = True
        budget -= 1

    out = []
    for pos, sc in enumerate(scenes):
        rule = chosen.get(pos)
        recipe = rule if rule else recipes[pos]
        place = info[pos]["place"]
        out.append({
            "scene_id": sc.get("id"),
            "recipe_before": recipes[pos],
            "recipe": recipe,
            "rule": rule,
            "map": {"focus": None, "label": place} if recipe == RULE_MAP and place else None,
            "lower_third": lower_third(sc, elements),
            "claims": info[pos]["claims"],
        })
    return out


def claims_by_index(scene_plan) -> dict:
    """``{position: claim rows}`` from ``claim_scenes.annotate_scenes`` output."""
    out = {}
    for i, entry in enumerate(scene_plan or []):
        if isinstance(entry, Mapping) and isinstance(entry.get("claims"), (list, tuple)):
            out[i] = list(entry["claims"])
    return out


def apply(project, *, scene_plan=None, elements: Sequence = ()):
    """``(project', entries)``: the Video IR project with upgraded scenes'
    ``shot.recipe`` replaced, and the :func:`select` entries. Never raises —
    on any failure the project comes back unchanged with no entries."""
    try:
        from dataclasses import replace

        scenes = sorted(project.scenes, key=lambda s: s.index)
        entries = select([s.to_dict() for s in scenes],
                         assets=[a.to_dict() for a in project.assets],
                         claims_by_index=claims_by_index(scene_plan), elements=list(elements or ()))
        new_by_id = {e["scene_id"]: e["recipe"] for e in entries if e["rule"]}
        if not new_by_id:
            return project, entries
        updated = tuple(
            replace(s, shot=replace(s.shot, recipe=new_by_id[s.id])) if s.id in new_by_id else s
            for s in project.scenes
        )
        logger.info("Graphic recipes: %d scene(s) upgraded — %s", len(new_by_id),
                    ", ".join(f"{sid} {rid}" for sid, rid in sorted(new_by_id.items())))
        return replace(project, scenes=updated), entries
    except Exception as e:  # noqa: BLE001 — the IR stays as the Director planned it
        logger.warning("Graphic recipe selection failed (%s: %s) — recipes unchanged",
                       type(e).__name__, e)
        return project, []


def write_sidecar(entries: Sequence[Mapping], path) -> Optional[Path]:
    """Write ``scene_graphics.json`` (the props sources + why each recipe
    changed). Best-effort: None on failure."""
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"version": SIDECAR_VERSION, "scenes": list(entries)},
                                indent=2, ensure_ascii=False), encoding="utf-8")
        return p
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not write %s (%s: %s)", SIDECAR_FILENAME, type(e).__name__, e)
        return None


def load_sidecar(path) -> dict:
    """``{scene_id: entry}`` from a ``scene_graphics.json``; ``{}`` when it is
    missing, unreadable, another version or malformed. Never raises."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing/corrupt sidecar means no props
        return {}
    if not isinstance(data, Mapping) or data.get("version") != SIDECAR_VERSION:
        return {}
    out = {}
    for entry in data.get("scenes") or ():
        if isinstance(entry, Mapping) and isinstance(entry.get("scene_id"), str):
            out[entry["scene_id"]] = dict(entry)
    return out


def remove_sidecar(path) -> None:
    """Delete a sidecar left by an earlier run, so a run that selected no
    graphics never renders with stale props. Best-effort."""
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not remove stale %s (%s)", SIDECAR_FILENAME, type(e).__name__)


def render_context(entry: Optional[Mapping]) -> dict:
    """The ``remotion_renderer.build_props`` context keys for one scene from
    its sidecar entry: ``claims``, ``map``, ``lower_third`` (each None when
    unknown)."""
    entry = entry if isinstance(entry, Mapping) else {}
    return {"claims": entry.get("claims"), "map": entry.get("map"),
            "lower_third": entry.get("lower_third")}


def has_props(context: Optional[Mapping]) -> bool:
    """True when a :func:`render_context` carries any real props data."""
    return isinstance(context, Mapping) and any(
        context.get(k) for k in ("claims", "map", "lower_third"))
