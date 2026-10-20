#!/usr/bin/env python3
"""Builds the public site's AI-generated illustrations (docs/design/MEDIA_CREDITS.md, "Illustrations") from the owner's PNGs.

    ART=/path/to/pngs python3 scripts/make-site-art.py

ART holds the thirteen PNG originals named in OUT below (they are 1.6 to 3.8 MB each and are not in the repository; only what
this writes is). It writes components/site/art/NAME.webp: one file each, at the width the page draws it at twice over, and the
highest WebP quality that fits the file's byte budget (the dark gradients band first when the budget is tight, so the quality
is searched, not fixed). tests/site-art.test.tsx pins the budgets. No grade, no crop: the pictures are shown as they were made.
"""
import io
import os
import sys

from PIL import Image

ART = os.environ.get("ART") or sys.exit("set ART to the directory that holds the original PNGs")
OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "components", "site", "art"))

KB = 1024
# name -> (width, byte budget)
OUT = {
    "hero-night": (1672, 220 * KB),
    "step-1": (800, 90 * KB),
    "step-2": (800, 90 * KB),
    "step-3": (800, 90 * KB),
    "tool-image": (800, 90 * KB),
    "tool-video": (800, 90 * KB),
    "tool-voice": (800, 90 * KB),
    "tool-edit": (800, 90 * KB),
    "tool-animate": (800, 90 * KB),
    "tool-upscale": (800, 90 * KB),
    "tool-cutout": (800, 90 * KB),
    "tool-styles": (800, 90 * KB),
    "thumb-silkroad": (960, 150 * KB),
}


def encode(im: Image.Image, q: int) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=q, method=6)
    return buf.getvalue()


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (width, budget) in OUT.items():
        im = Image.open(os.path.join(ART, f"{name}.png")).convert("RGB")
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        best = None
        for q in range(92, 40, -2):
            data = encode(im, q)
            if len(data) <= budget:
                best = (q, data)
                break
        if best is None:
            sys.exit(f"{name}: no quality fits {budget} bytes")
        q, data = best
        with open(os.path.join(OUT_DIR, f"{name}.webp"), "wb") as f:
            f.write(data)
        print(f"{name}: {im.width}x{im.height} q{q} {len(data) / KB:.1f} KB (budget {budget // KB})")


if __name__ == "__main__":
    main()
