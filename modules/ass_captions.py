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
