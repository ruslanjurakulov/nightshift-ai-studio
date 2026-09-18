"""Visual style presets — a named library of channel looks.

A channel's ``visual_style`` string already flows through the whole visual
pipeline: Director Mode (modules/director.py) reads it for lighting and mood,
and ``style_keywords`` folds it into b-roll search. This module gives that
free-form string a curated shortcut: an operator can set a channel's visual
style to a preset id (e.g. ``cinematic-noir``) and the pipeline expands it to
the full directive the generators consume.

Design
------
* **Pure and additive.** ``expand`` maps a preset id/name to its directive; any
  string that is not a known preset is returned unchanged, so a channel that
  writes its own free-form style — or none — behaves exactly as before.
* **One catalog.** The same ids/names/directives are mirrored in
  ``command-center/lib/stylePresets.ts`` for the Studio Canvas gallery; the two
  must stay in step (each side has a test asserting the catalog is well-formed).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class StylePreset:
    """One named look. ``directive`` is the text fed into ``visual_style``;
    ``mood`` is a one-word label for the UI."""

    id: str
    name: str
    directive: str
    mood: str

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "directive": self.directive, "mood": self.mood}


#: The preset library. Keep in step with command-center/lib/stylePresets.ts.
PRESETS: tuple = (
    StylePreset(
        "cinematic-noir", "Cinematic Noir",
        "cinematic film noir, high-contrast chiaroscuro lighting, deep moody shadows, desaturated, dramatic",
        "tense",
    ),
    StylePreset(
        "golden-epic", "Golden Epic",
        "epic historical, warm golden-hour lighting, sweeping vistas, grand and majestic",
        "grand",
    ),
    StylePreset(
        "neon-cyber", "Neon Cyber",
        "neon cyberpunk, cool blue and magenta lighting, rain-slick streets, futuristic and electric",
        "electric",
    ),
    StylePreset(
        "soft-doc", "Soft Documentary",
        "clean documentary, soft natural daylight, realistic, balanced and calm",
        "calm",
    ),
    StylePreset(
        "mystery-dark", "Dark Mystery",
        "dark mystery, low-key lighting, drifting fog, eerie and ominous",
        "ominous",
    ),
    StylePreset(
        "vibrant-pop", "Vibrant Pop",
        "vibrant, bright saturated colors, punchy high-energy, upbeat",
        "upbeat",
    ),
)

_BY_ID = {p.id: p for p in PRESETS}
_BY_NAME = {p.name.strip().lower(): p for p in PRESETS}


def _slug(value: str) -> str:
    return (value or "").strip().lower()


def get(preset: str) -> Optional[StylePreset]:
    """Look a preset up by id or (case-insensitive) name. None if unknown."""
    s = _slug(preset)
    return _BY_ID.get(s) or _BY_NAME.get(s)


def expand(visual_style: str) -> str:
    """Expand a preset id/name into its full directive; return any other string
    unchanged. Empty in, empty out. This is the one call the pipeline needs, and
    it never changes a free-form style a channel already wrote."""
    if not visual_style or not visual_style.strip():
        return visual_style or ""
    preset = get(visual_style)
    return preset.directive if preset else visual_style


def catalog() -> list:
    """The preset library as plain dicts, for a summary or an API."""
    return [p.to_dict() for p in PRESETS]
