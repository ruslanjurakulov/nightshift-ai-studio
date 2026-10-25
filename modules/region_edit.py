"""Region edit: change a few chosen rectangles of one picture and nothing else.

A person draws 1-5 regions over a picture; each has its own name and its own
words. For every region this module cuts a CROP (the region plus some context)
out of the ORIGINAL, asks one existing edit model to change it, resizes the
answer to the crop's size, and pastes back ONLY the region's pixels, with a
short feathered edge, over the original. The pixel lock (``composite_regions``)
is the point of the feature and is independent of any model:

    every pixel outside the regions' masks is the original's pixel, byte for byte,
    whatever the model returned.

Why a crop and not a mask sent to the model
-------------------------------------------
No adapter wired here takes a mask: ``CapabilityRequest`` has no such field and
the edit calls of ``image.openai`` / ``image.gemini`` send pictures and words
only (OpenAI's edits endpoint documents an optional mask; this repository does
not send it, so it is not claimed). The crop does the work instead: the model
sees only the region and its context, so the edit lands there, and the lock
makes sure it can land nowhere else. A future adapter that takes a real mask can
be added behind the same ``edit_fn`` seam without touching the lock.

Exactly what is and is not guaranteed
-------------------------------------
Guaranteed (and checked again before anything is returned, ``verify_pixel_lock``):

* Outside the union of the regions' masks, every channel of every pixel equals
  the original's decoded 8-bit RGB(A) value. The mask is the rectangle, or the
  rectangle intersected with a brush bitmap. The feather band lies INSIDE the
  mask: a pixel on the mask's edge is a blend of original and edit, a pixel
  ``feather`` or more inside is the edit, a pixel outside is the original.
* The alpha channel (if the picture has one) is never taken from the model.
* The model's answer is resized to the crop's size (Lanczos), never the other
  way: the original's size and pixel grid never change.
* Nothing is ever sent to a model other than the one named (no fallback).

Not guaranteed:

* Anything INSIDE the mask: that is the model's pixels (AI-generated), blended
  at the feather band. Nothing here says the edit is good or what it shows.
* Pixel identity in the file's bytes: the result is a new lossless PNG, so a
  JPEG source's pixels are identical after decoding, not the file's bytes. The
  grid is the picture after EXIF orientation is applied (what a browser shows).
* Colour management: pixel values are never converted. The source's embedded
  ICC profile (if any) is copied to the result, and the model's pixels are
  assumed to be in the same space as the crop it was given; that assumption is
  not verified. 16-bit and CMYK sources are refused, not converted.
* Each region is cut from the ORIGINAL, so a later region does not see an
  earlier region's edit; where two regions overlap, the later one is blended
  over the earlier one.

Nothing here calls a network by itself: the model call is the ``edit_fn`` the
caller passes (``adapter_edit_fn`` wraps an existing adapter). Keys never pass
through this module; nothing logs a prompt or a picture.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Collection, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageOps

from modules.capabilities.base import EDIT, SUCCEEDED, AdapterError, CapabilityRequest

#: One region edit changes at most this many rectangles (the owner's limit).
MAX_REGIONS = 5
#: The feather band, in pixels, inside the mask's edge: configurable within this range.
FEATHER_MIN = 2
FEATHER_MAX = 8
DEFAULT_FEATHER = 4
#: A region smaller than this on a side is not an edit anyone can see or a model can use.
MIN_REGION_PX = 16
MAX_NAME_CHARS = 60
MAX_PROMPT_CHARS = 1000
#: Decoded pixels of the source or of a model answer; a larger one is refused
#: before it is decoded (a small file can hide a huge picture).
MAX_PIXELS = 48_000_000
#: A region EDIT (the run step) works on the whole picture several times over (the original, the composite, the lock's masks and the
#: comparison): measured, about 100 MB of RAM per megapixel at 47.6 MP with five large regions (4.9 GB, about 95 s) and about 50 MB per
#: megapixel at 16 MP (0.8 GB, about 23 s). A source of more pixels than this is refused before anything is asked of a model, and costs
#: nothing; the worker and the Command Center's routes use the same number (command-center/lib/regionEdit/geometry.ts).
REGION_MAX_SOURCE_PIXELS = 16_000_000
#: Context around a region in the crop: a quarter of its longer side, at least this many pixels.
CONTEXT_MIN_PX = 32
CONTEXT_FRACTION = 0.25
#: A model answer whose shape differs from the crop's by more than this is refused, never stretched.
SHAPE_TOLERANCE = 0.05

_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]+")
_ASPECT = re.compile(r"^(\d{1,3}):(\d{1,3})$")


class RegionEditError(Exception):
    """A refusal or a failed region. ``code`` is a stable word the app words in
    en / ru / uz; ``message`` is safe to store (never a prompt, key or body)."""

    def __init__(self, code: str, message: str = ""):
        self.code = code
        self.message = (message or code)[:300]
        super().__init__(f"{code}: {self.message}")


# ── regions ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Region:
    """One rectangle in the picture's own pixels (after EXIF orientation).
    ``mask_png`` (optional brush): an image exactly ``w`` x ``h``; a pixel is
    inside where its alpha (or, without alpha, its brightness) is 128 or more."""
    name: str
    prompt: str
    x: int
    y: int
    w: int
    h: int
    mask_png: Optional[bytes] = field(default=None, repr=False)

    @property
    def box(self) -> Tuple[int, int, int, int]:
        return (self.x, self.y, self.x + self.w, self.y + self.h)


def _clean_line(text: object, limit: int) -> str:
    return re.sub(r"\s+", " ", _CTRL.sub(" ", str(text or ""))).strip()[:limit]


def _whole(v: object, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v):
        raise RegionEditError("region_invalid", f"{what} must be a whole number of pixels")
    return int(v)


def check_region(r: object, size: Tuple[int, int], position: int = 1) -> Region:
    """One request region checked against the picture's size: the same strict rules as :func:`parse_regions`, for a caller that
    must judge each region on its own (the run step: a refused region costs nothing and the others still run)."""
    if not isinstance(r, Mapping):
        raise RegionEditError("region_invalid", f"region {position} is not an object")
    width, height = size
    x, y = _whole(r.get("x"), "x"), _whole(r.get("y"), "y")
    w, h = _whole(r.get("w"), "w"), _whole(r.get("h"), "h")
    if w < MIN_REGION_PX or h < MIN_REGION_PX:
        raise RegionEditError("region_too_small", f"region {position} is smaller than {MIN_REGION_PX} px")
    if x < 0 or y < 0 or x + w > width or y + h > height:
        raise RegionEditError("region_out_of_bounds", f"region {position} is not inside the picture")
    mask = r.get("mask_png")
    if mask is not None and not isinstance(mask, (bytes, bytearray)):
        raise RegionEditError("mask_invalid", f"region {position}: the brush mask is not an image")
    return Region(name=_clean_line(r.get("name"), MAX_NAME_CHARS) or f"Region {position}",
                  prompt=_clean_line(r.get("prompt"), MAX_PROMPT_CHARS),
                  x=x, y=y, w=w, h=h, mask_png=bytes(mask) if mask is not None else None)


def parse_regions(raw: object, size: Tuple[int, int]) -> List[Region]:
    """The request's regions, checked against the picture's size. Strict: a
    rectangle outside the picture is REFUSED, never clamped (the browser clamps
    what the person draws; the server does not guess what they meant)."""
    if not isinstance(raw, (list, tuple)) or not raw:
        raise RegionEditError("no_regions", "draw at least one region")
    if len(raw) > MAX_REGIONS:
        raise RegionEditError("too_many_regions", f"at most {MAX_REGIONS} regions")
    return [check_region(r, size, i) for i, r in enumerate(raw, start=1)]


def active_regions(regions: Sequence[Region]) -> List[Tuple[int, Region]]:
    """The regions that will be edited (they have words), with their positions.
    The others are skipped and said so; none left is a refusal (nothing to run,
    nothing to price, nothing to charge)."""
    chosen = [(i, r) for i, r in enumerate(regions) if r.prompt]
    if not chosen:
        raise RegionEditError("no_prompt", "no region has words to edit it with")
    return chosen


def check_feather(feather: object) -> int:
    if isinstance(feather, bool) or not isinstance(feather, int) or not FEATHER_MIN <= feather <= FEATHER_MAX:
        raise RegionEditError("feather_invalid", f"the feather is a whole number from {FEATHER_MIN} to {FEATHER_MAX} px")
    return feather


# ── the model: explicit, never a fallback ─────────────────────────────────────

def resolve_edit_model(model_id: object, *, available: Collection[str], registry: Mapping[str, object]):
    """The registry entry of the ONE model asked for, or a refusal. There is no
    default and no second choice (CLAUDE.md rule 4): a model that is unknown,
    cannot edit pictures, is behind a terms gate or is not currently available
    to sell stops the run. ``available`` is what the database says is sellable
    (migration 0035: probed, priced, no open gate); this module never guesses it."""
    mid = str(model_id or "").strip().lower()
    if not mid:
        raise RegionEditError("model_required", "name the model; there is no default")
    entry = registry.get(mid)
    if entry is None:
        raise RegionEditError("model_unknown", "that model is not in the registry")
    if EDIT not in getattr(entry, "capabilities", ()):
        raise RegionEditError("model_cannot_edit", "that model does not edit pictures")
    if getattr(entry, "terms_gate", None):
        raise RegionEditError("model_gated", "that model's vendor terms are not cleared")
    if mid not in set(available):
        raise RegionEditError("model_not_available", "that model is not available to run right now")
    return entry


# ── geometry: the crop that goes to the model ─────────────────────────────────

@dataclass(frozen=True)
class CropPlan:
    box: Tuple[int, int, int, int]
    #: The model's aspect ratio the box has, "w:h"; None when the model lists none.
    aspect: Optional[str]

    @property
    def size(self) -> Tuple[int, int]:
        return (self.box[2] - self.box[0], self.box[3] - self.box[1])


def _aspect_value(text: str) -> float:
    m = _ASPECT.match(text or "")
    if not m or int(m.group(1)) == 0 or int(m.group(2)) == 0:
        raise RegionEditError("crop_unavailable", f"{text!r} is not an aspect ratio")
    return int(m.group(1)) / int(m.group(2))


def plan_crop(region: Region, size: Tuple[int, int], aspects: Sequence[str]) -> CropPlan:
    """The crop box for a region: the rectangle plus context, grown to the shape
    of the nearest aspect ratio the model offers so the answer comes back in the
    crop's own shape and is never stretched. The smallest feasible box wins; if
    the picture is too small for any offered shape the run is refused."""
    width, height = size
    x0, y0, x1, y1 = region.box
    pad = max(CONTEXT_MIN_PX, round(max(region.w, region.h) * CONTEXT_FRACTION))
    want_w, want_h = region.w + 2 * pad, region.h + 2 * pad
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    options: List[Tuple[int, float, str, Tuple[int, int, int, int]]] = []
    for label in (list(aspects) or [None]):
        bw, bh = want_w, want_h
        if label is not None:
            a = _aspect_value(label)
            if bw / bh < a:
                bw = int(np.ceil(bh * a))
            else:
                bh = int(np.ceil(bw / a))
        bw, bh = min(bw, width), min(bh, height)
        if label is not None:
            # Clamping to the picture can break the shape; then this one is not feasible.
            if abs(bw / bh - _aspect_value(label)) / _aspect_value(label) > 0.02:
                continue
        left = int(round(cx - bw / 2))
        top = int(round(cy - bh / 2))
        left = max(0, min(left, width - bw))
        top = max(0, min(top, height - bh))
        box = (left, top, left + bw, top + bh)
        if box[0] > x0 or box[1] > y0 or box[2] < x1 or box[3] < y1:
            continue
        options.append((bw * bh, abs(bw / bh - region.w / region.h), label or "", box))
    if not options:
        raise RegionEditError("crop_unavailable", "the picture is too small for any shape this model takes")
    _, _, label, box = min(options)
    return CropPlan(box=box, aspect=label or None)


# ── pixels ────────────────────────────────────────────────────────────────────

def load_rgba(data: bytes) -> Tuple[np.ndarray, bool, Optional[bytes]]:
    """Decode a picture to an 8-bit RGBA array on the EXIF-oriented grid.
    Returns (array, had_alpha, icc_profile). Refuses what it cannot represent
    without changing values (16-bit, CMYK) and what is too large to decode."""
    try:
        im = Image.open(io.BytesIO(data))
        w, h = im.size
        if w * h > MAX_PIXELS:
            raise RegionEditError("source_too_large", "the picture has too many pixels")
        if im.mode in ("I;16", "I;16L", "I;16B", "I", "F", "CMYK", "YCbCr", "LAB", "HSV"):
            raise RegionEditError("source_unsupported", f"{im.mode} pictures are not edited here")
        icc = im.info.get("icc_profile") if isinstance(im.info.get("icc_profile"), bytes) else None
        im = ImageOps.exif_transpose(im)
        had_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
        arr = np.array(im.convert("RGBA"), dtype=np.uint8)
    except RegionEditError:
        raise
    except Exception:  # noqa: BLE001 — a truncated file, a bomb, a non-image: all "not a picture"
        raise RegionEditError("source_unreadable", "the picture could not be read") from None
    return arr, had_alpha, icc


def inspect_source(data: bytes) -> Tuple[int, int]:
    """The (width, height) of a source picture WITHOUT decoding its pixels, or the refusal: not a picture, a mode that cannot be edited
    without changing values, more than ``MAX_PIXELS`` (never decoded) or more than ``REGION_MAX_SOURCE_PIXELS`` (the run step's own
    ceiling, see there). The grid after EXIF orientation has the same pixel count."""
    try:
        im = Image.open(io.BytesIO(data))
        w, h = im.size
        mode = im.mode
    except Exception:  # noqa: BLE001 — a truncated file, a bomb, a non-image: all "not a picture"
        raise RegionEditError("source_unreadable", "the picture could not be read") from None
    if w * h > MAX_PIXELS or w * h > REGION_MAX_SOURCE_PIXELS:
        raise RegionEditError("source_too_large", f"the picture has more than {REGION_MAX_SOURCE_PIXELS // 1_000_000} megapixels")
    if mode in ("I;16", "I;16L", "I;16B", "I", "F", "CMYK", "YCbCr", "LAB", "HSV"):
        raise RegionEditError("source_unsupported", f"{mode} pictures are not edited here")
    return w, h


def _brush(region: Region) -> np.ndarray:
    """The brush bitmap as booleans of exactly the region's size."""
    try:
        im = Image.open(io.BytesIO(region.mask_png or b""))
        if im.size != (region.w, region.h):
            raise RegionEditError("mask_invalid", "the brush mask is not the region's size")
        chan = im.convert("RGBA").getchannel("A") if im.mode in ("RGBA", "LA", "PA") else im.convert("L")
        inside = np.array(chan, dtype=np.uint8) >= 128
    except RegionEditError:
        raise
    except Exception:  # noqa: BLE001
        raise RegionEditError("mask_invalid", "the brush mask could not be read") from None
    if not inside.any():
        raise RegionEditError("mask_invalid", "the brush mask is empty")
    return inside


def _erode(m: np.ndarray) -> np.ndarray:
    """One 3x3 erosion; the array's own border is left alone (the caller pads)."""
    o = m.copy()
    o[1:, :] &= m[:-1, :]
    o[:-1, :] &= m[1:, :]
    o[:, 1:] &= m[:, :-1]
    o[:, :-1] &= m[:, 1:]
    o[1:, 1:] &= m[:-1, :-1]
    o[1:, :-1] &= m[:-1, 1:]
    o[:-1, 1:] &= m[1:, :-1]
    o[:-1, :-1] &= m[1:, 1:]
    return o


def region_alpha(region: Region, size: Tuple[int, int], feather: int) -> np.ndarray:
    """The region's blend weights, uint8, shaped (h, w) like its rectangle.

    0 outside the mask (the array is the rectangle, so everything outside it is
    not in the array at all), and inside it 255 * (min(depth, feather) + 1) /
    (feather + 1) where depth is 0 on the mask's outermost pixels: a linear ramp
    that reaches 255 ``feather`` pixels in. A side of the mask that lies on the
    picture's own edge does not ramp (there is no original beyond it to blend)."""
    feather = check_feather(feather)
    inside = _brush(region) if region.mask_png is not None else np.ones((region.h, region.w), dtype=bool)
    x0, y0, x1, y1 = region.box
    f = feather + 1
    p = np.pad(inside, f, mode="constant", constant_values=False)
    if y0 == 0:
        p[:f, :] = p[f:f + 1, :]
    if y1 == size[1]:
        p[-f:, :] = p[-f - 1:-f, :]
    if x0 == 0:
        p[:, :f] = p[:, f:f + 1]
    if x1 == size[0]:
        p[:, -f:] = p[:, -f - 1:-f]
    count = p.astype(np.int32)
    level = p
    for _ in range(feather):
        level = _erode(level)
        count += level
    count = count[f:-f, f:-f]
    alpha = (count * 255 + f // 2) // f          # count is 0 outside the mask, 1..feather+1 inside it
    alpha[~inside] = 0
    return alpha.astype(np.uint8)


def outside_mask(shape: Tuple[int, int], regions: Sequence[Region], feather: int) -> np.ndarray:
    """Booleans (h, w): True where a pixel is OUTSIDE every region's mask, i.e.
    where the lock promises the original's value. A pixel whose weight is 0 is
    outside; the feather band's pixels (weight > 0) are inside the mask."""
    keep = np.ones(shape, dtype=bool)
    for r in regions:
        a = region_alpha(r, (shape[1], shape[0]), feather)
        keep[r.y:r.y + r.h, r.x:r.x + r.w] &= a == 0
    return keep


def _resize(im: Image.Image, size: Tuple[int, int]) -> Image.Image:
    """Explicit resize of a model answer to the crop's size. The original is
    never resized."""
    return im if im.size == size else im.resize(size, Image.Resampling.LANCZOS)


def composite_regions(original: np.ndarray, edits: Sequence[Tuple[Region, np.ndarray, Tuple[int, int, int, int]]],
                      feather: int) -> np.ndarray:
    """THE PIXEL LOCK. ``original`` is the (H, W, 4) uint8 source; each edit is
    (region, edited RGBA/RGB array already at its crop's size, crop box). Returns
    a new array: the original with only each region's masked pixels blended in.
    Nothing outside a mask is ever read from an edit, so a model that returns a
    completely different picture changes nothing outside the masks."""
    out = original.copy()
    height, width = original.shape[:2]
    for region, edited, box in edits:
        cx0, cy0, cx1, cy1 = box
        if edited.shape[0] != cy1 - cy0 or edited.shape[1] != cx1 - cx0:
            raise RegionEditError("bad_response", "the edit is not the crop's size")
        alpha = region_alpha(region, (width, height), feather).astype(np.int32)[..., None]
        ry0, rx0 = region.y - cy0, region.x - cx0
        patch = edited[ry0:ry0 + region.h, rx0:rx0 + region.w, :3].astype(np.int32)
        base = out[region.y:region.y + region.h, region.x:region.x + region.w, :3].astype(np.int32)
        # (o * (255 - a) + e * a + 127) // 255 is exactly o at a = 0 and exactly e at a = 255.
        mixed = (base * (255 - alpha) + patch * alpha + 127) // 255
        out[region.y:region.y + region.h, region.x:region.x + region.w, :3] = mixed.astype(np.uint8)
    return out


def verify_pixel_lock(original: np.ndarray, result: np.ndarray, regions: Sequence[Region], feather: int) -> None:
    """Re-check the guarantee on the finished picture, independent of how it was
    built: same size, and every pixel outside the masks (all four channels)
    identical to the original; the alpha channel identical everywhere. Raises
    ``pixel_lock_failed`` rather than let a violating picture out."""
    if original.shape != result.shape:
        raise RegionEditError("pixel_lock_failed", "the result is not the original's size")
    keep = outside_mask(original.shape[:2], regions, feather)
    if not np.array_equal(original[keep], result[keep]):
        raise RegionEditError("pixel_lock_failed", "a pixel outside the masks changed")
    if not np.array_equal(original[..., 3], result[..., 3]):
        raise RegionEditError("pixel_lock_failed", "the alpha channel changed")


def encode_png(arr: np.ndarray, had_alpha: bool, icc: Optional[bytes]) -> bytes:
    """The result as a lossless PNG: RGBA only if the source had alpha, the
    source's ICC profile copied (never converted)."""
    im = Image.fromarray(arr if had_alpha else arr[..., :3])
    buf = io.BytesIO()
    extra = {"icc_profile": icc} if icc else {}
    im.save(buf, format="PNG", **extra)
    return buf.getvalue()


# ── running it ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EditCall:
    """What the model is asked for one region: the crop (PNG bytes), its size,
    the aspect ratio it was shaped to, and the person's words for it."""
    index: int
    name: str
    prompt: str
    crop_png: bytes = field(repr=False)
    size: Tuple[int, int]
    aspect: Optional[str]


EditFn = Callable[[EditCall], bytes]


@dataclass(frozen=True)
class RegionOutcome:
    index: int
    name: str
    #: "applied" | "failed" | "refused" (judged invalid before any call, by ``run_job_regions``) | "skipped" (no words: not run, not priced, not charged)
    status: str
    code: Optional[str] = None
    message: Optional[str] = None
    crop_box: Optional[Tuple[int, int, int, int]] = None


@dataclass
class RegionEditResult:
    #: The finished picture (PNG) when at least one region was applied; None otherwise.
    png: Optional[bytes]
    outcomes: List[RegionOutcome]
    width: int
    height: int
    feather: int

    @property
    def applied(self) -> int:
        return sum(1 for o in self.outcomes if o.status == "applied")

    @property
    def failed(self) -> int:
        return sum(1 for o in self.outcomes if o.status == "failed")


def _answer_array(data: bytes, crop: CropPlan) -> np.ndarray:
    """A model's answer as RGBA at the crop's size, or the refusal. Its shape
    must be the crop's within SHAPE_TOLERANCE: a different shape is refused,
    never stretched."""
    try:
        im = Image.open(io.BytesIO(data))
        if im.size[0] * im.size[1] > MAX_PIXELS:
            raise RegionEditError("bad_response", "the model's answer has too many pixels")
        if im.size[0] < 16 or im.size[1] < 16:
            raise RegionEditError("bad_response", "the model's answer is too small to be the picture")
        want = crop.size[0] / crop.size[1]
        if abs(im.size[0] / im.size[1] - want) / want > SHAPE_TOLERANCE:
            raise RegionEditError("bad_response", "the model returned another shape than the crop")
        im = _resize(im.convert("RGBA"), crop.size)
        return np.array(im, dtype=np.uint8)
    except RegionEditError:
        raise
    except Exception:  # noqa: BLE001
        raise RegionEditError("bad_response", "the model's answer is not a readable picture") from None


def run_region_edit(source: bytes, regions: Sequence[Region], edit_fn: EditFn, *, aspects: Sequence[str] = (),
                    feather: int = DEFAULT_FEATHER) -> RegionEditResult:
    """Edit each region that has words, ONE call per region, in order (every
    adapter wired here takes one prompt per call, so there is no batching), and
    return the original with only those regions' masks replaced.

    A region whose call fails or whose answer is unusable is ``failed`` and
    leaves the picture untouched there; the others still apply. ``edit_fn``
    errors that are not ``AdapterError`` / ``RegionEditError`` are bugs and
    propagate. If no region applied, ``png`` is None: there is nothing to keep."""
    feather = check_feather(feather)
    arr, had_alpha, icc = load_rgba(source)
    height, width = arr.shape[:2]
    parse_regions([{"x": r.x, "y": r.y, "w": r.w, "h": r.h} for r in regions], (width, height))
    active_regions(regions)
    return _run_loaded(arr, had_alpha, icc, list(regions), {}, edit_fn, aspects, feather)


def run_job_regions(source: bytes, wire: Sequence[Mapping], edit_fn: EditFn, *, aspects: Sequence[str] = (),
                    feather: int = DEFAULT_FEATHER) -> RegionEditResult:
    """The run step's entry: the job's regions as stored (``x y w h name prompt``), each judged ON ITS OWN against the real picture.

    A region that is out of the picture, too small or otherwise not valid is ``refused`` (no model is asked) and the others still run;
    nothing here clamps. Every region of ``wire`` gets exactly one outcome, in order, and no region is ever sent to a second model.
    Unlike :func:`run_region_edit` it does not raise when no region can run: it returns outcomes that say why."""
    feather = check_feather(feather)
    inspect_source(source)           # the run step's pixel ceiling, before a single pixel is decoded
    arr, had_alpha, icc = load_rgba(source)
    height, width = arr.shape[:2]
    regions: List[Optional[Region]] = []
    refused: dict = {}
    for i, raw in enumerate(wire):
        try:
            regions.append(check_region(raw, (width, height), i + 1))
        except RegionEditError as e:
            regions.append(None)
            refused[i] = e
    return _run_loaded(arr, had_alpha, icc, regions, refused, edit_fn, aspects, feather)


def _run_loaded(arr: np.ndarray, had_alpha: bool, icc: Optional[bytes], regions: Sequence[Optional[Region]],
                refused: Mapping[int, RegionEditError], edit_fn: EditFn, aspects: Sequence[str],
                feather: int) -> RegionEditResult:
    height, width = arr.shape[:2]
    outcomes: List[RegionOutcome] = []
    edits: List[Tuple[Region, np.ndarray, Tuple[int, int, int, int]]] = []
    applied_regions: List[Region] = []
    applied_index: List[int] = []
    for i, region in enumerate(regions):
        if region is None:
            err = refused[i]
            outcomes.append(RegionOutcome(i, f"Region {i + 1}", "refused", err.code, err.message))
            continue
        if not region.prompt:
            outcomes.append(RegionOutcome(i, region.name, "skipped", "no_prompt", "no words for this region"))
            continue
        try:
            if region.mask_png is not None:
                _brush(region)          # refuse a bad brush before any call
            crop = plan_crop(region, (width, height), aspects)
            piece = Image.fromarray(arr[crop.box[1]:crop.box[3], crop.box[0]:crop.box[2], :3 if not had_alpha else 4])
            buf = io.BytesIO()
            piece.save(buf, format="PNG")
            answer = edit_fn(EditCall(i, region.name, region.prompt, buf.getvalue(), crop.size, crop.aspect))
            edited = _answer_array(answer, crop)
        except (AdapterError, RegionEditError) as e:
            outcomes.append(RegionOutcome(i, region.name, "failed", getattr(e, "code", "failed"),
                                          getattr(e, "message", str(e))[:300]))
            continue
        edits.append((region, edited, crop.box))
        applied_regions.append(region)
        applied_index.append(len(outcomes))
        outcomes.append(RegionOutcome(i, region.name, "applied", crop_box=crop.box))
    if not edits:
        return RegionEditResult(None, outcomes, width, height, feather)
    result = composite_regions(arr, edits, feather)
    try:
        verify_pixel_lock(arr, result, applied_regions, feather)
    except RegionEditError:
        # The finished picture broke the lock. Say WHICH region did, so that one alone is failed (not charged) and the others stand:
        # each applied region is composited and verified on its own, and only the ones that pass are kept.
        kept = []
        for (region, edited, box), index in zip(edits, applied_index):
            try:
                verify_pixel_lock(arr, composite_regions(arr, [(region, edited, box)], feather), [region], feather)
            except RegionEditError:
                outcomes[index] = RegionOutcome(index, region.name, "failed", "pixel_lock_failed",
                                                "a pixel outside the region would have changed")
                continue
            kept.append((region, edited, box))
        if not kept:
            return RegionEditResult(None, outcomes, width, height, feather)
        result = composite_regions(arr, kept, feather)
        try:
            verify_pixel_lock(arr, result, [k[0] for k in kept], feather)
        except RegionEditError:
            # Each passes alone and the whole does not: nothing about this picture can be trusted.
            for (region, _e, _b), index in zip(edits, applied_index):
                outcomes[index] = RegionOutcome(index, region.name, "failed", "pixel_lock_failed",
                                                "the finished picture did not keep the original outside the regions")
            return RegionEditResult(None, outcomes, width, height, feather)
    return RegionEditResult(encode_png(result, had_alpha, icc), outcomes, width, height, feather)


def adapter_edit_fn(adapter, entry, *, work_dir: Path, quality: Optional[str] = None,
                    end_user: Optional[str] = None) -> EditFn:
    """An ``edit_fn`` over an existing, already-integrated edit adapter: the crop
    goes as the one input picture of the model's ordinary edit call. The request
    is checked by the adapter and the registry entry first (a refusal is free),
    and the model that answers is exactly ``entry`` (no second choice). Network
    and key handling stay inside the adapter."""
    work_dir = Path(work_dir)

    def call(c: EditCall) -> bytes:
        work_dir.mkdir(parents=True, exist_ok=True)
        path = work_dir / f"region_{c.index}.png"
        path.write_bytes(c.crop_png)
        words = ("Change this picture as described and keep everything the words do not mention as it is. "
                 f"Described change: {c.prompt}")
        request = CapabilityRequest(capability=EDIT, prompt=words, aspect_ratio=c.aspect, quality=quality,
                                    end_user=end_user, input_images=(str(path),))
        problems = adapter.problems(request, entry)
        if problems:
            raise RegionEditError("bad_request", "; ".join(problems)[:300])
        task = adapter.submit(request, entry.vendor_model_for(EDIT))
        done = adapter.poll(task)
        if done.state != SUCCEEDED or not done.outputs:
            raise RegionEditError("bad_response", "the model returned no picture")
        files = adapter.fetch(done, work_dir, stem=f"answer_{c.index}")
        return Path(files[0]).read_bytes()

    return call


def provenance(result: RegionEditResult, regions: Sequence[Region], *, model_id: str,
               source_asset_id: Optional[str]) -> dict:
    """What a library asset made from this result records (media_assets.provenance):
    that its region pixels are AI-generated, by which model, from which source and
    where. The person's words are not kept here."""
    applied = {o.index for o in result.outcomes if o.status == "applied"}
    return {
        "capability": "edit", "model": model_id, "rights": "generated_for_org", "ai_generated": True,
        **({"source_asset_id": source_asset_id} if source_asset_id else {}),
        "region_edit": {
            "pixel_lock": "outside_mask_identical", "feather_px": result.feather,
            "regions": [{"name": regions[i].name, "x": regions[i].x, "y": regions[i].y,
                         "w": regions[i].w, "h": regions[i].h, "brush": regions[i].mask_png is not None}
                        for i in sorted(applied)],
        },
    }
