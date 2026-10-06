#!/usr/bin/env python3
"""Renders a site clip (components/site/clips/NAME.mp4 and NAME.webm) from one of the example stills.

    FFMPEG=/path/to/ffmpeg python3 scripts/render-site-clips.py NAME STILL.png PAN_PHASE

A slow push-in (zoom 1.0 to 1.19 and back) with a sideways drift and a light that breathes once per loop, 8 s at
24 fps, 1280 x 720, no audio. Every frame is drawn here from a closed-form function of the loop position t = i / 192, with
zoom, pan and brightness all periodic in t, so frame 192 IS frame 0 and the loop has no seam by construction
(the first version asked ffmpeg's zoompan for the same thing and its frame counter did not close: a seam of 5.6 grey
levels every 8 seconds). Frame 0 is the whole still, which is also the poster the page shows without script.

The stills (1376 x 768 PNG) are the owner's approved ones and are not in the repo. Shipped: silkroad 0.6, library 2.4,
valley 4.2.
"""
import math
import os
import subprocess
import sys
import tempfile

from PIL import Image

N = 192
FPS = 24
OUT_W, OUT_H = 1280, 720
ZOOM = 0.19  # peak zoom over the whole still
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "components", "site", "clips")


def frame(src: Image.Image, i: int, phase: float) -> Image.Image:
    t = i / N
    w, h = src.size
    ease = (1 - math.cos(2 * math.pi * t)) / 2  # 0 at the ends of the loop, 1 in the middle
    z = 1 + ZOOM * ease
    cw, ch = w / z, h / z
    # The crop is centred on the still and drifts by up to its whole slack, which is zero when the zoom is 1.
    sx = math.sin(2 * math.pi * t + phase)
    sy = math.sin(2 * math.pi * t + phase * 0.6 + 1.1)
    cx = w / 2 + (w - cw) / 2 * sx
    cy = h / 2 + (h - ch) / 2 * sy * 0.8
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    im = src.resize((OUT_W, OUT_H), Image.LANCZOS, box=box)
    # Brightness through a rounded lookup table. Pillow's ImageEnhance (Brightness and Color alike) truncates, so every frame whose
    # factor is not exactly 1 came out about half a grey level darker than frame 0, whose factor is exactly 1: a step at the wrap.
    f = 1 + 0.035 * math.sin(2 * math.pi * t)
    lut = [min(255, int(v * f + 0.5)) for v in range(256)]
    im = im.point(lut * 3)
    return im


def main() -> None:
    name, still, phase = sys.argv[1], sys.argv[2], float(sys.argv[3])
    src = Image.open(still).convert("RGB")
    out = os.path.normpath(OUT_DIR)
    # FRAMES=dir keeps the 192 drawn frames there and reuses them (to try encoder settings without redrawing).
    keep = os.environ.get("FRAMES")
    with tempfile.TemporaryDirectory() as scratch:
        tmp = keep or scratch
        os.makedirs(tmp, exist_ok=True)
        if not os.path.exists(os.path.join(tmp, f"{N - 1:03d}.png")):
            for i in range(N):
                frame(src, i, phase).save(os.path.join(tmp, f"{i:03d}.png"))
        base = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(tmp, "%03d.png")]
        subprocess.run(base + ["-c:v", "libx264", "-preset", "slow", "-crf", os.environ.get("MP4_CRF", "28"), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", os.path.join(out, f"{name}.mp4")], check=True)
        subprocess.run(base + ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", os.environ.get("WEBM_CRF", "38"), "-row-mt", "1", "-deadline", "good", "-cpu-used", "1", "-pix_fmt", "yuv420p", "-an", os.path.join(out, f"{name}.webm")], check=True)


if __name__ == "__main__":
    main()
