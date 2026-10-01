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

This test asserts the SECURE behaviour, so it is xfail(strict=True) while the
hole is open: it will turn green the moment interpret_probe grows a total-pixel
guard, and strict mode then flags the stale marker.
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


@pytest.mark.xfail(strict=True, reason="BR-C-001 open: no total-pixel cap on raster images")
def test_raster_megapixel_bomb_is_refused():
    """A 16384x16384 PNG (268 MP) is under MAX_SIDE on each axis but is a
    decompression bomb once ffmpeg decodes it for the thumbnail. interpret_probe
    SHOULD refuse any image above MAX_PIXELS, exactly as the HEIC path does."""
    big = ml.MAX_SIDE  # 16384 per side, each within the per-side cap
    assert big * big > ml.MAX_PIXELS  # 268 MP > 100 MP — this is a bomb
    with pytest.raises(ml.IngestReject):
        ml.interpret_probe("image/png", _img_probe(big, big))
