"""The text layer and the sidebar-size readability check for concept thumbnails.

A concept thumbnail's picture is generated clean, with no lettering in it
(modules/thumbnail_concept.py). The headline is drawn here, by us, so the words
are exactly the fact-checked overlay text in the channel's language — image
models misspell, and misspell Cyrillic and Uzbek Latin worse. The frame-mode
renderer (modules/thumbnail_generator.py) is deliberately not touched: a channel
that never opted in gets the same bytes it always did.

Then the check a thumbnail is actually judged by: most impressions show it at
roughly 120 px wide, in a sidebar or a phone feed. ``readability`` measures the
finished thumbnail at that width — the headline's height in pixels, its contrast
against what is directly behind it, and a crude saliency proxy for the hero side
— and says which number failed. It does not claim more than it measures: there
is no face detector in this pipeline, so whether an emotion reads at that size is
reported as not measured, never as passed (CLAUDE.md #5).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from PIL import Image, ImageDraw, ImageFilter, ImageStat

from modules.thumbnail_generator import THUMBNAIL_H, THUMBNAIL_W, _load_font

logger = logging.getLogger(__name__)

#: The proven headline treatments. Each is a pure function of the text and the
#: frame, so two runs of the same concept letter identically.
STYLES = ("stroke", "hot_gradient", "neon", "pill", "marker")
DEFAULT_STYLE = "stroke"

#: The width a thumbnail is most often seen at (YouTube's sidebar / up-next rail).
SIDEBAR_W = 120
#: Glyph height of the tallest headline line at SIDEBAR_W, in pixels. Below
#: this the words smear into a bar at sidebar size: 6 px is roughly a 90 px
#: bold capital at 1280 wide.
MIN_TEXT_PX = 6.0
#: WCAG's ratio for large text. A heavy stroke shrinks to half a pixel at
#: sidebar size, so the fill has to stand on the background on its own.
MIN_CONTRAST = 3.0
#: The hero half must carry real structure (a flat or washed-out generation has
#: none) and more edge energy than the side the text sits on.
MIN_HERO_STD = 12.0
MIN_HERO_EDGE_RATIO = 1.0
#: The headline may not sit on the hero: the face or object is the point.
MAX_TEXT_OVER_HERO = 0.10
MAX_HEADLINE_WORDS = 6

_MARGIN = 48
_TOP = 44
_MAX_LINES = 3
_FONT_MAX = 150
_FONT_MIN = 40


# Per style: the glyph fill(s) the contrast check measures (a gradient is judged
# by its weakest stop), and the plate drawn behind the words, if any.
_STYLE_SPEC = {
    "stroke": {"fills": ((255, 255, 255),), "stroke": (0, 0, 0), "plate": None},
    "hot_gradient": {"fills": ((255, 236, 64), (255, 150, 20), (240, 64, 40)),
                     "stroke": (20, 0, 0), "plate": None},
    "neon": {"fills": ((235, 255, 252),), "glow": (0, 235, 255), "stroke": (0, 40, 60), "plate": None},
    "pill": {"fills": ((18, 18, 28),), "stroke": None, "plate": "pill"},
    "marker": {"fills": ((12, 12, 12),), "stroke": None, "plate": "marker"},
}


def normalize_style(value) -> str:
    v = str(value or "").strip().lower()
    return v if v in STYLES else DEFAULT_STYLE


@dataclass
class HeadlineLayout:
    """Where the headline went: one box per line, in 1280x720 pixels."""

    lines: list = field(default_factory=list)
    font_size: int = 0
    boxes: list = field(default_factory=list)       # [(x0, y0, x1, y1), ...] per line, the ink
    line_heights: list = field(default_factory=list)
    style: str = DEFAULT_STYLE
    fills: tuple = ()


def text_region(hero_side: str) -> tuple:
    """The box the headline may use: the side opposite the hero, so the words
    never land on the face or the hero object."""
    if hero_side == "left":
        return (int(THUMBNAIL_W * 0.55), _TOP, THUMBNAIL_W - _MARGIN, THUMBNAIL_H - _MARGIN)
    return (_MARGIN, _TOP, int(THUMBNAIL_W * 0.45), THUMBNAIL_H - _MARGIN)


def hero_region(hero_side: str) -> tuple:
    """The half of the frame the planner put the hero on (a power third plus margin)."""
    if hero_side == "left":
        return (0, 0, int(THUMBNAIL_W * 0.5), THUMBNAIL_H)
    return (int(THUMBNAIL_W * 0.5), 0, THUMBNAIL_W, THUMBNAIL_H)


def _wrap_to_width(draw, words: list, font, max_w: int) -> list:
    lines: list = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if not cur or draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_headline(text: str, region: tuple, *, font_loader=_load_font) -> tuple:
    """``(lines, font_size)``: the largest size at which the words fit the region
    in at most three lines. A headline that only fits below the floor gets the
    floor size anyway, and the readability check is what says it is too small —
    shrinking silently until it fits is how a 2 px headline ships."""
    words = (text or "").split()
    if not words:
        return [], 0
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    max_w = region[2] - region[0]
    max_h = region[3] - region[1]
    for size in range(_FONT_MAX, _FONT_MIN - 1, -6):
        font = font_loader(size)
        lines = _wrap_to_width(probe, words, font, max_w)
        if len(lines) > _MAX_LINES:
            continue
        if any(probe.textlength(ln, font=font) > max_w for ln in lines):
            continue
        if len(lines) * int(size * 1.08) > max_h:
            continue
        return lines, size
    font = font_loader(_FONT_MIN)
    return _wrap_to_width(probe, words, font, max_w)[:_MAX_LINES], _FONT_MIN


def _vignette(img: Image.Image, max_alpha: int = 110) -> Image.Image:
    """A light edge darkening — not frame mode's 45% darken, which would kill the
    saturated background the concept asked for."""
    w, h = img.size
    layer = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(layer)
    steps = min(w, h) // 4
    for i in range(steps):
        d.rectangle([i, i, w - 1 - i, h - 1 - i], outline=int(max_alpha * (1 - i / steps) ** 2))
    black = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(black, img, layer)


def _side_scrim(img: Image.Image, hero_side: str, max_alpha: int = 150) -> Image.Image:
    """Darken the text side, fading out before the hero: unplated styles need a
    calm, dark-ish ground to keep their contrast at sidebar size."""
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    span = int(w * 0.55)
    for x in range(span):
        a = int(max_alpha * (1 - x / span))
        col = x if hero_side != "left" else w - 1 - x
        d.line([(col, 0), (col, h)], fill=a)
    return Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), img, mask)


def _line_boxes(draw, lines, font, region, size) -> tuple:
    boxes, heights = [], []
    x0 = region[0]
    y = region[1]
    step = int(size * 1.08)
    for ln in lines:
        bb = draw.textbbox((x0, y), ln, font=font)
        boxes.append(bb)
        heights.append(bb[3] - bb[1])
        y += step
    return boxes, heights


def _gradient_fill(size: tuple, stops: tuple) -> Image.Image:
    w, h = size
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1) * (len(stops) - 1)
        i = min(int(t), len(stops) - 2)
        f = t - i
        a, b = stops[i], stops[i + 1]
        grad.putpixel((0, y), tuple(int(a[k] + (b[k] - a[k]) * f) for k in range(3)))
    return grad.resize((w, h))


def render_headline(clean: Image.Image, headline: str, *, style: str, hero_side: str,
                    font_loader=_load_font) -> tuple:
    """``(final, ground, layout)``. ``ground`` is the frame exactly as it is just
    before the glyphs go on (vignette, scrim, plates), which is what the contrast
    check measures the words against."""
    style = normalize_style(style)
    spec = _STYLE_SPEC[style]
    img = clean.convert("RGB").resize((THUMBNAIL_W, THUMBNAIL_H), Image.LANCZOS)
    img = _vignette(img)
    text = (headline or "").strip().upper()
    layout = HeadlineLayout(style=style, fills=spec["fills"])
    if not text:
        return img, img.copy(), layout

    region = text_region(hero_side)
    lines, size = fit_headline(text, region, font_loader=font_loader)
    font = font_loader(size)
    draw = ImageDraw.Draw(img)
    boxes, heights = _line_boxes(draw, lines, font, region, size)
    layout.lines, layout.font_size, layout.boxes, layout.line_heights = lines, size, boxes, heights

    if spec["plate"] is None:
        img = _side_scrim(img, hero_side)
    elif spec["plate"] == "pill":
        # Frosted: blur what is behind the block, then a light veil over it.
        pad = max(18, size // 5)
        block = (min(b[0] for b in boxes) - pad, min(b[1] for b in boxes) - pad,
                 max(b[2] for b in boxes) + pad, max(b[3] for b in boxes) + pad)
        block = tuple(int(v) for v in block)
        region_img = img.crop(block).filter(ImageFilter.GaussianBlur(14))
        veil = Image.new("RGB", region_img.size, (250, 250, 252))
        region_img = Image.blend(region_img, veil, 0.82)
        mask = Image.new("L", region_img.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, region_img.size[0] - 1, region_img.size[1] - 1],
                                               radius=pad * 2, fill=255)
        img.paste(region_img, block[:2], mask)
    elif spec["plate"] == "marker":
        d = ImageDraw.Draw(img)
        pad = max(10, size // 9)
        for b in boxes:
            d.rectangle([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], fill=(255, 214, 0))

    ground = img.copy()
    draw = ImageDraw.Draw(img)
    stroke_w = max(4, size // 14)
    y_step = int(size * 1.08)
    if style == "stroke":
        shadow = Image.new("L", img.size, 0)
        sd = ImageDraw.Draw(shadow)
        for i, ln in enumerate(lines):
            sd.text((region[0] + 8, region[1] + i * y_step + 10), ln, font=font, fill=170,
                    stroke_width=stroke_w, stroke_fill=170)
        shadow = shadow.filter(ImageFilter.GaussianBlur(8))
        img = Image.composite(Image.new("RGB", img.size, (0, 0, 0)), img, shadow)
        draw = ImageDraw.Draw(img)
    if style == "neon":
        glow = Image.new("L", img.size, 0)
        gd = ImageDraw.Draw(glow)
        for i, ln in enumerate(lines):
            gd.text((region[0], region[1] + i * y_step), ln, font=font, fill=255,
                    stroke_width=stroke_w * 2, stroke_fill=255)
        glow = glow.filter(ImageFilter.GaussianBlur(14))
        img = Image.composite(Image.new("RGB", img.size, spec["glow"]), img, glow)
        draw = ImageDraw.Draw(img)

    for i, ln in enumerate(lines):
        pos = (region[0], region[1] + i * y_step)
        if style == "hot_gradient":
            draw.text(pos, ln, font=font, fill=spec["stroke"], stroke_width=stroke_w,
                      stroke_fill=spec["stroke"])
            mask = Image.new("L", img.size, 0)
            ImageDraw.Draw(mask).text(pos, ln, font=font, fill=255)
            b = boxes[i]
            fill = Image.new("RGB", img.size, spec["fills"][0])
            fill.paste(_gradient_fill((max(1, b[2] - b[0]), max(1, b[3] - b[1])), spec["fills"]), (b[0], b[1]))
            img = Image.composite(fill, img, mask)
            draw = ImageDraw.Draw(img)
        elif spec["stroke"] is not None:
            draw.text(pos, ln, font=font, fill=spec["fills"][0], stroke_width=stroke_w,
                      stroke_fill=spec["stroke"])
        else:
            draw.text(pos, ln, font=font, fill=spec["fills"][0])
    return img, ground, layout


# -- the sidebar-size check -------------------------------------------------

def _lum(rgb) -> float:
    """WCAG relative luminance of an sRGB colour."""
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb[:3]
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast_ratio(a, b) -> float:
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _scale_box(box, s: float, w: int, h: int) -> tuple:
    x0, y0 = int(box[0] * s), int(box[1] * s)
    x1, y1 = max(x0 + 1, int(round(box[2] * s))), max(y0 + 1, int(round(box[3] * s)))
    return (max(0, x0), max(0, y0), min(w, x1), min(h, y1))


def _mean_rgb(img: Image.Image, box: tuple) -> tuple:
    return tuple(ImageStat.Stat(img.crop(box).convert("RGB")).mean[:3])


def _edge_and_std(gray: Image.Image, box: tuple) -> tuple:
    """Mean absolute neighbour difference (edge energy) and luminance std inside ``box``."""
    data = gray.load()
    vals, edges = [], []
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            v = data[x, y]
            vals.append(v)
            if x + 1 < box[2]:
                edges.append(abs(v - data[x + 1, y]))
            if y + 1 < box[3]:
                edges.append(abs(v - data[x, y + 1]))
    if not vals:
        return 0.0, 0.0
    mean = sum(vals) / len(vals)
    std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
    return (sum(edges) / len(edges) if edges else 0.0), std


def _overlap(a: tuple, b: tuple) -> int:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0, w) * max(0, h)


def readability(final: Image.Image, ground: Image.Image, clean: Image.Image, layout: HeadlineLayout,
                *, hero_side: str, headline: str) -> dict:
    """Measure a finished thumbnail at SIDEBAR_W and say whether it reads.

    Deterministic: the same images give the same numbers. Every failure is named
    with its measurement and its floor, so the run report says *which* thing is
    wrong (``failures``), not only that something is."""
    s = SIDEBAR_W / float(THUMBNAIL_W)
    small_h = max(1, int(round(THUMBNAIL_H * s)))
    size = (SIDEBAR_W, small_h)
    ground_s = ground.convert("RGB").resize(size, Image.LANCZOS)
    clean_s = clean.convert("RGB").resize((THUMBNAIL_W, THUMBNAIL_H), Image.LANCZOS).resize(size, Image.LANCZOS)
    failures: list = []
    report: dict = {"width_px": SIDEBAR_W, "style": layout.style,
                    "emotion": "not measured (no face detector in this pipeline)"}

    words = len((headline or "").split())
    if not words:
        report.update(text="none (the script has no overlay text)", text_px=None, contrast=None)
    else:
        report["headline_words"] = words
        if words > MAX_HEADLINE_WORDS:
            failures.append(f"headline has {words} words (at most {MAX_HEADLINE_WORDS} read at a glance)")
        text_px = round(max(layout.line_heights or [0]) * s, 2)
        report["text_px"] = text_px
        report["min_text_px"] = MIN_TEXT_PX
        if text_px < MIN_TEXT_PX:
            failures.append(f"headline is {text_px} px tall at {SIDEBAR_W} px wide (needs {MIN_TEXT_PX})")
        worst = None
        for box in layout.boxes:
            bg = _mean_rgb(ground_s, _scale_box(box, s, *size))
            for fill in layout.fills:
                r = contrast_ratio(fill, bg)
                worst = r if worst is None else min(worst, r)
        contrast = round(worst, 2) if worst is not None else None
        report["contrast"] = contrast
        report["min_contrast"] = MIN_CONTRAST
        if contrast is None or contrast < MIN_CONTRAST:
            failures.append(f"headline contrast {contrast}:1 against what is behind it (needs {MIN_CONTRAST}:1)")

    hero = hero_region(hero_side)
    hero_s = _scale_box(hero, s, *size)
    other = (0, 0, hero_s[0], size[1]) if hero_side != "left" else (hero_s[2], 0, size[0], size[1])
    gray = clean_s.convert("L")
    hero_edge, hero_std = _edge_and_std(gray, hero_s)
    other_edge, _ = _edge_and_std(gray, other)
    ratio = round(hero_edge / other_edge, 2) if other_edge > 0 else (99.0 if hero_edge > 0 else 0.0)
    report.update(hero_side=hero_side, hero_std=round(hero_std, 2), min_hero_std=MIN_HERO_STD,
                  hero_edge_ratio=ratio, min_hero_edge_ratio=MIN_HERO_EDGE_RATIO)
    if hero_std < MIN_HERO_STD:
        failures.append(f"the hero side is nearly flat at sidebar size (luminance spread {round(hero_std, 2)}, "
                        f"needs {MIN_HERO_STD})")
    if ratio < MIN_HERO_EDGE_RATIO:
        failures.append(f"the hero side carries less detail than the rest of the frame (edge ratio {ratio}, "
                        f"needs {MIN_HERO_EDGE_RATIO})")

    area = max(1, (hero[2] - hero[0]) * (hero[3] - hero[1]))
    covered = round(sum(_overlap(b, hero) for b in layout.boxes) / area, 3)
    report["text_over_hero"] = covered
    if covered > MAX_TEXT_OVER_HERO:
        failures.append(f"the headline covers {covered:.0%} of the hero side (at most {MAX_TEXT_OVER_HERO:.0%})")

    report["failures"] = failures
    report["passed"] = not failures
    return report


def remedy_for(failures: list) -> str:
    """The fix for what failed, in the order a person would try it."""
    text = " ".join(failures)
    fixes = []
    if "words" in text or "px tall" in text:
        fixes.append("shorten the script's thumbnail text (at most 4 words reads best)")
    if "contrast" in text:
        fixes.append("use a plated headline style (pill or marker) or a darker palette on the text side")
    if "hero side" in text or "covers" in text:
        fixes.append("re-run so the planner composes the hero larger on its third with a calmer background")
    if not fixes:
        fixes.append("re-run; if it repeats, set thumbnail_mode back to frame for this channel")
    return "; ".join(fixes)


def sidebar_preview(img: Image.Image) -> Image.Image:
    """The thumbnail as the sidebar shows it — saved beside the full size so a
    person can see what the check saw."""
    return img.convert("RGB").resize((SIDEBAR_W, max(1, int(round(THUMBNAIL_H * SIDEBAR_W / THUMBNAIL_W)))),
                                     Image.LANCZOS)
