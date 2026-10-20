#!/usr/bin/env python3
"""Builds the public site's AI-generated illustrations (docs/design/MEDIA_CREDITS.md, "Illustrations") from the owner's PNGs.

    ART=/path/to/pngs python3 scripts/make-site-art.py

ART holds the PNG originals named in OUT below (a name without a PNG there is skipped; name some on the command line to build only those) named in OUT below (they are 1.6 to 3.8 MB each and are not in the repository; only what
this writes is). It writes components/site/art/NAME.webp: one file each, at the width the page draws it at twice over, and the
highest WebP quality that fits the file's byte budget (the dark gradients band first when the budget is tight, so the quality
is searched, not fixed). tests/site-art.test.tsx pins the budgets. No grade, and no crop except hero-night-sm (the phone's portrait cut of the hero, see CROP).
"""
import io
import os
import sys

from PIL import Image

ART = os.environ.get("ART") or sys.exit("set ART to the directory that holds the original PNGs")
OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "components", "site", "art"))

KB = 1024
# name -> (width, byte budget); a name in CROP is first cut from the original (left, top, right, bottom, in original pixels)
OUT = {
    "hero-night": (1672, 220 * KB),
    "hero-night-sm": (630, 90 * KB),
    # The optional step and tool pictures (components/site/art.tsx SLOT_ART): none is in the page today; a PNG that is missing is skipped.
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


# The phone's backdrop: a portrait cut of the hero (the mic, the plants and the curtain; the bright laptop and the window are left out),
# so a phone gets a sharp picture of its own at about its own pixels rather than the wide one cropped by CSS.
CROP = {"hero-night-sm": (520, 0, 1150, 941)}


def encode(im: Image.Image, q: int) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=q, method=6)
    return buf.getvalue()


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    only = set(sys.argv[1:])
    for name, (width, budget) in OUT.items():
        if only and name not in only:
            continue
        src = os.path.join(ART, f"{name.removesuffix('-sm')}.png" if name in CROP else f"{name}.png")
        if not os.path.exists(src):
            print(f"{name}: no {os.path.basename(src)} in ART, skipped")
            continue
        im = Image.open(src).convert("RGB")
        if name in CROP:
            im = im.crop(CROP[name])
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
