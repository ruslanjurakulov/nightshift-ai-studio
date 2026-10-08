#!/usr/bin/env python3
"""Builds the public site's picture and clip derivatives from the Pexels originals (docs/design/MEDIA_CREDITS.md).

    STOCK=/path/to/originals FFMPEG=/path/to/ffmpeg python3 scripts/make-site-media.py [stills|clips|all]

STOCK holds video/ and photo/ with the files named in OUT_STILLS and OUT_CLIPS below (the originals are 100+ MB and are
not in the repository; only what this writes is). It writes:

- components/site/media/NAME.webp (1280 px wide) and NAME-sm.webp (640 px wide) for every still;
- components/site/clips/NAME.mp4 / .webm (1280 x 720) and NAME-sm.mp4 / .webm (640 x 360) for every clip, and the clip's
  first frame as its still (the poster): so the picture a clip fades in over is its own frame, not another photograph.

One grade for all of them, so pictures from different photographers read as one set: blacks lifted a little, the
highlights warmed a little, saturation capped where a picture is hotter than the rest. It is the same function for a photo
and for every frame of a clip (grade()), and subtle on purpose: overlays and badges keep their contrast.

Loops. A clip is a loop made from a stretch of the source with a cross-dissolve: the last XF seconds of the loop are the
source one loop-length later, dissolving into the source's own start, so the loop's last frame is followed by a frame that
is the next source frame. The seam is then one ordinary frame step, which `seam()` measures and prints (mean absolute
grey difference of the wrap against the median and the largest step inside the loop).
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageEnhance, ImageStat

STOCK = os.environ.get("STOCK") or sys.exit("set STOCK to the directory that holds video/ and photo/ (the Pexels originals)")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "components", "site"))
STILLS_DIR = os.path.join(ROOT, "media")
CLIPS_DIR = os.path.join(ROOT, "clips")

# --- the one grade -----------------------------------------------------------------------------------------------------
LIFT = 0.03  # black point raised to about 8 of 255
WARM = 0.035  # how much the highlights warm (red up, blue down, by luma squared)


def _lut(channel: int, lift: float, warm: float) -> list[int]:
    out = []
    for v in range(256):
        x = v / 255.0
        x = lift + (1 - lift) * x
        h = x * x
        if channel == 0:
            x *= 1 + warm * h
        elif channel == 2:
            x *= 1 - warm * 1.2 * h
        out.append(max(0, min(255, int(x * 255 + 0.5))))
    return out


def grade(im: Image.Image, sat: float = 1.0, lift: float = LIFT, warm: float = WARM) -> Image.Image:
    im = im.convert("RGB")
    if sat != 1.0:
        im = ImageEnhance.Color(im).enhance(sat)
    return im.point(_lut(0, lift, warm) + _lut(1, lift, 0) + _lut(2, lift, warm))


# --- stills ------------------------------------------------------------------------------------------------------------
# name: (file, crop (x0, y0, x1, y1) as fractions of the original, aspect (w, h) of the derivative, quality, sat, lift)
# Crops are the manifest's advice, applied to the derivative itself so no CSS has to hide a face or a haze.
OUT_STILLS = {
    "dunes": ("photo/hero-desert-caravan-15848441.jpg", (0, 0, 1, 1), (16, 9), 74, 1.0, LIFT),
    "library": ("photo/library-chandelier-37387122.jpg", (0, 0.02, 1, 0.98), (16, 9), 72, 1.0, 0.015),
    # The moon sits at 86% of the frame width, clear of the words that go in the middle of the closing panel (it is centred in the original).
    "moon": ("photo/moon-night-sky-39335277.jpg", (0.0, 0.2547, 0.5813, 0.7453), (16, 9), 76, 1.0, 0.012),
    # The top third of the original is flat haze: the derivative starts below it.
    "market": ("photo/nightmarket-wide-20895317.jpg", (0.0, 0.22, 0.889, 1.0), (16, 9), 74, 1.08, LIFT),
    "valley": ("photo/valley-golden-mist-10352688.jpg", (0, 0, 1, 1), (16, 9), 74, 1.0, LIFT),
    "lighthouse": ("photo/lighthouse-golden-dusk-4390834.jpg", (0, 0, 1, 1), (16, 9), 74, 1.0, LIFT),
    # The small red-lit partial face at the far left bottom is cropped out (left 10%).
    "lanterns": ("photo/pricing-warm-lanterns-16046217.jpg", (0.10, 0.07, 1.0, 0.84), (16, 9), 76, 1.0, 0.012),
    "fishermen": ("photo/solutions-documentary-fishermen-39395221.jpg", (0, 0.1, 1, 0.82), (2, 1), 72, 0.82, LIFT),
    "workshop": ("photo/solutions-workshop-carving-19208266.jpg", (0, 0.1, 1, 0.78), (2, 1), 72, 1.0, LIFT),
    "citynight": ("photo/solutions-city-night-39659645.jpg", (0, 0.0, 1, 0.73), (2, 1), 72, 1.0, LIFT),
    "dawn": ("photo/login-dawn-fog-31550736.jpg", (0, 0, 1, 1), (16, 9), 70, 0.9, LIFT),
    "horizon": ("photo/signup-quiet-horizon-14701162.jpg", (0, 0, 1, 1), (16, 9), 68, 0.9, LIFT),
}
WIDTHS = {"": 1280, "-sm": 640}


def make_stills(only: set[str] | None = None) -> dict:
    os.makedirs(STILLS_DIR, exist_ok=True)
    sizes = {}
    for name, (file, crop, (aw, ah), q, sat, lift) in OUT_STILLS.items():
        if only and name not in only:
            continue
        src = Image.open(os.path.join(STOCK, file))
        W, H = src.size
        box = (round(crop[0] * W), round(crop[1] * H), round(crop[2] * W), round(crop[3] * H))
        cw, ch = box[2] - box[0], box[3] - box[1]
        # Trim the crop to the exact aspect, keeping its centre.
        if cw * ah > ch * aw:
            nw = round(ch * aw / ah)
            box = (box[0] + (cw - nw) // 2, box[1], box[0] + (cw - nw) // 2 + nw, box[3])
        else:
            nh = round(cw * ah / aw)
            box = (box[0], box[1] + (ch - nh) // 2, box[2], box[1] + (ch - nh) // 2 + nh)
        for suffix, w in WIDTHS.items():
            h = round(w * ah / aw)
            im = grade(src.resize((w, h), Image.LANCZOS, box=box), sat=sat, lift=lift)
            path = os.path.join(STILLS_DIR, f"{name}{suffix}.webp")
            im.save(path, "WEBP", quality=q if suffix == "" else q - 4, method=6)
            sizes[f"{name}{suffix}"] = os.path.getsize(path)
    return sizes


# --- clips -------------------------------------------------------------------------------------------------------------
FPS = 25
# name: dict(file, start, span, loop, xf, sat, budget (KB at 1280, at 640))
#   start/span: the stretch of the source used; loop: the loop's length in seconds; xf: the dissolve in seconds. The stretch is played
#   at span / (loop + xf) of its own speed (slower than the source when that is below 1).
OUT_CLIPS = {
    "caravan": dict(file="video/caravan-28673757.mp4", start=0.3, span=5.8, loop=7.0, xf=1.4, sat=1.0, budget=(400, 150)),
    "mist": dict(file="video/mist-river-18197835.mp4", start=0.2, span=10.4, loop=8.8, xf=1.6, sat=1.0, budget=(330, 120)),
    "coast": dict(file="video/lighthouse-14910095.mp4", start=0.3, span=11.0, loop=9.0, xf=1.6, sat=1.0, budget=(400, 150)),
}


def run(*args: str) -> None:
    subprocess.run(list(args), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def smooth(x: float) -> float:
    return x * x * (3 - 2 * x)


class Frames:
    """The source stretch as numbered JPEGs, read lazily with a tiny cache (the loop reads them in order)."""

    def __init__(self, path: str, count: int):
        self.path, self.count, self.cache = path, count, {}

    def get(self, i: int) -> Image.Image:
        i = max(0, min(self.count - 1, i))
        if i not in self.cache:
            if len(self.cache) > 6:
                self.cache.pop(next(iter(self.cache)))
            self.cache[i] = Image.open(os.path.join(self.path, f"{i + 1:05d}.jpg")).convert("RGB")
        return self.cache[i]


def at(frames: Frames, src_fps: float, t: float) -> Image.Image:
    f = t * src_fps
    i = int(math.floor(f))
    a = f - i
    if a < 1e-3:
        return frames.get(i)
    return Image.blend(frames.get(i), frames.get(i + 1), a)


def grey(im: Image.Image) -> Image.Image:
    return im.resize((320, 180), Image.BILINEAR).convert("L")


def mad(a: Image.Image, b: Image.Image) -> float:
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def probe_fps(path: str) -> float:
    out = subprocess.run([FFMPEG, "-i", path], capture_output=True, text=True).stderr
    for part in out.split(","):
        if part.strip().endswith(" fps"):
            return float(part.strip().split()[0])
    raise SystemExit("no fps")


def encode(frames_dir: str, out_base: str, w: int, h: int, budget_kb: int) -> dict:
    """The lowest-loss quality (highest quality) of each codec that fits the budget."""
    result = {}
    for ext, crfs in (("mp4", range(27, 45, 2)), ("webm", range(34, 62, 3))):
        out = f"{out_base}.{ext}"
        for crf in crfs:
            if ext == "mp4":
                args = [FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(frames_dir, "%05d.png"), "-vf", f"hqdn3d=2:1.5:5:4,scale={w}:{h}:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-profile:v", "main", "-movflags", "+faststart", "-an", out]
            else:
                args = [FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(frames_dir, "%05d.png"), "-vf", f"hqdn3d=2:1.5:5:4,scale={w}:{h}:flags=lanczos,format=yuv420p", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(crf), "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-an", out]
            run(*args)
            if os.path.getsize(out) <= budget_kb * 1024:
                break
        result[ext] = (os.path.getsize(out), crf)
    return result


def make_clip(name: str, p: dict) -> dict:
    src = os.path.join(STOCK, p["file"])
    src_fps = probe_fps(src)
    os.makedirs(CLIPS_DIR, exist_ok=True)
    os.makedirs(STILLS_DIR, exist_ok=True)
    report = {}
    # FRAMES=dir keeps the drawn loop frames there and reuses them (to try encoder settings without redrawing).
    keep = os.environ.get("FRAMES")
    with tempfile.TemporaryDirectory() as scratch:
        tmp = os.path.join(keep, name) if keep else scratch
        os.makedirs(tmp, exist_ok=True)
        n = round(p["loop"] * FPS)
        full = os.path.join(tmp, "full")
        if os.path.isdir(full) and len(os.listdir(full)) == n:
            greys = [grey(Image.open(os.path.join(full, f"{k + 1:05d}.png"))) for k in range(n)]
        else:
            raw = os.path.join(tmp, "raw")
            os.makedirs(raw, exist_ok=True)
            run(FFMPEG, "-y", "-ss", str(p["start"]), "-t", str(p["span"] + 0.2), "-i", src, "-vf", "scale=1280:720:flags=lanczos", "-fps_mode", "passthrough", "-q:v", "2", os.path.join(raw, "%05d.jpg"))
            frames = Frames(raw, len(os.listdir(raw)))
            speed = p["span"] / (p["loop"] + p["xf"])
            os.makedirs(full, exist_ok=True)
            greys = []
            for k in range(n):
                tk = k / FPS
                ts = tk * speed
                if tk >= p["xf"]:
                    im = at(frames, src_fps, ts)
                else:
                    a = smooth(tk / p["xf"])
                    im = Image.blend(at(frames, src_fps, (tk + p["loop"]) * speed), at(frames, src_fps, ts), a)
                im = grade(im, sat=p["sat"])
                im.save(os.path.join(full, f"{k + 1:05d}.png"))
                greys.append(grey(im))
        steps = sorted(mad(greys[i], greys[i + 1]) for i in range(n - 1))
        wrap = mad(greys[-1], greys[0])
        report["seam"] = dict(wrap=round(wrap, 3), median_step=round(steps[len(steps) // 2], 3), p95_step=round(steps[int(len(steps) * 0.95)], 3), max_step=round(steps[-1], 3), frames=n, loop_s=n / FPS)
        # Frame 0 is the poster: the page's still for this clip.
        first = Image.open(os.path.join(full, "00001.png"))
        for suffix, w in WIDTHS.items():
            first.resize((w, round(w * 9 / 16)), Image.LANCZOS).save(os.path.join(STILLS_DIR, f"{name}{suffix}.webp"), "WEBP", quality=74 if suffix == "" else 70, method=6)
        report["poster_kb"] = {s or "lg": round(os.path.getsize(os.path.join(STILLS_DIR, f"{name}{s}.webp")) / 1024, 1) for s in WIDTHS}
        for suffix, (w, h, budget) in {"": (1280, 720, p["budget"][0]), "-sm": (640, 360, p["budget"][1])}.items():
            enc = encode(full, os.path.join(CLIPS_DIR, f"{name}{suffix}"), w, h, budget)
            report[f"clip{suffix or '-lg'}"] = {k: dict(kb=round(v[0] / 1024, 1), crf=v[1]) for k, v in enc.items()}
    return report


def main() -> None:
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    only = set(sys.argv[2:]) or None
    out = {}
    if what in ("stills", "all"):
        s = make_stills(only)
        out["stills_kb"] = {k: round(v / 1024, 1) for k, v in s.items()}
    if what in ("clips", "all"):
        out["clips"] = {n: make_clip(n, p) for n, p in OUT_CLIPS.items() if not only or n in only}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
