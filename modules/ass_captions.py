"""Word-highlighted captions for the ffmpeg render paths, as an ASS file.

The MoviePy compositor draws one caption event per spoken word: the word's
whole four-word line in white, with the word being spoken re-drawn in the
highlight colour (``Compositor._build_subtitle_clips``). The ffmpeg paths used
to burn the Whisper ``.srt`` instead — the same four-word lines, but with no
moving highlight, in libass's default style. That was the visible difference
between the two renderers.

This module writes the compositor's captions as an Advanced SubStation file
that ffmpeg's ``subtitles`` filter (libass) burns in the same single pass it
already runs, from the SAME per-word specs the compositor gets
(``SubtitleGenerator.word_clips``): same lines, same per-word timing, same
font size, colours, stroke, position and wrap width. The ``.srt`` itself is
never touched — it is also the caption track uploaded to YouTube.

Nothing here raises into the pipeline. :func:`prepare` answers "which file
should be burnt in": the ``.ass`` when there are word timestamps, libass is
present and the file loads, otherwise the ``.srt`` exactly as before.
"""

from __future__ import annotations

import functools
import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

from modules import caption_styles

logger = logging.getLogger(__name__)

MODE_WORDS = "word_highlight"   # the .ass, one event per spoken word
MODE_SRT = "srt_lines"          # the Whisper .srt, line by line (the old path)

ASS_FILENAME = "word_captions.ass"

#: ImageMagick (MoviePy's TextClip) sizes text by its em at 72 dpi; libass
#: sizes it so the font's ascent + descent equals Fontsize. For the fonts this
#: runs with (DejaVu Sans 1.165, Liberation/Arial ~1.15 em) this factor makes a
#: libass line as wide as the MoviePy one — measured: a 60 pt line is 841 px in
#: DejaVu Sans Bold, the libass line at 70 is 839 px.
_ASS_SIZE_PER_POINT = 1.165

#: Caption fonts tried in order: the configured Arial Bold where it exists,
#: then the fonts the Actions runner installs (fonts-dejavu) and the other
#: common Linux fallback. Only the family NAME goes into the .ass; libass finds
#: the file through fontconfig and falls back to its default font if not.
_FONT_FILES = (
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
)

_NAMED_COLOURS = {
    "white": (255, 255, 255), "black": (0, 0, 0), "yellow": (255, 255, 0),
    "gold": (255, 215, 0), "red": (255, 0, 0), "green": (0, 128, 0),
    "blue": (0, 0, 255), "orange": (255, 165, 0), "cyan": (0, 255, 255),
}


@dataclass(frozen=True)
class CaptionStyle:
    """The compositor's caption look, in ASS terms."""
    font: str = "Arial"
    bold: bool = True
    font_size: float = 60.0          # the MoviePy/ImageMagick point size
    color: str = "white"             # compositor draws the base line in white
    highlight_color: str = "#FFD700"
    stroke_color: str = "black"
    stroke_width: float = 3.0
    #: Top of the caption box as a fraction of the frame height — the
    #: compositor positions its text clips at ("center", 0.80 * H).
    top_fraction: float = 0.80
    #: TextClip(method="caption", size=(W - 100, None)) wraps inside W - 100.
    side_margin: int = 50


@dataclass(frozen=True)
class CaptionChoice:
    """What to burn in: ``path`` (None → no subtitles at all), which ``mode``
    it is, and why the word captions were not used when they were not."""
    path: Optional[Path]
    mode: Optional[str]
    reason: Optional[str] = None


# ── pure pieces ─────────────────────────────────────────────────────────────

def ass_colour(value, default: str = "&H00FFFFFF") -> str:
    """``#RRGGBB`` / ``#RGB`` / a common colour name → ASS ``&HAABBGGRR``.
    Anything else returns ``default`` (logged) rather than a wrong colour."""
    rgb = None
    v = str(value or "").strip().lower()
    if v in _NAMED_COLOURS:
        rgb = _NAMED_COLOURS[v]
    else:
        m = re.fullmatch(r"#?([0-9a-f]{6}|[0-9a-f]{3})", v)
        if m:
            h = m.group(1)
            if len(h) == 3:
                h = "".join(c * 2 for c in h)
            rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    if rgb is None:
        logger.warning("Caption colour %r is not understood — using %s", value, default)
        return default
    r, g, b = rgb
    return f"&H00{b:02X}{g:02X}{r:02X}"


def _with_alpha(colour: str, alpha: int) -> str:
    """``&H00BBGGRR`` with its alpha byte replaced (ASS alpha: 00 opaque, FF clear)."""
    return "&H" + f"{max(0, min(255, int(alpha))):02X}" + colour[4:]


def _inline_colour(value, default: str) -> str:
    # Override tags take &HBBGGRR& (no alpha byte).
    return "&H" + ass_colour(value, default)[4:] + "&"


def ass_time(seconds: float) -> str:
    """Seconds → ASS ``H:MM:SS.cc`` (centiseconds, rounded)."""
    cs = max(0, int(round(float(seconds) * 100)))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def escape_text(word) -> str:
    """A transcript word made inert for an ASS Dialogue line: braces would
    open an override block and a backslash would start a tag (``\\N``,
    ``\\h``), so they become look-alike characters every font has; newlines
    and tabs become spaces."""
    text = str(word if word is not None else "")
    text = text.replace("\\", "/").replace("{", "(").replace("}", ")")
    return re.sub(r"\s+", " ", text).strip()


def _num(value) -> Optional[float]:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def caption_events(word_specs: Iterable[dict]) -> List[tuple]:
    """``[(start_s, end_s, words, active_index), ...]`` — one caption event per
    spoken word, as the compositor builds them: the word's own line
    (``chunk_words``, else just the word), active from its start for
    ``max(0.05, end - start)`` seconds.

    A word whose start or end is unknown (None / not a number) is skipped —
    never placed at 0 s. Events are sorted by start and an event is cut where
    the next one starts: MoviePy stacks overlapping clips in the same spot,
    but libass would push an overlapping line upward, so two lines would show
    at once. Two words with the same start keep only the later one, which is
    the one MoviePy draws on top.
    """
    raw = []
    for order, spec in enumerate(word_specs or []):
        if not isinstance(spec, dict):
            continue
        start, end = _num(spec.get("start")), _num(spec.get("end"))
        if start is None or end is None:
            continue
        words = [escape_text(w) for w in (spec.get("chunk_words") or [spec.get("word")])]
        try:
            idx = int(spec.get("word_index_in_line", 0) or 0)
        except (TypeError, ValueError):
            idx = 0
        if not any(words):
            continue
        start = max(0.0, start)
        raw.append((start, order, start + max(0.05, end - start), words, idx))
    raw.sort(key=lambda e: (e[0], e[1]))
    events = []
    for i, (start, _order, end, words, idx) in enumerate(raw):
        if i + 1 < len(raw):
            end = min(end, raw[i + 1][0])
        if round(end * 100) <= round(start * 100):
            continue
        events.append((start, end, words, idx))
    return events


def dialogue_text(words: Sequence[str], active: int, highlight_colour: str) -> str:
    """The line with ``words[active]`` in the highlight colour; ``{\\r}``
    returns to the style (white) for the rest of the line."""
    parts = []
    for i, w in enumerate(words):
        if not w:
            continue
        if i == active:
            parts.append("{\\c" + highlight_colour + "}" + w + "{\\r}")
        else:
            parts.append(w)
    return " ".join(parts)


def build_ass(word_specs: Iterable[dict], *, width: int, height: int,
              style: Optional[CaptionStyle] = None, font: Optional[str] = None) -> str:
    """The full ``.ass`` document for ``word_specs``. Pure."""
    st = style or CaptionStyle()
    family = font or st.font
    size = round(st.font_size * _ASS_SIZE_PER_POINT)
    primary = ass_colour(st.color, "&H00FFFFFF")
    outline = ass_colour(st.stroke_color, "&H00000000")
    hi = _inline_colour(st.highlight_color, "&H0000D7FF")
    margin_v = int(round(height * st.top_fraction))
    # BorderStyle 1 = outline; the outline is as thick as ImageMagick's stroke
    # line (which it centres on the glyph edge). Alignment 8 = top centre, so
    # MarginV is the top of the caption box, like the compositor's set_position.
    # WrapStyle 1 = greedy end-of-line wrapping, as ImageMagick's caption: does.
    lines = [
        "[Script Info]",
        "; Written by modules/ass_captions.py from the Whisper word timestamps",
        "ScriptType: v4.00+",
        f"PlayResX: {int(width)}",
        f"PlayResY: {int(height)}",
        "WrapStyle: 1",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,{escape_text(family).replace(',', ' ')},{size},{primary},{primary},"
        f"{outline},&H00000000,{-1 if st.bold else 0},0,0,0,100,100,0,0,1,"
        f"{st.stroke_width:g},0,8,{int(st.side_margin)},{int(st.side_margin)},{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, words, idx in caption_events(word_specs):
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Caption,,0,0,0,,"
                     f"{dialogue_text(words, idx, hi)}")
    return "\n".join(lines) + "\n"


# ── timeline text overlays ──────────────────────────────────────────────────
#
# Timeline titles and captions (modules/timeline_render.py) are burnt with the
# same libass ``subtitles`` filter as the word captions, from one ASS file.
# Every overlay is placed with \pos, so libass never moves a line to avoid
# another one — the picture is exactly what the timeline says.

#: A text box's padding around the text, as a fraction of the font size.
BOX_PADDING = 0.25

#: Anchor name → ASS \an (numpad) alignment.
ANCHOR_AN = {
    "bottom-left": 1, "bottom": 2, "bottom-right": 3,
    "left": 4, "center": 5, "right": 6,
    "top-left": 7, "top": 8, "top-right": 9,
}


def overlay_text(text) -> str:
    """User text made inert for a Dialogue line (no override tags can be
    smuggled in — see :func:`escape_text`), keeping its line breaks as \\N."""
    lines = [escape_text(line) for line in str(text if text is not None else "").splitlines()]
    return "\\N".join(lines).strip()


def build_overlay_ass(overlays: Sequence, *, width: int, height: int) -> str:
    """The ``.ass`` document for timeline text overlays (``render_spec.TextOverlay``
    objects), one style and one event each, drawn in list order (later on
    top). Pure and deterministic: the same overlays always give the same file."""
    w, h = int(width), int(height)
    margin = int(round(w * 0.04))
    lines = [
        "[Script Info]",
        "; Written by modules/ass_captions.py from timeline text overlays",
        "ScriptType: v4.00+",
        f"PlayResX: {w}",
        f"PlayResY: {h}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for i, o in enumerate(overlays):
        if getattr(o, "caption_style", None):
            lines.append(styled_style_line(i, o, w, margin))
            continue
        primary = ass_colour(o.color, "&H00FFFFFF")
        outline = ass_colour(o.outline_color, "&H00000000")
        family = escape_text(o.font).replace(",", " ")
        # Looks (the defaults write the style line this always wrote). A box is
        # libass BorderStyle 3: the OUTLINE colour fills a rectangle behind the
        # text and Outline is its padding, so the box replaces the outline.
        # The drop shadow is drawn in BackColour (a 60 % black), offset on both axes.
        back, border, width, shadow = "&H00000000", 1, f"{float(o.outline_width):g}", "0"
        shadow_px = float(getattr(o, "shadow", 0.0) or 0.0)
        if shadow_px > 0:
            back, shadow = "&H66000000", f"{shadow_px:g}"
        box_color = getattr(o, "box_color", None)
        if box_color is not None:
            opacity = float(getattr(o, "box_opacity", 0.7))
            outline = _with_alpha(ass_colour(box_color, "&H00000000"), round((1 - opacity) * 255))
            border, width = 3, str(max(2, int(round(int(o.size) * BOX_PADDING))))
        lines.append(
            f"Style: O{i},{family},{int(o.size)},{primary},{primary},{outline},{back},"
            f"{-1 if o.bold else 0},0,0,0,100,100,0,0,{border},{width},{shadow},"
            f"{ANCHOR_AN.get(o.anchor, 5)},{margin},{margin},0,1")
    lines += ["", "[Events]",
              "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for i, o in enumerate(overlays):
        if getattr(o, "caption_style", None):
            lines.extend(styled_events(i, o, w, h))
            continue
        x, y = int(round(float(o.x) * w)), int(round(float(o.y) * h))
        tags = f"\\pos({x},{y})"
        fi, fo = int(round(float(o.fade_in_s) * 1000)), int(round(float(o.fade_out_s) * 1000))
        if fi or fo:
            tags += f"\\fad({fi},{fo})"
        lines.append(f"Dialogue: {i},{ass_time(o.start_s)},{ass_time(o.end_s)},O{i},,0,0,0,,"
                     "{" + tags + "}" + overlay_text(o.text))
    return "\n".join(lines) + "\n"


# ── animated caption styles ─────────────────────────────────────────────────
#
# A timeline caption with ``caption_style`` (modules/caption_styles.py) is
# written by the functions below instead of the plain overlay path: one style
# line and one or two events per cue, placed with \pos / \move like every
# overlay. The ONLY inputs are the closed style id, clamped numbers and
# colours validated as #RRGGBB, and the cue's words after ``escape_text`` - so
# the animation tags are ours and the cue's text cannot add one.

#: The opacity of the dark box behind a boxed caption and of a lower third's colour block.
BOXED_OPACITY = 0.75
#: A boxed caption's padding as a share of the font size (a plain text box uses
#: BOX_PADDING): libass draws a box per glyph, so a wide pad stacks translucent boxes.
BOXED_PADDING = 0.15
LOWER_THIRD_OPACITY = 0.9
#: A \fad / \move never runs longer than half / all of a short cue.
_POP_MS = (130, 250)


def _cue_ms(o) -> int:
    """The event's length in ms, from the same centisecond rounding the Dialogue line uses."""
    cs = int(round(float(o.end_s) * 100)) - int(round(float(o.start_s) * 100))
    return max(10, cs * 10)


def _highlight(o) -> str:
    return o.highlight_color or caption_styles.STYLES[o.caption_style].highlight_color


def _pad(o, share: float = BOX_PADDING) -> int:
    return max(2, int(round(int(o.size) * share)))


def styled_style_line(i: int, o, width: int, margin: int) -> str:
    """The ``Style:`` line of a styled caption cue (named ``O{i}`` like every overlay's)."""
    sid = o.caption_style
    base = ass_colour(o.color, "&H00FFFFFF")
    hi = ass_colour(_highlight(o), "&H0000D4FF")
    outline = ass_colour(o.outline_color, "&H00000000")
    primary, secondary = base, base
    border, ow, shadow, back = 1, f"{float(o.outline_width):g}", "0", "&H00000000"
    if sid == "karaoke":
        # libass paints a karaoke syllable in SecondaryColour until it is sung, then PrimaryColour.
        primary = hi
    elif sid == "boxed":
        outline = _with_alpha(outline, round((1 - BOXED_OPACITY) * 255))
        border, ow = 3, str(_pad(o, BOXED_PADDING))
    elif sid == "lower_third":
        outline = _with_alpha(hi, round((1 - LOWER_THIRD_OPACITY) * 255))
        border, ow = 3, str(_pad(o))
    elif sid == "outlined":
        outline = hi
    elif sid == "neon":
        outline, ow = hi, str(max(1, int(round(int(o.size) * 0.03))))
    elif sid == "clean":
        shadow, back = "2", "&H80000000"
    family = escape_text(o.font).replace(",", " ")
    return (f"Style: O{i},{family},{int(o.size)},{primary},{secondary},{outline},{back},"
            f"{-1 if o.bold else 0},0,0,0,100,100,0,0,{border},{ow},{shadow},"
            f"{ANCHOR_AN.get(o.anchor, 5)},{margin},{margin},0,1")


def _cue_lines(text) -> List[List[str]]:
    return caption_styles.cue_lines("\n".join(escape_text(line)
                                              for line in str(text if text is not None else "").splitlines()))


def _compose(lines: List[List[str]], block, close: str = "") -> str:
    """The cue's words with ``block(k)`` (a tag block) before word ``k`` and
    ``close`` after it; words joined by spaces, lines by \\N."""
    k = 0
    out = []
    for words in lines:
        parts = []
        for w in words:
            parts.append(block(k) + w + close)
            k += 1
        out.append(" ".join(parts))
    return "\\N".join(out)


def _plain(lines: List[List[str]]) -> str:
    return "\\N".join(" ".join(words) for words in lines)


def _fad(ms: int, fade_in: int, fade_out: int) -> str:
    half = ms // 2
    return f"\\fad({min(fade_in, half)},{min(fade_out, half)})"


def _colour_words(o, lines: List[List[str]], dur_ms: int, *, boxed: bool) -> str:
    """One word lit at a time: each word's tag block sets the base look, then
    steps (a 1 ms \\t) to the lit look at the word's start and back at its end.
    libass evaluates a \\t where it stands in the text, so each word carries
    its own window and the blocks cannot leak into one another."""
    words = [w for ln in lines for w in ln]
    if len(words) > caption_styles.MAX_STYLED_WORDS:
        return _plain(lines)
    spans = caption_styles.word_spans_ms(words, dur_ms)
    base = _inline_colour(o.color, "&H00FFFFFF")
    hi = _inline_colour(_highlight(o), "&H0000D4FF")
    box = _inline_colour(o.outline_color, "&H00000000")
    dark = _inline_colour(caption_styles.text_on(_highlight(o)), "&H00000000")
    n = len(words)

    # A lit word's box is solid; the others' is the style's own translucent one.
    rest_alpha = "\\3a&H%02X&" % round((1 - BOXED_OPACITY) * 255)

    def look(text_colour: str, box_colour: str, box_alpha: str) -> str:
        return "\\1c" + text_colour + ("\\3c" + box_colour + box_alpha if boxed else "")

    resting = look(base, box, rest_alpha)
    lit = look(dark if boxed else hi, hi, "\\3a&H00&")

    def block(k: int) -> str:
        a, b = spans[k]
        tags = resting + f"\\t({a},{a + 1},{lit})"
        if k + 1 < n:
            tags += f"\\t({b},{b + 1},{resting})"
        return "{" + tags + "}"

    return _compose(lines, block, "{" + resting + "}" if boxed else "")


def _karaoke(lines: List[List[str]], dur_cs: int) -> str:
    words = [w for ln in lines for w in ln]
    spans = caption_styles.word_spans_ms(words, dur_cs)   # centiseconds: the unit \\kf takes
    return _compose(lines, lambda k: "{\\kf%d}" % (spans[k][1] - spans[k][0]))


def _typewriter(lines: List[List[str]], dur_ms: int) -> str:
    """Letters appear one after another: every step is a run of characters that
    starts fully transparent and steps to opaque at its time. All the letters
    exist from the start, so the line never re-wraps while it is typed."""
    atoms: List[str] = []
    for n, words in enumerate(lines):
        if n:
            atoms.append("\\N")
        atoms.extend(list(" ".join(words)))
    schedule = caption_styles.type_schedule(len(atoms), dur_ms)
    parts = []
    for n, (first, at) in enumerate(schedule):
        last = schedule[n + 1][0] if n + 1 < len(schedule) else len(atoms)
        parts.append("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}" % (at, at + 1) + "".join(atoms[first:last]))
    return "".join(parts)


def styled_events(i: int, o, width: int, height: int) -> List[str]:
    """The ``Dialogue:`` line(s) of a styled caption cue: one, or two for the
    glow (the soft halo first, the sharp text over it in the same layer)."""
    sid = o.caption_style
    x, y = int(round(float(o.x) * width)), int(round(float(o.y) * height))
    ms = _cue_ms(o)
    lines = _cue_lines(o.text)
    head = f"Dialogue: {i},{ass_time(o.start_s)},{ass_time(o.end_s)},O{i},,0,0,0,,"
    pos = f"\\pos({x},{y})"
    size = int(o.size)
    if sid == "karaoke":
        return [head + "{" + pos + _fad(ms, 80, 80) + "}" + _karaoke(lines, ms // 10)]
    if sid == "pop_in":
        a, b = _POP_MS
        lines = caption_styles.wrap_lines(lines, width, int(round(width * 0.04)), size)
        tags = ("\\q2" + pos + "\\fscx60\\fscy60" + f"\\t(0,{a},\\fscx118\\fscy118)"
                + f"\\t({a},{b},\\fscx100\\fscy100)" + _fad(ms, 70, 100))
        return [head + "{" + tags + "}" + _plain(lines)]
    if sid == "boxed":
        return [head + "{" + pos + _fad(ms, 80, 80) + "}" + _colour_words(o, lines, ms, boxed=True)]
    if sid == "big_centre":
        return [head + "{" + pos + _fad(ms, 60, 60) + "}" + _colour_words(o, lines, ms, boxed=False)]
    if sid == "lower_third":
        move = f"\\move({x - 48},{y},{x},{y},0,{min(240, ms)})"
        return [head + "{" + move + _fad(ms, 150, 120) + "}" + _plain(lines)]
    if sid == "outlined":
        return [head + "{" + pos + _fad(ms, 60, 60) + "}" + _plain(lines)]
    if sid == "neon":
        hi = _inline_colour(_highlight(o), "&H0000D4FF")
        halo = (pos + f"\\bord{max(3, int(round(size * 0.12)))}\\blur{max(4, int(round(size * 0.2)))}"
                + "\\1c" + hi + "\\3c" + hi + "\\1a&H80&\\3a&H30&" + _fad(ms, 120, 120))
        sharp = pos + "\\blur0.6" + _fad(ms, 120, 120)
        return [head + "{" + halo + "}" + _plain(lines), head + "{" + sharp + "}" + _plain(lines)]
    if sid == "typewriter":
        return [head + "{" + pos + "}" + _typewriter(lines, ms)]
    if sid == "line_slide":
        move = f"\\move({x},{y + int(round(size * 0.6))},{x},{y},0,{min(260, ms)})"
        return [head + "{" + move + _fad(ms, 180, 140) + "}" + _plain(lines)]
    # clean
    return [head + "{" + pos + _fad(ms, 150, 150) + "}" + _plain(lines)]


# ── environment ─────────────────────────────────────────────────────────────

def configured_style() -> CaptionStyle:
    """The compositor's caption settings from ``config`` (defaults if absent)."""
    try:
        import config

        font = str(getattr(config, "SUBTITLE_FONT", "Arial-Bold") or "Arial-Bold")
        return CaptionStyle(
            font=re.sub(r"[-_ ]?bold$", "", font, flags=re.I) or "Arial",
            bold="bold" in font.lower(),
            font_size=float(getattr(config, "SUBTITLE_FONT_SIZE", 60) or 60),
            highlight_color=str(getattr(config, "SUBTITLE_HIGHLIGHT_COLOR", "#FFD700") or "#FFD700"),
            stroke_color=str(getattr(config, "SUBTITLE_STROKE_COLOR", "black") or "black"),
            stroke_width=float(getattr(config, "SUBTITLE_STROKE_WIDTH", 3) or 0),
        )
    except Exception:
        return CaptionStyle()


def resolve_font_family(candidates: Sequence[str] = _FONT_FILES) -> Optional[str]:
    """The family name of the first caption font file present on this
    machine, or None (then the configured name is used and libass falls back
    to its default font)."""
    for path in candidates:
        try:
            if not Path(path).is_file():
                continue
            from PIL import ImageFont

            family = ImageFont.truetype(path, 12).getname()[0]
            if family:
                return str(family)
        except Exception:
            continue
    return None


@functools.lru_cache(maxsize=8)
def has_libass(ffmpeg: str) -> bool:
    """True when this ffmpeg build has the libass ``subtitles`` filter."""
    try:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True,
                              text=True, timeout=30)
    except Exception:
        return False
    return bool(re.search(r"^\s*\S+\s+subtitles\s", proc.stdout or "", re.M))


def subtitles_filter(path) -> str:
    """The ``subtitles=`` filter for ``path``, quoted as the render commands
    already quote the ``.srt``."""
    return "subtitles='" + str(path).replace("'", r"'\''") + "'"


def _loads_in_ffmpeg(ffmpeg: str, path: Path, width: int, height: int) -> Optional[str]:
    """Burn ``path`` onto one black frame; None when it worked, else why not.
    Catches a file libass or the filter cannot load before the real render."""
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
           "-i", f"color=c=black:s={int(width)}x{int(height)}:d=0.1",
           "-vf", subtitles_filter(path), "-frames:v", "1", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:
        return f"{type(e).__name__}: {e}"
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        return f"ffmpeg exited {proc.returncode}: {' / '.join(tail) or 'no stderr'}"
    return None


def prepare(srt_path, word_specs, *, width: int, height: int, ffmpeg: Optional[str] = None,
            out_path=None, verify: bool = True) -> CaptionChoice:
    """Which subtitle file the ffmpeg render should burn in. Never raises.

    The ``.ass`` (written next to the ``.srt``, or at ``out_path``) when there
    are word timestamps, the ffmpeg build has libass and the file loads; else
    the ``.srt`` unchanged (the previous behaviour), with the reason."""
    srt = Path(srt_path) if srt_path else None
    fallback_mode = MODE_SRT if srt else None

    def fallback(reason: str) -> CaptionChoice:
        return CaptionChoice(srt, fallback_mode, reason)

    try:
        if not word_specs:
            return fallback("no word timestamps")
        if out_path is None:
            if srt is None:
                return fallback("no subtitles directory to write the word captions to")
            out_path = srt.with_name(ASS_FILENAME)
        out_path = Path(out_path)
        if ffmpeg is None:
            from modules import render_backend

            ffmpeg = render_backend.resolve_ffmpeg()
        if not has_libass(ffmpeg):
            return fallback("this ffmpeg build has no libass subtitles filter")
        style = configured_style()
        doc = build_ass(word_specs, width=width, height=height, style=style,
                        font=resolve_font_family() or style.font)
        if "\nDialogue:" not in doc:
            return fallback("no word has a usable start/end time")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(doc, encoding="utf-8")
        if verify:
            problem = _loads_in_ffmpeg(ffmpeg, out_path, width, height)
            if problem:
                return fallback(f"word captions did not load: {problem}"[:300])
        return CaptionChoice(out_path, MODE_WORDS)
    except Exception as e:
        return fallback(f"{type(e).__name__}: {e}"[:300])
