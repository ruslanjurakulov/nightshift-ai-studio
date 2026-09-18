"""Character Bible / Elements Library (Nightshift blueprint).

A serial channel lives or dies on consistency: the same narrator, the same
recurring locations and props, video after video. This module holds a channel's
reusable **elements** (characters, locations, props) and, for a given scene,
works out which ones appear and turns them into a consistency directive that
rides the b-roll / shot prompt (see modules/director.py + minimax_broll).

Pure and deterministic — no external API. Elements come from the channel's
agent config (`AgentConfig.elements`), so defining them costs no migration and
no new store; an empty library means generation is exactly as before.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

KIND_CHARACTER = "character"
KIND_LOCATION = "location"
KIND_PROP = "prop"
_KINDS = (KIND_CHARACTER, KIND_LOCATION, KIND_PROP)


@dataclass(frozen=True)
class Element:
    """One reusable element. `aliases` are extra surface forms to match on
    besides the name (e.g. a character's nickname)."""
    kind: str
    name: str
    description: str = ""
    aliases: tuple = field(default_factory=tuple)

    @property
    def terms(self) -> tuple:
        """All the strings that mean this element — its name and any aliases."""
        return tuple(t for t in (self.name, *self.aliases) if t)


def _coerce(item) -> "Element | None":
    """Best-effort map of a config dict into an Element; None when unusable."""
    if isinstance(item, Element):
        return item
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip()
    if not name:
        return None
    kind = str(item.get("kind") or KIND_CHARACTER).strip().lower()
    if kind not in _KINDS:
        kind = KIND_CHARACTER
    aliases = item.get("aliases")
    aliases = tuple(str(a).strip() for a in aliases if str(a).strip()) if isinstance(aliases, (list, tuple)) else ()
    return Element(kind=kind, name=name, description=str(item.get("description") or "").strip(), aliases=aliases)


def load_elements(config_elements) -> List[Element]:
    """Build the channel's element list from `AgentConfig.elements`. Skips any
    malformed entry rather than raising — a bad config never breaks a run."""
    return [e for e in (_coerce(x) for x in (config_elements or ())) if e is not None]


def _mentions(text: str, element: Element) -> bool:
    """True when the scene text names this element (whole-word, case-insensitive)."""
    low = (text or "").lower()
    for term in element.terms:
        t = term.lower().strip()
        if t and t in low:
            return True
    return False


def detect(text: str, elements: List[Element]) -> List[Element]:
    """Which elements appear in `text`, in library order (stable)."""
    return [e for e in (elements or []) if _mentions(text, e)]


def consistency_prompt(elements: List[Element]) -> str:
    """A directive appended to a scene's visual prompt so recurring elements
    stay on-model: each element's description, keyed by kind. '' when none —
    the prompt is then unchanged. Descriptions are what make it consistent, so
    an element with no description contributes only its name as an anchor."""
    parts = []
    for e in elements or []:
        desc = e.description or e.name
        parts.append(f"{e.name} ({e.kind}): {desc}")
    if not parts:
        return ""
    return "consistent recurring elements — " + "; ".join(parts)


def scene_style(text: str, elements: List[Element]) -> str:
    """The consistency directive for one scene's text (detect + prompt in one)."""
    return consistency_prompt(detect(text, elements))


def summarize(elements: List[Element], applied_by_scene: dict) -> dict:
    """Metadata for one `elements.applied` advisory event. `applied_by_scene`
    maps scene index -> [element names] used on that scene."""
    by_kind: dict = {}
    for e in elements or []:
        by_kind[e.kind] = by_kind.get(e.kind, 0) + 1
    used = sorted({n for names in applied_by_scene.values() for n in names})
    return {
        "defined": len(elements or []),
        "by_kind": by_kind,
        "applied": used,
        "scenes_touched": sum(1 for names in applied_by_scene.values() if names),
    }
