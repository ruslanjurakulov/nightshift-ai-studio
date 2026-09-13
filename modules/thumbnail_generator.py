"""A/B Thumbnail Generator — Pillow-based, cinematic style with shock text overlay."""

import logging
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

from config import OUTPUT_DIR

logger = logging.getLogger(__name__)

THUMBNAIL_W = 1280
THUMBNAIL_H = 720

# Tried in order. A Linux-only path used to be the sole candidate, so on the
# Windows target every truetype load failed and the bitmap fallback rendered
# the 120px shock text at roughly 11px — unreadable, and silent about it.
FONT_CANDIDATES = (
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/impact.ttf",
    "C:/Windows/Fonts/seguibl.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)

_warned_fallback = False


def _load_font(size: int):
    global _warned_fallback
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    if not _warned_fallback:
        _warned_fallback = True
        logger.warning(
            "No scalable font found — thumbnail text will render at bitmap size. "
            "Tried: %s", ", ".join(FONT_CANDIDATES),
        )
    return ImageFont.load_default()


def _darken_and_vignette(img: Image.Image) -> Image.Image:
    """Apply cinematic dark overlay + vignette."""
    img = img.convert("RGBA")
    img = ImageEnhance.Brightness(img).enhance(0.55)
    img = ImageEnhance.Contrast(img).enhance(1.3)

    # Vignette
    vignette = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(vignette)
    w, h = img.size
    for i in range(min(w, h) // 3):
        alpha = int(200 * (i / (min(w, h) // 3)) ** 2)
        draw.rectangle(
            [i, i, w - i, h - i],
            outline=(0, 0, 0, max(0, 200 - alpha)),
        )
    img = Image.alpha_composite(img, vignette)
    return img.convert("RGB")


# -- pure layout helpers (unit-tested without rendering) --------------------

def wrap_capped(text: str, width: int, max_lines: int) -> list[str]:
    """Wrap `text` to `width` characters and cap at `max_lines`, ending the last
    kept line with an ellipsis when text was dropped. Keeps big overlay text from
    spilling off the canvas — an overflowing thumbnail is worse than a trimmed
    one. Empty/blank in → []."""
    text = (text or "").strip()
    if not text:
        return []
    lines = textwrap.wrap(text, width=max(1, width)) or []
    if len(lines) <= max_lines:
        return lines
    kept = lines[:max_lines]
    kept[-1] = (kept[-1].rstrip(" .") + "…")[: max(1, width + 1)]
    return kept


def scrim_alpha(y: int, top_y: int, height: int, max_alpha: int = 210) -> int:
    """Alpha for a bottom-anchored gradient scrim at row `y`: 0 above `top_y`,
    ramping to `max_alpha` at the bottom. A scrim guarantees the caption reads on
    ANY stock photo, bright or busy — the difference between a designed thumbnail
    and text floating on noise. Clamped to 0..255."""
    if height <= top_y or y <= top_y:
        return 0
    frac = (y - top_y) / float(height - top_y)
    return max(0, min(255, int(max(0, min(1.0, frac)) * max_alpha)))


def _apply_bottom_scrim(img: Image.Image, top_frac: float = 0.52, max_alpha: int = 210) -> Image.Image:
    """Composite a transparent-to-dark vertical gradient over the lower part of
    the image, so bottom-anchored text always has contrast."""
    img = img.convert("RGBA")
    w, h = img.size
    top_y = int(h * top_frac)
    scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(scrim)
    for y in range(top_y, h):
        sdraw.line([(0, y), (w, y)], fill=(0, 0, 0, scrim_alpha(y, top_y, h, max_alpha)))
    return Image.alpha_composite(img, scrim).convert("RGB")


def _accent_bar(img: Image.Image, color: tuple, width_px: int = 18) -> Image.Image:
    """A solid left accent bar — a small designed element that lifts the frame
    above bare text-over-photo and gives the channel a consistent signature."""
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width_px, img.size[1]], fill=color)
    return img


def _draw_text_with_stroke(
    draw: ImageDraw.ImageDraw,
    text: str,
    position: tuple[int, int],
    font: ImageFont.FreeTypeFont,
    fill: str | tuple,
    stroke_fill: str | tuple,
    stroke_width: int = 4,
):
    x, y = position
    for dx in range(-stroke_width, stroke_width + 1):
        for dy in range(-stroke_width, stroke_width + 1):
            if dx != 0 or dy != 0:
                draw.text((x + dx, y + dy), text, font=font, fill=stroke_fill)
    draw.text((x, y), text, font=font, fill=fill)


# Per-variant look, so widening the A/B test past two arms (modules/ab_testing.py)
# gives each thumbnail a genuinely different treatment rather than a clone of B.
# A and B keep exactly the styling they had; C+ are distinct. An unknown label
# falls back deterministically to one of these by position, never crashing.
_VARIANT_STYLE = {
    "A": {"bg": (20, 10, 40), "accent": (255, 215, 0), "shock_size": 120, "shock_color": "#FFD700"},
    "B": {"bg": (10, 30, 20), "accent": (255, 68, 68), "shock_size": 110, "shock_color": "#FF4444"},
    "C": {"bg": (10, 20, 40), "accent": (56, 189, 248), "shock_size": 116, "shock_color": "#38BDF8"},
    "D": {"bg": (35, 15, 15), "accent": (52, 211, 153), "shock_size": 114, "shock_color": "#34D399"},
}
_VARIANT_ORDER = ("A", "B", "C", "D")


def _style_for(variant: str) -> dict:
    key = (variant or "A").strip().upper()
    if key in _VARIANT_STYLE:
        return _VARIANT_STYLE[key]
    # Deterministic fallback for any other label: map it onto one of the known
    # styles by its first character, so it is stable and never a KeyError.
    idx = (ord(key[0]) if key else 0) % len(_VARIANT_ORDER)
    return _VARIANT_STYLE[_VARIANT_ORDER[idx]]


def _make_thumbnail(
    background_path: Path | None,
    overlay_text: str,
    topic: str,
    out_path: Path,
    variant: str = "A",
) -> Path:
    if background_path and background_path.exists():
        img = Image.open(background_path).convert("RGB")
        img = img.resize((THUMBNAIL_W, THUMBNAIL_H), Image.LANCZOS)
    else:
        img = Image.new("RGB", (THUMBNAIL_W, THUMBNAIL_H), _style_for(variant)["bg"])

    img = _darken_and_vignette(img)
    # A bottom gradient scrim so the topic caption always reads on any photo, and
    # a left accent bar for a designed, on-brand frame (raises the thumbnail above
    # plain text-over-stock). Both are cheap composites over the existing image.
    img = _apply_bottom_scrim(img)
    style = _style_for(variant)
    img = _accent_bar(img, style["accent"])
    draw = ImageDraw.Draw(img)

    # Overlay shock text (top, large, yellow/red). Capped to 3 lines so a long
    # phrase can never spill off the canvas.
    shock_font_size = style["shock_size"]
    shock_font = _load_font(shock_font_size)
    shock_color = style["shock_color"]

    shock_lines = wrap_capped(overlay_text.upper(), width=12, max_lines=3)
    shock_y = 40
    for line in shock_lines:
        bbox = draw.textbbox((0, 0), line, font=shock_font)
        lw = bbox[2] - bbox[0]
        _draw_text_with_stroke(
            draw,
            line,
            ((THUMBNAIL_W - lw) // 2, shock_y),
            shock_font,
            fill=shock_color,
            stroke_fill=(0, 0, 0),
            stroke_width=6,
        )
        shock_y += shock_font_size + 10

    # Topic subtitle (bottom), capped to 2 lines and sitting on the scrim.
    topic_font = _load_font(42)
    topic_lines = wrap_capped(topic, width=40, max_lines=2)
    topic_y = THUMBNAIL_H - 40 - len(topic_lines) * 52
    for line in topic_lines:
        bbox = draw.textbbox((0, 0), line, font=topic_font)
        lw = bbox[2] - bbox[0]
        _draw_text_with_stroke(
            draw,
            line,
            ((THUMBNAIL_W - lw) // 2, topic_y),
            topic_font,
            fill="white",
            stroke_fill=(0, 0, 0),
            stroke_width=3,
        )
        topic_y += 52

    img.save(out_path, "JPEG", quality=95)
    logger.info("Thumbnail %s saved: %s", variant, out_path)
    return out_path


class ThumbnailGenerator:
    def __init__(self, topic_slug: str):
        self.slug = topic_slug
        self.out_dir = OUTPUT_DIR / topic_slug / "thumbnails"
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def generate(
        self,
        topic: str,
        overlay_text: str,
        background_a: Path | None = None,
        background_b: Path | None = None,
    ) -> tuple[Path, Path]:
        """Returns (thumbnail_a_path, thumbnail_b_path)."""
        path_a = _make_thumbnail(background_a, overlay_text, topic, self.out_dir / "thumbnail_a.jpg", "A")
        path_b = _make_thumbnail(background_b, overlay_text, topic, self.out_dir / "thumbnail_b.jpg", "B")
        return path_a, path_b

    def generate_variants(
        self,
        topic: str,
        overlay_text: str,
        variants: "list[str] | tuple[str, ...]" = ("A", "B"),
        backgrounds: "list[Path | None] | None" = None,
    ) -> dict:
        """Render one thumbnail per variant and return {variant: path}.

        Widening the A/B test past two arms (roadmap #58): each variant gets its
        own distinct look via `_style_for`, and its own background when one is
        supplied at that position (`backgrounds` is index-aligned to `variants`;
        a missing/short entry falls back to the variant's solid style bg, exactly
        as A/B did). Two arms with the default `("A", "B")` reproduces `generate`.
        """
        backgrounds = list(backgrounds or [])
        out: dict = {}
        for i, variant in enumerate(variants):
            label = str(variant).strip().upper() or "A"
            bg = backgrounds[i] if i < len(backgrounds) else None
            out[label] = _make_thumbnail(
                bg, overlay_text, topic, self.out_dir / f"thumbnail_{label.lower()}.jpg", label
            )
        return out
