"""Ready-made animated caption styles: the closed list and the pure maths.

A caption style is a NAME stored on the timeline's captions
(``captions.style.preset``, modules/timeline.py) plus the few looks a person
may change (colour, highlight colour, size, position). Everything else a style
does - how a line enters, which word is lit, the box, the glow - is fixed here,
so a document can never carry free-form animation text into the export:
``ass_captions`` turns (style id, clamped numbers, the cue's own words) into
libass tags, and nothing else reaches the file.

A cue has one start and one end, not a time per word. A style that lights words
one by one therefore spreads the cue's time over its words by their length
(:func:`word_spans_ms`), the same rule the editor preview uses
(command-center/lib/captionStyles.ts), so what the preview lights and what the
export lights agree to within the preview's approximation.

This module imports nothing from the render path, so the validators, the render
spec and the ASS writer can all use it. The table is also
samples/caption_styles.json; tests/test_caption_styles.py and
command-center/tests/caption-styles.test.ts pin both copies to that file.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Dict, List, Tuple

#: The closed list. A document naming anything else is refused by both validators.
STYLE_IDS = ("karaoke", "pop_in", "boxed", "big_centre", "lower_third",
             "outlined", "neon", "typewriter", "line_slide", "clean")

#: What a person may change on a style: the tweak names, in the order the
#: editor lists them. ``uses`` on a style says which of them it draws.
TWEAKS = ("color", "highlight_color", "size", "y")

#: The size a person may pick on a style, in output pixels (the document itself
#: allows 8-512; a caption outside this range is not a caption).
SIZE_MIN, SIZE_MAX = 24, 200

#: A cue that has more words than this is not lit word by word: one tag block
#: per word is cheap for a sentence and a megabyte for a pasted page.
MAX_STYLED_WORDS = 40
#: Words lit one by one in a whole document, counted over its cues in order. A
#: lit word costs ~300 bytes of tags and a one-letter word ~2 bytes of document,
#: so without a total the largest document could ask libass to read >100 MB.
#: A cue past the budget is written plain (its style's box or colour, no lit word).
WORD_BUDGET = 6000
#: A typewriter reveals a cue in at most this many steps.
MAX_TYPE_STEPS = 40

HEX = re.compile(r"#[0-9a-fA-F]{6}")


@dataclass(frozen=True)
class StyleDef:
    id: str
    font: str
    bold: bool
    #: Text height as a share of the frame's SHORT side (so a portrait and a
    #: landscape frame read alike).
    size_frac: float
    color: str
    highlight_color: str
    outline_color: str
    outline_width: float
    #: Where the style's anchor sits, as fractions of the frame.
    x: float
    y: float
    anchor: str
    uses: Tuple[str, ...]


def _s(id, font, bold, size_frac, color, highlight, outline, ow, x, y, anchor, uses):
    return StyleDef(id, font, bold, size_frac, color, highlight, outline, ow, x, y, anchor, uses)


_ALL = ("color", "highlight_color", "size", "y")
_PLAIN = ("color", "size", "y")

STYLES: Dict[str, StyleDef] = {s.id: s for s in (
    _s("karaoke", "DejaVu Sans", True, 0.062, "#FFFFFF", "#FFD400", "#000000", 4, 0.5, 0.78, "bottom", _ALL),
    _s("pop_in", "DejaVu Sans", True, 0.078, "#FFFFFF", "#FFD400", "#000000", 5, 0.5, 0.74, "bottom", _PLAIN),
    _s("boxed", "DejaVu Sans", True, 0.058, "#FFFFFF", "#FFD400", "#000000", 0, 0.5, 0.80, "bottom", _ALL),
    _s("big_centre", "DejaVu Sans", True, 0.12, "#FFFFFF", "#FFD400", "#000000", 8, 0.5, 0.50, "center", _ALL),
    _s("lower_third", "DejaVu Sans", True, 0.048, "#FFFFFF", "#1E6BFF", "#000000", 0, 0.06, 0.88, "bottom-left", _ALL),
    _s("outlined", "DejaVu Sans", True, 0.09, "#FFFFFF", "#FF3B30", "#000000", 8, 0.5, 0.70, "bottom", _ALL),
    _s("neon", "DejaVu Sans", True, 0.075, "#FFFFFF", "#00E5FF", "#000000", 2, 0.5, 0.72, "bottom", _ALL),
    _s("typewriter", "DejaVu Sans", True, 0.058, "#FFFFFF", "#FFD400", "#000000", 3, 0.5, 0.80, "bottom", _PLAIN),
    _s("line_slide", "DejaVu Sans", True, 0.06, "#FFFFFF", "#FFD400", "#000000", 4, 0.5, 0.85, "bottom", _PLAIN),
    _s("clean", "Liberation Sans", False, 0.05, "#FFFFFF", "#FFD400", "#000000", 0, 0.5, 0.92, "bottom", _PLAIN),
)}
assert tuple(STYLES) == STYLE_IDS


def is_style(value) -> bool:
    return isinstance(value, str) and value in STYLES


def size_for(style_id: str, width: int, height: int) -> int:
    """The style's own text size for a frame: a whole number inside the range a person may pick."""
    s = STYLES[style_id]
    # Half up (JavaScript's Math.round), not Python's half-to-even: the editor
    # writes the same size the export would fill in.
    return int(min(SIZE_MAX, max(SIZE_MIN, math.floor(min(width, height) * s.size_frac + 0.5))))


def defaults_for(style_id: str, width: int, height: int) -> dict:
    """The document's caption-style fields a style starts from (what applying
    it writes, and what the export fills in for a field the document leaves out)."""
    s = STYLES[style_id]
    return {"font": s.font, "size": size_for(style_id, width, height), "color": s.color,
            "outline_color": s.outline_color, "outline_width": float(s.outline_width),
            "bold": s.bold, "y": s.y, "highlight_color": s.highlight_color, "preset": style_id}


# ── words and their times ───────────────────────────────────────────────────

def cue_lines(text) -> List[List[str]]:
    """A cue's words, one list per line. The caller has already made the text
    inert (``ass_captions.escape_text``); this only splits it."""
    lines = []
    for raw in str(text if text is not None else "").splitlines() or [""]:
        words = [w for w in raw.split(" ") if w]
        if words:
            lines.append(words)
    return lines


#: A bold DejaVu / Liberation glyph is about this wide as a share of the font
#: size, on average (measured on mixed Latin and Cyrillic text); wrapping by it
#: errs on the narrow side, so a line is never wider than the frame allows.
AVG_GLYPH_EM = 0.66


def wrap_lines(lines: List[List[str]], width: int, margin: int, size: int) -> List[List[str]]:
    """The cue's lines broken so each fits the frame, by letter count. A style
    that scales its text while it plays (the pop) cannot leave wrapping to
    libass: libass wraps by the SCALED width, so a line that fits at 60 % would
    jump to two lines at 100 %. A word longer than a line keeps a line to itself."""
    limit = max(8, int((width - 2 * margin) / (AVG_GLYPH_EM * max(1, size))))
    out: List[List[str]] = []
    for words in lines:
        row: List[str] = []
        used = 0
        for w in words:
            if row and used + 1 + len(w) > limit:
                out.append(row)
                row, used = [], 0
            row.append(w)
            used += len(w) + (1 if len(row) > 1 else 0)
        if row:
            out.append(row)
    return out


def per_word_flags(counts: List[int]) -> List[bool]:
    """For each cue (its word count, in document order): is it lit word by word?
    Not when it has more than MAX_STYLED_WORDS words, nor when the words lit so
    far plus its own would pass WORD_BUDGET. The preview applies the same rule."""
    left = WORD_BUDGET
    out = []
    for n in counts:
        ok = 0 < n <= MAX_STYLED_WORDS and n <= left
        if ok:
            left -= n
        out.append(ok)
    return out


def word_spans_ms(words: List[str], duration_ms: int) -> List[Tuple[int, int]]:
    """``[(start_ms, end_ms)]`` per word, offsets inside the cue, covering the
    whole cue with no gap and no overlap. A word's share of the time is its
    length plus one (so a one-letter word is not a flash). Pure and integer:
    the same words always give the same spans, in both languages."""
    n = len(words)
    if n == 0:
        return []
    total = max(0, int(duration_ms))
    weights = [len(w) + 1 for w in words]
    whole = sum(weights)
    spans = []
    acc = 0
    prev = 0
    for w in weights:
        acc += w
        end = (total * acc + whole // 2) // whole
        spans.append((prev, end))
        prev = end
    return spans


def luminance(hex_colour: str) -> float:
    """Relative brightness 0..1 of ``#RRGGBB`` (Rec. 601 weights, no gamma: it only picks dark or light text)."""
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def text_on(hex_colour: str) -> str:
    """Black or white, whichever reads on ``hex_colour`` (a lit word's text on its box)."""
    return "#000000" if luminance(hex_colour) > 0.55 else "#FFFFFF"


def type_steps(n_chars: int) -> int:
    """How many reveal steps a typewriter uses for ``n_chars`` characters."""
    return max(1, min(MAX_TYPE_STEPS, int(n_chars)))


def type_schedule(n_atoms: int, duration_ms: int) -> List[Tuple[int, int]]:
    """``[(first_atom, at_ms)]``: the typewriter reveals atoms (a letter, a
    space or a line break) in runs, the run starting at ``first_atom`` showing
    up ``at_ms`` into the cue. It types for 70 % of the cue, at most 60 ms a
    letter, and never faster than a step a millisecond. Integer maths, so the
    export and the preview reveal the same letters at the same moments."""
    n = max(0, int(n_atoms))
    if n == 0:
        return []
    steps = type_steps(n)
    per = -(-n // steps)
    window = max(steps, min(int(int(duration_ms) * 7 // 10), 60 * n))
    return [(first, window * (first // per) // steps) for first in range(0, n, per)]
