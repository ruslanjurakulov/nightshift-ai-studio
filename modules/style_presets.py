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

Style bible
-----------
Each preset may also carry a :class:`StyleBible` — the *edit* half of a look:
typography, a palette, the caption style, the preferred transition and the
shot recipes (``modules/shot_recipes.py``) the look leans on. It is optional
and additive: ``to_dict``/``catalog`` are unchanged, a preset without a bible
resolves to :data:`DEFAULT_BIBLE`, and a free-form ``visual_style`` does too.
``style_bible`` resolves a preset id, name *or* expanded directive, because the
pipeline hands Director Mode the expanded directive, not the id.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

#: Caption styles a renderer may honour. ``word_highlight`` needs word-level
#: timings (Whisper); a renderer without them degrades to ``sentence``.
CAPTION_STYLES = ("word_highlight", "sentence", "none")


@dataclass(frozen=True)
class StyleBible:
    """The edit-side style of a look — what a renderer needs beyond the prompt
    directive. Fonts are CSS font-family stacks of locally available/generic
    faces (renders run offline, nothing is fetched). ``palette`` keys are
    ``background``/``primary``/``accent``/``text`` hex colours.
    ``transition`` and ``preferred_recipes`` name ``modules/shot_recipes``
    ids; unknown ids are ignored by the chooser, never raised on."""

    heading_font: str = "Georgia, 'Times New Roman', serif"
    body_font: str = "'Helvetica Neue', Arial, sans-serif"
    palette: tuple = (
        ("background", "#101114"), ("primary", "#e9e6df"),
        ("accent", "#d4a54a"), ("text", "#ffffff"),
    )
    caption_style: str = "word_highlight"
    transition: str = "crossfade"
    preferred_recipes: tuple = field(default_factory=tuple)

    def palette_dict(self) -> dict:
        return {k: v for k, v in self.palette}

    def to_dict(self) -> dict:
        return {
            "heading_font": self.heading_font,
            "body_font": self.body_font,
            "palette": self.palette_dict(),
            "caption_style": self.caption_style,
            "transition": self.transition,
            "preferred_recipes": list(self.preferred_recipes),
        }


#: The bible for a free-form or unset style: neutral documentary defaults.
DEFAULT_BIBLE = StyleBible()


def _palette(background: str, primary: str, accent: str, text: str) -> tuple:
    return (("background", background), ("primary", primary), ("accent", accent), ("text", text))


@dataclass(frozen=True)
class StylePreset:
    """One named look. ``directive`` is the text fed into ``visual_style``;
    ``mood`` is a one-word label for the UI; ``bible`` (optional) is its edit
    style — see :class:`StyleBible`."""

    id: str
    name: str
    directive: str
    mood: str
    bible: Optional[StyleBible] = None

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "directive": self.directive, "mood": self.mood}


#: The preset library. Keep in step with command-center/lib/stylePresets.ts.
PRESETS: tuple = (
    StylePreset(
        "cinematic-noir", "Cinematic Noir",
        "cinematic film noir, high-contrast chiaroscuro lighting, deep moody shadows, desaturated, dramatic",
        "tense",
        StyleBible(
            heading_font="Georgia, 'Times New Roman', serif",
            body_font="'Helvetica Neue', Arial, sans-serif",
            palette=_palette("#14171e", "#c0c5ce", "#8a93a6", "#ffffff"),
            caption_style="word_highlight",
            transition="dip_to_black",
            preferred_recipes=("slow_push", "archival_reveal"),
        ),
    ),
    StylePreset(
        "golden-epic", "Golden Epic",
        "epic historical, warm golden-hour lighting, sweeping vistas, grand and majestic",
        "grand",
        StyleBible(
            heading_font="'Palatino Linotype', Palatino, 'Book Antiqua', serif",
            body_font="Georgia, serif",
            palette=_palette("#3a2410", "#f2c777", "#b5731f", "#fff8ea"),
            caption_style="sentence",
            transition="crossfade",
            preferred_recipes=("map_zoom", "slow_pull", "chapter_card"),
        ),
    ),
    StylePreset(
        "neon-cyber", "Neon Cyber",
        "neon cyberpunk, cool blue and magenta lighting, rain-slick streets, futuristic and electric",
        "electric",
        StyleBible(
            heading_font="'Courier New', Courier, monospace",
            body_font="'Helvetica Neue', Arial, sans-serif",
            palette=_palette("#0b1026", "#1b9aaa", "#e83e8c", "#f5f7ff"),
            caption_style="word_highlight",
            transition="hard_cut",
            preferred_recipes=("parallax", "stat_counter"),
        ),
    ),
    StylePreset(
        "soft-doc", "Soft Documentary",
        "clean documentary, soft natural daylight, realistic, balanced and calm",
        "calm",
        StyleBible(
            heading_font="'Helvetica Neue', Arial, sans-serif",
            body_font="'Helvetica Neue', Arial, sans-serif",
            palette=_palette("#eef1f4", "#3d5a80", "#9fb3c8", "#1b2430"),
            caption_style="sentence",
            transition="crossfade",
            preferred_recipes=("lateral_pan", "quote_card"),
        ),
    ),
    StylePreset(
        "mystery-dark", "Dark Mystery",
        "dark mystery, low-key lighting, drifting fog, eerie and ominous",
        "ominous",
        StyleBible(
            heading_font="Georgia, 'Times New Roman', serif",
            body_font="Georgia, serif",
            palette=_palette("#0a0f1e", "#5b6b8c", "#1f2a44", "#e6e9f0"),
            caption_style="word_highlight",
            transition="dip_to_black",
            preferred_recipes=("slow_push", "archival_reveal"),
        ),
    ),
    StylePreset(
        "vibrant-pop", "Vibrant Pop",
        "vibrant, bright saturated colors, punchy high-energy, upbeat",
        "upbeat",
        StyleBible(
            heading_font="'Arial Black', 'Helvetica Neue', Arial, sans-serif",
            body_font="'Helvetica Neue', Arial, sans-serif",
            palette=_palette("#1a1a1a", "#ffb400", "#ff5964", "#ffffff"),
            caption_style="word_highlight",
            transition="hard_cut",
            preferred_recipes=("stat_counter", "parallax"),
        ),
    ),
)

_BY_ID = {p.id: p for p in PRESETS}
_BY_NAME = {p.name.strip().lower(): p for p in PRESETS}
_BY_DIRECTIVE = {p.directive.strip().lower(): p for p in PRESETS}


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


def style_bible(visual_style) -> StyleBible:
    """The :class:`StyleBible` for a channel's visual style. Accepts a preset
    id, a preset name, or a preset's *expanded* directive (what the pipeline
    passes around after ``expand``). Anything else — a free-form style, empty,
    None, a non-string — gets :data:`DEFAULT_BIBLE`. Never raises."""
    if not isinstance(visual_style, str) or not visual_style.strip():
        return DEFAULT_BIBLE
    preset = get(visual_style) or _BY_DIRECTIVE.get(_slug(visual_style))
    if preset is None or preset.bible is None:
        return DEFAULT_BIBLE
    return preset.bible
