"""HEIC / HEIF decoding for the media library — run as a CHILD PROCESS (0044).

    python -I modules/heic_decode.py <source> <out_dir> <mem_bytes> <cpu_seconds>

``modules/media_library.py`` starts this file with an argv list (no shell), a
near-empty environment (the worker's service key is not passed on), a timeout
and a heartbeat. Everything that touches the untrusted picture happens here,
under limits this process puts on itself BEFORE it imports the decoder:

* ``RLIMIT_AS`` (memory), ``RLIMIT_CPU``, ``RLIMIT_FSIZE`` (nothing it writes can
  be larger than a few MB), ``RLIMIT_NOFILE`` and no core dumps. On Linux a limit
  that cannot be set is fatal (the process exits without decoding): no limit,
  no decode. Elsewhere (a developer's laptop) the limits are best effort.
* The header is read first and the size checked BEFORE a single pixel is
  decoded: the longest side must be <= 16384 and width * height <= 100
  megapixels (a decompression bomb is refused, never decoded).

What it writes into ``<out_dir>``: ``display.jpg`` (longest side <= 2048) and
``thumb.jpg`` (longest side <= 480), 8-bit sRGB JPEG with NO EXIF, GPS, XMP or
colour profile. EXIF orientation is applied exactly once: pillow-heif applies
the container's rotation and resets the EXIF tag to 1, and ``exif_transpose``
afterwards is a no-op that only guards a decoder that left a tag behind.

It prints ONE JSON line, whatever happens::

    {"ok": true, "width": W, "height": H}              the oriented size
    {"ok": false, "reason": "<word>", "detail": "..."}  too_large_dimensions | decode_failed | unavailable

Standalone on purpose (stdlib, then Pillow and pillow_heif): it must not import
the rest of the worker, and it logs nothing but the exception type.
"""

from __future__ import annotations

import json
import os
import sys

MAX_SIDE = 16384
MAX_PIXELS = 100_000_000
DISPLAY_SIDE = 2048
THUMB_SIDE = 480
DISPLAY_QUALITY = 85
THUMB_QUALITY = 82
#: Nothing this process writes is larger than this (two JPEGs of <= 2048 px).
MAX_OUT_BYTES = 32 * 1024 * 1024


def _say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _fail(reason: str, detail: str = "", code: int = 3) -> "None":
    _say({"ok": False, "reason": reason, "detail": detail[:200]})
    raise SystemExit(code)


def apply_limits(mem_bytes: int, cpu_seconds: int) -> None:
    """Limit this process. Exits (no decode) when Linux refuses a limit."""
    try:
        import resource  # noqa: PLC0415
    except ImportError:  # not POSIX: nothing to set
        return
    strict = sys.platform.startswith("linux")
    wanted = [
        (resource.RLIMIT_CPU, int(cpu_seconds)),
        (resource.RLIMIT_AS, int(mem_bytes)),
        (resource.RLIMIT_FSIZE, MAX_OUT_BYTES),
        (resource.RLIMIT_NOFILE, 64),
        (resource.RLIMIT_CORE, 0),
    ]
    for which, value in wanted:
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            if strict:
                _fail("decode_failed", "a resource limit could not be set")


def _srgb_rgb(im):
    """8-bit sRGB with no alpha. A colour profile (an iPhone writes Display P3)
    is converted to sRGB, then dropped; without one the pixels are taken as
    sRGB already."""
    import io  # noqa: PLC0415

    from PIL import Image, ImageCms  # noqa: PLC0415

    alpha = im.getchannel("A") if im.mode in ("RGBA", "LA", "PA") else None
    rgb = im.convert("RGB")
    icc = im.info.get("icc_profile")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            rgb = ImageCms.profileToProfile(rgb, src, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:  # a broken profile: the pixels as they are
            pass
    if alpha is not None:
        flat = Image.new("RGB", rgb.size, (255, 255, 255))
        flat.paste(rgb, mask=alpha)
        return flat
    return rgb


def _write_jpeg(im, path: str, quality: int) -> None:
    # Pillow writes EXIF / ICC only when handed ``exif=`` / ``icc_profile=``
    # (taken from the save arguments, never from ``im.info``): none is passed.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as f:
        im.save(f, "JPEG", quality=quality, optimize=True, progressive=False, subsampling="4:2:0")


def decode(src: str, out_dir: str) -> dict:
    try:
        import pillow_heif  # noqa: PLC0415
        from PIL import Image, ImageOps  # noqa: PLC0415
    except ModuleNotFoundError:
        _fail("unavailable", "heic decoding is not available on this server", code=4)
    except Exception as e:  # present but broken (or out of memory while loading)
        _fail("decode_failed", f"the decoder could not be loaded ({type(e).__name__})")

    pillow_heif.register_heif_opener()
    # Only the primary picture is wanted: no embedded thumbnails, depth maps or
    # auxiliary images are loaded, and libheif's own security limits stay on.
    for name, value in (("DECODE_THREADS", 2), ("THUMBNAILS", False), ("DEPTH_IMAGES", False),
                        ("AUX_IMAGES", False), ("DISABLE_SECURITY_LIMITS", False)):
        try:
            setattr(pillow_heif.options, name, value)
        except Exception:
            pass
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    import warnings  # noqa: PLC0415

    warnings.simplefilter("error", Image.DecompressionBombWarning)
    try:
        with open(src, "rb") as fh:
            # Header only: the size is known before any pixel is decoded.
            im = Image.open(fh, formats=["HEIF"])
            w, h = im.size
            if w <= 0 or h <= 0:
                _fail("decode_failed", "the image has no size")
            if max(w, h) > MAX_SIDE:
                _fail("too_large_dimensions", f"{w}x{h} is larger than {MAX_SIDE}px")
            if w * h > MAX_PIXELS:
                _fail("too_large_dimensions", f"{w}x{h} is more than {MAX_PIXELS // 1_000_000} megapixels")
            im.load()
            oriented = ImageOps.exif_transpose(im)
            rgb = _srgb_rgb(oriented)
    except SystemExit:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        # Pillow's own guard (same cap) fires inside open(), on the header.
        _fail("too_large_dimensions", f"more than {MAX_PIXELS // 1_000_000} megapixels")
    except MemoryError:
        _fail("decode_failed", "the picture needs more memory than a decode may use")
    except Exception as e:  # Pillow, libheif, corrupt data: the type only
        _fail("decode_failed", f"the picture could not be decoded ({type(e).__name__})")

    width, height = rgb.size
    rgb.thumbnail((DISPLAY_SIDE, DISPLAY_SIDE), Image.Resampling.LANCZOS)
    _write_jpeg(rgb, os.path.join(out_dir, "display.jpg"), DISPLAY_QUALITY)
    rgb.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.Resampling.LANCZOS)
    _write_jpeg(rgb, os.path.join(out_dir, "thumb.jpg"), THUMB_QUALITY)
    return {"ok": True, "width": width, "height": height}


def main(argv: list) -> int:
    if len(argv) != 5:
        _fail("decode_failed", "bad arguments", code=2)
    src, out_dir = argv[1], argv[2]
    try:
        mem_bytes, cpu_seconds = int(argv[3]), int(argv[4])
    except ValueError:
        _fail("decode_failed", "bad arguments", code=2)
    apply_limits(mem_bytes, cpu_seconds)
    try:
        result = decode(src, out_dir)
    except SystemExit:
        raise
    except MemoryError:
        _fail("decode_failed", "the picture needs more memory than a decode may use")
    except Exception as e:
        _fail("decode_failed", f"the picture could not be decoded ({type(e).__name__})")
    _say(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
