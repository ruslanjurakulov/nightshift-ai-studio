"""The colours of a logo, for the brand scan — run as a CHILD PROCESS (migration 0133, ``modules/brand_extract.palette``).

    python -I -B modules/brand_palette.py <mem_bytes> <cpu_seconds>      (the picture on stdin)

Everything that touches the untrusted picture happens here, under limits this process puts on itself BEFORE it imports
Pillow (as ``modules/heic_decode.py`` does): ``RLIMIT_AS``, ``RLIMIT_CPU``, ``RLIMIT_FSIZE`` 0 (it writes no file),
``RLIMIT_NOFILE`` and no core dumps; on Linux a limit that cannot be set is fatal. At most ``MAX_INPUT`` bytes are read.
Only PNG, JPEG and WEBP are opened (``formats=``: never SVG, never a format Pillow would guess), and the header is read
first: the longest side at most ``MAX_SIDE`` and at most ``MAX_PIXELS`` pixels, or nothing is decoded (a decompression
bomb is refused). The picture is then shrunk to at most 64 x 64, transparent pixels are left out, and the remaining
colours are reduced to six.

It prints ONE JSON line, whatever happens:  {"ok": true, "colors": ["#rrggbb", ...]}  or  {"ok": false, "reason": "<word>"}.
Standalone (stdlib, then Pillow): it imports nothing of the worker and logs nothing.
"""

from __future__ import annotations

import json
import sys

MAX_INPUT = 5 * 1024 * 1024
MAX_SIDE = 8192
MAX_PIXELS = 40_000_000
COLOURS = 6


def _say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _fail(reason: str, code: int = 3) -> None:
    _say({"ok": False, "reason": reason})
    raise SystemExit(code)


def apply_limits(mem_bytes: int, cpu_seconds: int) -> None:
    try:
        import resource  # noqa: PLC0415
    except ImportError:
        return
    strict = sys.platform.startswith("linux")
    for which, value in ((resource.RLIMIT_CPU, int(cpu_seconds)), (resource.RLIMIT_AS, int(mem_bytes)),
                         (resource.RLIMIT_FSIZE, 0), (resource.RLIMIT_NOFILE, 32), (resource.RLIMIT_CORE, 0)):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            if strict:
                _fail("limits")


def colours(data: bytes) -> list:
    import io  # noqa: PLC0415
    import warnings  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    im = Image.open(io.BytesIO(data), formats=["PNG", "JPEG", "WEBP"])
    w, h = im.size
    if w <= 0 or h <= 0 or max(w, h) > MAX_SIDE or w * h > MAX_PIXELS:
        _fail("too_large")
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    if im.format == "JPEG":
        im.draft("RGB", (256, 256))            # decode at a fraction of the size: fewer pixels touched
    im.thumbnail((64, 64))
    rgba = im.convert("RGBA")
    opaque = [(r, g, b) for (r, g, b, a) in rgba.getdata() if a >= 128]
    if not opaque:
        return []
    flat = Image.new("RGB", (len(opaque), 1))
    flat.putdata(opaque)
    q = flat.quantize(colors=COLOURS, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette() or []
    counts = sorted(q.getcolors(COLOURS) or [], reverse=True)
    out = []
    for count, idx in counts:
        if count * 50 < len(opaque):           # under 2 % of the picture: a stray edge pixel, not a brand colour
            continue
        r, g, b = pal[idx * 3:idx * 3 + 3]
        hx = "#%02x%02x%02x" % (r, g, b)
        if hx not in out:
            out.append(hx)
    return out


def main(argv) -> int:
    if len(argv) != 3:
        _fail("usage", 2)
    apply_limits(int(argv[1]), int(argv[2]))
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if not data or len(data) > MAX_INPUT:
        _fail("size")
    try:
        found = colours(data)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — any decoder failure is one answer: not read
        _fail("decode_failed")
    _say({"ok": True, "colors": found})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
