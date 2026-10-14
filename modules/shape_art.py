"""Stickers, shapes and the progress bar: the closed set and how each is drawn.

A shape is a document entry (``shapes`` in modules/timeline.py), not a library
file. The export draws it ONCE into a small PNG (Pillow, which the worker image
already has for thumbnails and the media worker) and lays that PNG over the
picture through the picture-overlay path every sticker and logo uses, so its
position, size, opacity, entrance / exit animation and move behave exactly like
a picture overlay's. Nothing is fetched and no third-party art is used: every
shape is polygons and rounded boxes computed here.

Why a PNG and not ffmpeg's own ``drawbox`` / ``drawtext``: a star, a ring, an
arrow and a rounded label have no filter, ``drawbox`` cannot animate its width
on the ffmpeg builds the worker may have (the progress bar grows with time),
and a PNG keeps every user character out of the filter graph altogether: a
pill's text is rasterised here (after the same ``ass_captions.escape_text``
clean-up a text overlay's words get) and ffmpeg only ever sees a file path
this module wrote.

The progress bar is the one shape that is not a plain overlay: it is a bar as
wide as the frame, slid in from the left by ``render_spec`` so that the part
that shows is ``t / length`` of the width (``picture_overlay_filters``).

Pure and deterministic: the same entry and frame give the same PNG bytes, so a
document renders the same video every time.
"""

from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

#: The closed set (command-center/lib/editorShapes.ts has the same lists; a test pins them).
SHAPE_KINDS = ("arrow", "circle", "rect", "star", "pill", "line", "progress")
ARROW_DIRS = ("right", "left", "up", "down")
PROGRESS_EDGES = ("bottom", "top")
#: Shapes in a document, and the layers (picture overlays + shapes) one export may lay over the
#: picture: render_spec.MAX_PICTURE_OVERLAYS is the same 16 and each layer is an input of the final pass.
MAX_SHAPES = 12
MAX_LAYERS = 16
#: Above 1440p (more than 2560x1440 pixels, either way up) a document with shapes may lay at most this many
#: layers (picture overlays + shapes) over the picture: each is a filter chain of the final pass, and the
#: bundled ffmpeg 7.0.2 ran out of the export's 2 GiB (``Cannot allocate memory``, exit 187) at 6 layers at
#: 3840x2160 and 60 fps whatever their size (5 passed; 6 passed at 30 fps, 8 failed; 1440p60 passed 12;
#: 5.1.1 passed 7). Not asked of a document without shapes: its picture overlays are as they were.
LARGE_FRAME_LAYERS_MAX = 5
#: A pill's label, in characters (code points). Short on purpose: a label, not a caption.
TEXT_MAX = 24
#: What a shape draws in when it names no colour, and the most a stroke may take of the
#: shape's shorter side (0 = solid).
COLOR_DEFAULT = "#FFD60A"
OUTLINE_MAX = 0.5
#: A line's or the progress bar's thickness as a fraction of the frame HEIGHT.
THICK_MIN, THICK_MAX = 0.002, 0.05
THICK_DEFAULTS = {"line": 0.008, "progress": 0.012}
#: A rectangle's width / height.
ASPECT_MIN, ASPECT_MAX, ASPECT_DEFAULT = 0.2, 5.0, 1.6
#: Shape width as a fraction of the frame (the picture overlay's own range).
W_MIN, W_MAX, W_DEFAULT = 0.05, 1.0, 0.3
EDGE_DEFAULT = "bottom"
DIR_DEFAULT = "right"
#: A pill's own proportions, in units of its font size: text padded by 0.55 em left and right and
#: with a 1.55 em tall box. The preview estimates the width from the character count (rough).
PILL_PAD_X_EM = 0.55
PILL_HEIGHT_EM = 1.55
#: A regular five-point star: inner / outer radius, and its bounding box in outer radii.
STAR_INNER = 0.381966
STAR_WIDTH_R = 2 * math.sin(math.radians(72))
STAR_HEIGHT_R = 1 + math.cos(math.radians(36))
#: Arrow proportions (right-pointing, long side 1): shaft thickness, and where the head starts.
ARROW_SHAFT = 0.36
ARROW_HEAD_AT = 0.52
#: A canvas is drawn this many times too big, then reduced (anti-aliasing), unless that would pass
#: this many pixels (a full-width circle in a 4K frame is 15 million already).
SUPERSAMPLE_MAX = 4
SUPERSAMPLE_BUDGET_PX = 24_000_000

#: Which document fields each kind takes (besides id, kind, start_s, end_s, color, opacity and the
#: entrance / exit fields, which every kind has). The validators refuse a field that does not apply.
KIND_FIELDS = {
    "arrow": ("x", "y", "w", "dir", "move"),
    "circle": ("x", "y", "w", "outline", "move"),
    "rect": ("x", "y", "w", "outline", "aspect", "move"),
    "star": ("x", "y", "w", "outline", "move"),
    "pill": ("x", "y", "w", "outline", "text", "move"),
    "line": ("x", "y", "w", "thick", "move"),
    "progress": ("edge", "thick"),
}
#: The progress bar animates with a fade only: a slide or a pop would move the bar that is
#: already being slid by the clock.
PROGRESS_ANIMS = ("fade",)

#: Bold fonts tried in order (the worker image installs fonts-dejavu; Liberation is the other common
#: Linux one). No bitmap fallback: a label drawn in an unreadable default would be a silent quality drop.
_FONT_FILES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

_HEX_LEN = 7


class ShapeArtError(RuntimeError):
    """A shape that cannot be drawn on this machine (no font, no Pillow); says what fixes it."""


@dataclass(frozen=True)
class ShapeArt:
    """What to draw: the look of one shape (its size comes from the overlay it rides on)."""
    kind: str
    color: str = COLOR_DEFAULT
    outline: float = 0.0
    aspect: float = ASPECT_DEFAULT
    dir: str = DIR_DEFAULT
    thick: float = 0.0
    text: str = ""
    edge: str = EDGE_DEFAULT

    def to_dict(self) -> dict:
        d = {"kind": self.kind, "color": self.color}
        if self.outline:
            d["outline"] = self.outline
        if self.kind == "rect":
            d["aspect"] = self.aspect
        if self.kind == "arrow":
            d["dir"] = self.dir
        if self.kind in THICK_DEFAULTS:
            d["thick"] = self.thick
        if self.kind == "pill":
            d["text"] = self.text
        if self.kind == "progress":
            d["edge"] = self.edge
        return d

    @staticmethod
    def from_dict(d: dict) -> "ShapeArt":
        kind = str(d.get("kind") or "")
        return ShapeArt(
            kind=kind, color=str(d.get("color") or COLOR_DEFAULT),
            outline=float(d.get("outline") or 0.0),
            aspect=float(d.get("aspect") or ASPECT_DEFAULT),
            dir=str(d.get("dir") or DIR_DEFAULT),
            thick=float(d.get("thick") or THICK_DEFAULTS.get(kind, 0.0)),
            text=str(d.get("text") or ""), edge=str(d.get("edge") or EDGE_DEFAULT))

    @property
    def is_progress(self) -> bool:
        return self.kind == "progress"


# ── what is allowed (the render spec's twin of the document's validator) ────

def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def text_problem(text) -> Optional[str]:
    """Why a pill's text cannot be used, or None. Shared by the document validator and the spec's:
    non-empty after trimming, at most ``TEXT_MAX`` characters (code points, which is what the
    TypeScript twin counts too) and no control, format, line or surrogate characters (Cc, Cf, Zl, Zp,
    Cs: the categories that are stable across Unicode versions, so both validators agree)."""
    if not isinstance(text, str) or not text.strip():
        return f"text must be non-empty text of at most {TEXT_MAX} characters"
    if len(text) > TEXT_MAX:
        return f"text must be non-empty text of at most {TEXT_MAX} characters"
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp", "Cs") for ch in text):
        return "text must not contain control or invisible formatting characters"
    return None


def problems(shape: ShapeArt) -> List[str]:
    """Every reason ``shape`` cannot be drawn (the render spec's validation)."""
    out: List[str] = []
    if shape.kind not in SHAPE_KINDS:
        return [f"shape kind must be one of {list(SHAPE_KINDS)}"]
    if not (isinstance(shape.color, str) and len(shape.color) == _HEX_LEN and shape.color[0] == "#"
            and all(c in "0123456789abcdefABCDEF" for c in shape.color[1:])):
        out.append("shape colour must be a #RRGGBB colour")
    if not (_finite(shape.outline) and 0 <= shape.outline <= OUTLINE_MAX):
        out.append(f"shape outline must be from 0 to {OUTLINE_MAX:g}")
    if shape.kind == "rect" and not (_finite(shape.aspect) and ASPECT_MIN <= shape.aspect <= ASPECT_MAX):
        out.append(f"shape aspect must be from {ASPECT_MIN:g} to {ASPECT_MAX:g}")
    if shape.kind == "arrow" and shape.dir not in ARROW_DIRS:
        out.append(f"arrow direction must be one of {list(ARROW_DIRS)}")
    if shape.kind in THICK_DEFAULTS and not (_finite(shape.thick) and THICK_MIN <= shape.thick <= THICK_MAX):
        out.append(f"shape thickness must be from {THICK_MIN:g} to {THICK_MAX:g}")
    if shape.kind == "progress" and shape.edge not in PROGRESS_EDGES:
        out.append(f"progress edge must be one of {list(PROGRESS_EDGES)}")
    if shape.kind == "pill":
        p = text_problem(shape.text)
        if p:
            out.append(f"shape {p}")
    return out


# ── geometry (pure; the editor's preview uses the same numbers) ─────────────

def _even(v: float) -> int:
    return max(2, int(round(v)) // 2 * 2)


def progress_height_px(thick: float, frame_h: int) -> int:
    """The progress bar's height in pixels (even, so the overlay's even-size scaling is a no-op)."""
    return _even(thick * frame_h)


def progress_center_y(shape: ShapeArt, frame_h: int) -> float:
    """The bar's centre as a fraction of the frame height: against the top or the bottom edge."""
    half = progress_height_px(shape.thick, frame_h) / 2 / frame_h
    return half if shape.edge == "top" else 1 - half


def base_aspect(shape: ShapeArt, w: float, frame_w: int, frame_h: int) -> Optional[float]:
    """Width / height of the shape's picture, or None for a pill (its aspect is the text's, which
    needs the font). ``w`` is the overlay's width as a fraction of the frame."""
    k = shape.kind
    if k in ("circle", "star"):
        return 1.0
    if k == "rect":
        return shape.aspect
    if k == "arrow":
        return 0.5 if shape.dir in ("up", "down") else 2.0
    if k == "line":
        return max(1.0, w * frame_w) / progress_height_px(shape.thick, frame_h)
    if k == "progress":
        return frame_w / progress_height_px(shape.thick, frame_h)
    return None


def fit_px(aspect: float, w: float, frame_w: int, frame_h: int) -> Tuple[int, int]:
    """The picture's size in pixels: ``w`` of the frame wide, its height from ``aspect``, inside the
    same box the overlay filter scales to (the frame's width by twice its height), so the filter
    leaves it alone. Both sides even (what ``force_divisible_by=2`` makes of any size)."""
    box_w = _even(w * frame_w)
    box_h = max(2, int(frame_h) * 2)
    pw = box_w
    ph = pw / aspect
    if ph > box_h:
        ph = box_h
        pw = ph * aspect
    return _even(pw), _even(ph)


# ── drawing ─────────────────────────────────────────────────────────────────

def _rgb(color: str) -> Tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def contrast_on(color: str) -> str:
    """Black or white text for a solid ``color`` (Rec. 709 luma, a fixed threshold)."""
    r, g, b = _rgb(color)
    return "#111111" if 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 else "#FFFFFF"


def _font_path() -> str:
    for path in _FONT_FILES:
        if Path(path).is_file():
            return path
    raise ShapeArtError("no bold font found for a shape's label — install fonts-dejavu (the worker image has it)")


def _load_font(size: float):
    from PIL import ImageFont

    return ImageFont.truetype(_font_path(), max(1, int(round(size))))


def pill_aspect(text: str) -> float:
    """Width / height of a pill: the label at a fixed size, padded (needs the font)."""
    font = _load_font(100)
    width = font.getlength(text) + 2 * PILL_PAD_X_EM * 100
    return width / (PILL_HEIGHT_EM * 100)


def _supersample(pw: int, ph: int) -> int:
    for ss in range(SUPERSAMPLE_MAX, 1, -1):
        if pw * ph * ss * ss <= SUPERSAMPLE_BUDGET_PX:
            return ss
    return 1


def _star_points(cx: float, cy: float, r: float) -> List[Tuple[float, float]]:
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * STAR_INNER
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def _mask(size: Tuple[int, int], paint) -> "object":
    from PIL import Image, ImageDraw

    m = Image.new("L", size, 0)
    paint(ImageDraw.Draw(m))
    return m


def _arrow_mask(long_px: int, short_px: int):
    """A right-pointing arrow filling a (long, short) canvas."""
    def paint(d):
        shaft = short_px * ARROW_SHAFT
        top, bottom = (short_px - shaft) / 2, (short_px + shaft) / 2
        head = long_px * ARROW_HEAD_AT
        d.polygon([(0, top), (head, top), (head, 0), (long_px, short_px / 2),
                   (head, short_px), (head, bottom), (0, bottom)], fill=255)
    return _mask((long_px, short_px), paint)


def _masks(shape: ShapeArt, pw: int, ph: int) -> List[Tuple["object", str]]:
    """``[(mask, colour), ...]`` of the shape at ``pw`` x ``ph``, bottom first (the shape, then a
    pill's text)."""
    k, color = shape.kind, shape.color
    stroke = shape.outline * min(pw, ph)

    def ring(paint_outer, paint_inner):
        def paint(d):
            paint_outer(d, 255)
            if stroke > 0:
                paint_inner(d, 0)
        return _mask((pw, ph), paint)

    if k == "circle":
        return [(ring(lambda d, v: d.ellipse([0, 0, pw - 1, ph - 1], fill=v),
                      lambda d, v: d.ellipse([stroke, stroke, pw - 1 - stroke, ph - 1 - stroke], fill=v)), color)]
    if k == "rect":
        return [(ring(lambda d, v: d.rectangle([0, 0, pw - 1, ph - 1], fill=v),
                      lambda d, v: d.rectangle([stroke, stroke, pw - 1 - stroke, ph - 1 - stroke], fill=v)), color)]
    if k in ("line", "progress"):
        radius = ph / 2 if k == "line" else 0
        return [(_mask((pw, ph), lambda d: d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=radius, fill=255)), color)]
    if k == "star":
        r = min(pw / STAR_WIDTH_R, ph / STAR_HEIGHT_R)
        cx, cy = pw / 2, ph / 2 + r * (1 - STAR_HEIGHT_R / 2)   # the box of the points, centred
        inner_r = max(0.0, r - stroke * 1.6)

        def outer(d, v):
            d.polygon(_star_points(cx, cy, r), fill=v)

        def inner(d, v):
            if inner_r > 0:
                d.polygon(_star_points(cx, cy, inner_r), fill=v)
        return [(ring(outer, inner), color)]
    if k == "arrow":
        vertical = shape.dir in ("up", "down")
        long_px, short_px = (ph, pw) if vertical else (pw, ph)
        m = _arrow_mask(long_px, short_px)
        from PIL import Image
        m = {"right": m, "left": m.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
             "up": m.transpose(Image.Transpose.ROTATE_90),
             "down": m.transpose(Image.Transpose.ROTATE_270)}[shape.dir]
        return [(m, color)]
    if k == "pill":
        from modules import ass_captions   # the text overlays' own clean-up of a typed string
        text = ass_captions.escape_text(shape.text)
        radius = ph / 2

        def box(d, v):
            d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=radius, fill=v)

        def hole(d, v):
            d.rounded_rectangle([stroke, stroke, pw - 1 - stroke, ph - 1 - stroke],
                                radius=max(0.0, radius - stroke), fill=v)
        font_px = ph / PILL_HEIGHT_EM
        font = _load_font(font_px)
        # The label is fitted to the box: if it is wider than the box allows (the box was cut to the
        # overlay filter's limits), the font shrinks with it.
        room = pw - 2 * PILL_PAD_X_EM * font_px
        if room > 0 and font.getlength(text) > room:
            font = _load_font(font_px * room / font.getlength(text))
        def write(d):
            d.text((pw / 2, ph / 2), text, font=font, fill=255, anchor="mm")
        label = _mask((pw, ph), write)
        solid = ring(box, hole) if stroke > 0 else _mask((pw, ph), lambda d: box(d, 255))
        text_color = color if stroke > 0 else contrast_on(color)
        return [(solid, color), (label, text_color)]
    raise ShapeArtError(f"unknown shape kind {shape.kind!r}")


def draw(shape: ShapeArt, pw: int, ph: int):
    """The shape as an RGBA picture of ``pw`` x ``ph`` pixels (transparent around it)."""
    from PIL import Image

    ss = _supersample(pw, ph)
    layers = _masks(shape, pw * ss, ph * ss) if ss > 1 else _masks(shape, pw, ph)
    out = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    for mask, color in layers:
        if ss > 1:
            mask = mask.resize((pw, ph), Image.Resampling.LANCZOS)
        layer = Image.new("RGBA", (pw, ph), _rgb(color) + (255,))
        layer.putalpha(mask)
        out = Image.alpha_composite(out, layer)
    return out


def png_size(shape: ShapeArt, w: float, frame_w: int, frame_h: int) -> Tuple[int, int]:
    """The PNG's size in pixels for a shape ``w`` of the frame wide (the widest it ever is)."""
    if shape.kind == "pill":
        text_aspect = pill_aspect(_clean(shape.text))
        return fit_px(text_aspect, w, frame_w, frame_h)
    aspect = base_aspect(shape, w, frame_w, frame_h)
    if shape.kind == "progress":
        return _even(frame_w), progress_height_px(shape.thick, frame_h)
    if shape.kind == "line":
        return _even(w * frame_w), progress_height_px(shape.thick, frame_h)
    return fit_px(aspect or 1.0, w, frame_w, frame_h)


def _clean(text: str) -> str:
    from modules import ass_captions

    return ass_captions.escape_text(text)


def write_png(shape: ShapeArt, w: float, frame_w: int, frame_h: int, path: str) -> Tuple[int, int]:
    """Draw ``shape`` for a frame of ``frame_w`` x ``frame_h`` and write it to ``path``; returns its size."""
    pw, ph = png_size(shape, w, frame_w, frame_h)
    draw(shape, pw, ph).save(str(path), format="PNG", compress_level=3)
    return pw, ph
