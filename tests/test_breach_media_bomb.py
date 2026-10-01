"""BR-C-001 — a raster image can carry a decompression bomb past ingest.

modules/media_library.interpret_probe caps each SIDE of an uploaded image at
MAX_SIDE (16384 px) but never caps the TOTAL pixel count. The HEIC path
(decode_heic) deliberately enforces ``w * h <= MAX_PIXELS`` (100 MP); the
JPEG/PNG/WebP/GIF path does not. A 16384x16384 PNG is 268 MP — it passes
validation, and the media worker then runs ``thumbnail_command`` (ffmpeg,
png_pipe/jpeg_pipe) which decodes the full bitmap (~1 GB for RGBA at 268 MP).
A solid-colour PNG at that size compresses to well under the declared upload
size, so ``copy_and_hash``'s size cap does not help.

That is a resource-exhaustion DoS against the single-threaded media worker,
reachable by any member who can upload a file. The expected secure behaviour
is the same MAX_PIXELS cap the HEIC path already enforces.

Fixed: interpret_probe now refuses a JPEG/PNG/WebP/GIF above MAX_PIXELS with
the same "too_large_dimensions" reason the HEIC path uses. The tests below pin
the bomb, the exact boundary and every raster type.
"""

from __future__ import annotations

import pytest

from modules import media_library as ml


def _img_probe(width: int, height: int) -> dict:
    return {"streams": [{"codec_type": "video", "width": width, "height": height}], "format": {}}


def test_normal_image_is_accepted():
    """A control: a sane picture goes through, so the bomb test below is
    measuring the pixel cap, not a blanket rejection."""
    p = ml.interpret_probe("image/png", _img_probe(1920, 1080))
    assert (p.kind, p.width, p.height) == ("image", 1920, 1080)


def test_image_wider_than_max_side_is_already_refused():
    """A control: the existing per-side cap works — the gap is total pixels."""
    with pytest.raises(ml.IngestReject) as e:
        ml.interpret_probe("image/png", _img_probe(ml.MAX_SIDE + 1, 10))
    assert e.value.reason == "too_large_dimensions"


def test_raster_megapixel_bomb_is_refused():
    """A 16384x16384 PNG (268 MP) is under MAX_SIDE on each axis but is a
    decompression bomb once ffmpeg decodes it for the thumbnail. interpret_probe
    SHOULD refuse any image above MAX_PIXELS, exactly as the HEIC path does."""
    big = ml.MAX_SIDE  # 16384 per side, each within the per-side cap
    assert big * big > ml.MAX_PIXELS  # 268 MP > 100 MP — this is a bomb
    with pytest.raises(ml.IngestReject) as e:
        ml.interpret_probe("image/png", _img_probe(big, big))
    assert e.value.reason == "too_large_dimensions"


RASTER_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")


@pytest.mark.parametrize("sniffed", RASTER_TYPES)
@pytest.mark.parametrize("width,height", [(10_000, 10_000), (ml.MAX_SIDE, ml.MAX_PIXELS // ml.MAX_SIDE)])
def test_raster_at_the_megapixel_cap_is_accepted(sniffed, width, height):
    """Regression: the area cap is inclusive, exactly like the HEIC path."""
    assert width * height <= ml.MAX_PIXELS
    p = ml.interpret_probe(sniffed, _img_probe(width, height))
    assert (p.kind, p.width, p.height) == ("image", width, height)


@pytest.mark.parametrize("sniffed", RASTER_TYPES)
@pytest.mark.parametrize("width,height", [
    (10_000, 10_001),                                   # just over 100 MP
    (ml.MAX_SIDE, ml.MAX_PIXELS // ml.MAX_SIDE + 1),    # one side at the side cap
    (ml.MAX_PIXELS // ml.MAX_SIDE + 1, ml.MAX_SIDE),    # either orientation
    (ml.MAX_SIDE, ml.MAX_SIDE),                         # the 268 MP bomb
])
def test_raster_over_the_megapixel_cap_is_refused(sniffed, width, height):
    """Regression: every raster type gets the area cap, with the reason word
    the UI already translates."""
    assert width * height > ml.MAX_PIXELS
    assert max(width, height) <= ml.MAX_SIDE  # only the area cap can catch these
    with pytest.raises(ml.IngestReject) as e:
        ml.interpret_probe(sniffed, _img_probe(width, height))
    assert e.value.reason == "too_large_dimensions"
