#!/usr/bin/env python3
"""Builds the public site's AI-generated illustrations (docs/design/MEDIA_CREDITS.md, "Illustrations") from the owner's PNGs.

    ART=/path/to/pngs python3 scripts/make-site-art.py

ART holds the PNG originals named in OUT below (a name without a PNG there is skipped; name some on the command line to build only those). The step and tool PNGs are RGBA with a transparent background: step1..3.png and image, video, voice, edit, animate, upscale, cutout, styles.png named in OUT below (they are 1.6 to 3.8 MB each and are not in the repository; only what
this writes is). It writes components/site/art/NAME.webp: one file each, at the width the page draws it at twice over, and the
highest WebP quality that fits the file's byte budget (the dark gradients band first when the budget is tight, so the quality
is searched, not fixed). tests/site-art.test.tsx pins the budgets. No grade, and no crop except hero-night-sm (the phone's portrait cut of the hero, see CROP).
"""
import io
import os
import sys

import numpy as np
from PIL import Image

ART = os.environ.get("ART") or sys.exit("set ART to the directory that holds the original PNGs")
OUT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "components", "site", "art"))

KB = 1024
# name -> (width, byte budget); a name in CROP is first cut from the original (left, top, right, bottom, in original pixels)
OUT = {
    "hero-night": (1672, 220 * KB),
    "hero-night-sm": (630, 90 * KB),
    # The step and tool pictures (components/site/art.tsx SLOT_ART): RGBA PNGs with a transparent background, see SLOT_PNG and make_slot.
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

# The owner's PNG for each slot (the file the converter looks for), and the slot's canvas shape: steps are square, tools 4:3.
SLOT_PNG = {
    "step-1": "step1", "step-2": "step2", "step-3": "step3",
    "tool-image": "image", "tool-video": "video", "tool-voice": "voice", "tool-edit": "edit",
    "tool-animate": "animate", "tool-upscale": "upscale", "tool-cutout": "cutout", "tool-styles": "styles",
}
SLOT_ASPECT = {"step": 1.0, "tool": 4 / 3}
# Alpha below this is generation speckle (1 to 3% of a picture's pixels carry a faint alpha) and becomes fully transparent.
ALPHA_FLOOR = 12
# The object keeps this share of the canvas free on each side of its limiting axis, the same for all eleven, so they read as equally sized.
MARGIN = 0.07


def make_slot(src: Image.Image, width: int, aspect: float) -> Image.Image:
    """Cleans the alpha, trims the transparent border, and re-pads the object onto a transparent canvas of the slot's shape with the same margin."""
    px = np.array(src.convert("RGBA"))
    px[px[..., 3] < ALPHA_FLOOR] = 0
    ys, xs = np.where(px[..., 3] > 0)
    obj = Image.fromarray(px[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1], "RGBA")
    cw, ch = width, round(width / aspect)
    scale = min(cw * (1 - 2 * MARGIN) / obj.width, ch * (1 - 2 * MARGIN) / obj.height)
    # Pillow resizes RGBA premultiplied, so the edge carries no halo of the colour under the transparent pixels.
    obj = obj.resize((round(obj.width * scale), round(obj.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    canvas.paste(obj, ((cw - obj.width) // 2, (ch - obj.height) // 2))
    return canvas


def encode(im: Image.Image, q: int, alpha_q: int = 100) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=q, method=6, alpha_quality=alpha_q)
    return buf.getvalue()


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    only = set(sys.argv[1:])
    for name, (width, budget) in OUT.items():
        if only and name not in only:
            continue
        src = os.path.join(ART, f"{SLOT_PNG[name]}.png" if name in SLOT_PNG else f"{name.removesuffix('-sm')}.png" if name in CROP else f"{name}.png")
        if name in SLOT_PNG and not os.path.exists(src):
            src = os.path.join(ART, f"{name}.png")
        if not os.path.exists(src):
            print(f"{name}: no {os.path.basename(src)} in ART, skipped")
            continue
        if name in SLOT_PNG:
            im = make_slot(Image.open(src), width, SLOT_ASPECT[name.split("-")[0]])
        else:
            im = Image.open(src).convert("RGB")
            if name in CROP:
                im = im.crop(CROP[name])
            im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        best = None
        # The colour quality is searched first; if no colour quality fits, the alpha channel (lossless by default) is let go a little too.
        for alpha_q in (100, 90, 80):
            for q in range(92, 40, -2):
                data = encode(im, q, alpha_q)
                if len(data) <= budget:
                    best = (q, data)
                    break
            if best:
                break
        if best is None:
            sys.exit(f"{name}: no quality fits {budget} bytes")
        q, data = best
        with open(os.path.join(OUT_DIR, f"{name}.webp"), "wb") as f:
            f.write(data)
        print(f"{name}: {im.width}x{im.height} q{q} {len(data) / KB:.1f} KB (budget {budget // KB})")


if __name__ == "__main__":
    main()
