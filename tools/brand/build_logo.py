#!/usr/bin/env python3
"""Build the Nightshift mark SVGs and the app-icon tiles from the traced outline.

The outline below was traced from the owner-supplied 1254 x 1254 artwork
(command-center/brand/logo/source/owner-supplied-N-1254.png) by
tools/brand/trace_logo.py: a sub-pixel contour at the 50% level, straight runs
fitted as lines (verticals snapped to exactly vertical), the two fold notches
taken as line intersections, the two small pillar tips as circular fillets and
the four large turns as least-squares cubic Beziers with tangent continuity.
Coordinates are in the artwork's pixel space; every output is re-based onto a
1000-unit-wide box with no padding. The soft fold shadows are gradients that
were fitted to the artwork (perpendicular falloff from the fold edge times a
taper along it).

    python3 tools/brand/build_logo.py

writes command-center/brand/logo/*.svg and command-center/app/icon.svg.
Standard library + numpy only; no network.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
LOGO_DIR = REPO / "command-center" / "brand" / "logo"
APP_DIR = REPO / "command-center" / "app"

# --- the traced silhouette, artwork pixel space (1254 x 1254 source) ----------
TRACE_PATH = (
    "M737.9 822.6 L524.8 596.0 L524.8 844.1 C524.8 848.4 520.1 851.2 516.3 849.1 "
    "L440.4 807.6 C438.4 806.5 412.8 791.1 401.8 774.8 C388.4 755.1 388.9 739.9 388.9 726.5 "
    "L388.9 465.4 C388.9 427.1 408.7 403.7 450.6 403.5 C488.6 403.3 506.5 405.1 539.0 438.3 "
    "L727.8 631.2 L727.8 408.6 C727.8 404.3 732.3 401.6 736.2 403.5 L786.7 429.2 "
    "C804.1 438.1 833.1 456.0 842.1 466.3 C861.9 489.1 864.0 504.1 864.0 527.6 L864.0 771.7 "
    "C864.0 806.3 852.1 831.8 819.4 844.8 C790.4 856.2 760.3 846.5 737.9 822.6 Z"
)
OX, OY = 388.8, 403.4  # top-left of the silhouette's bounding box
W0, H0 = 864.2 - 388.8, 849.4 - 403.4
S = 1000.0 / W0  # artwork px -> mark units
VBW, VBH = 1000, round(H0 * S)  # 1000 x 938

# The two fold notches (where a ribbon edge meets a pillar edge) and the angle
# of the ribbon edge that casts each shadow, in artwork pixels / degrees.
N1, TH1 = (524.8, 596.0), 46.76  # ribbon's lower edge over the left pillar
N2, TH2 = (727.8, 631.2), 45.62  # ribbon's upper edge over the right pillar


def T(x: float, y: float) -> tuple[float, float]:
    return ((x - OX) * S, (y - OY) * S)


def f(v: float) -> str:
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def rebase(raw: str) -> str:
    toks = re.findall(r"[MLCZ]|-?\d+\.?\d*", raw)
    out, i = [], 0
    while i < len(toks):
        t = toks[i]
        if t == "Z":
            out.append("Z")
            i += 1
            continue
        n = {"M": 1, "L": 1, "C": 3}[t]
        pts = [T(float(toks[i + 1 + 2 * k]), float(toks[i + 2 + 2 * k])) for k in range(n)]
        out.append(t + " ".join(f"{f(a)} {f(b)}" for a, b in pts))
        i += 1 + 2 * n
    return "".join(out)


PATH = rebase(TRACE_PATH)
N1f, N2f = T(*N1), T(*N2)

# --- fitted shading profiles (artwork px; opacity of black over #FAFAFA) ------
LEFT_U = [(0, 0.38), (10, 0.285), (20, 0.22), (30, 0.165), (40, 0.13), (50, 0.105), (60, 0.085), (80, 0.055), (100, 0.034), (130, 0.012), (170, 0)]
RIGHT_U = [(0, 0.30), (10, 0.225), (20, 0.165), (30, 0.115), (40, 0.085), (50, 0.066), (60, 0.055), (80, 0.044), (100, 0.036), (140, 0.026), (200, 0.02)]
LEFT_V = [(-130, 0), (-10, 1), (150, 1)]
RIGHT_V = [(-100, 0), (-60, 0.15), (-40, 0.35), (-20, 0.68), (0, 0.9), (50, 1), (100, 0.92), (150, 0.78), (200, 0.58)]
RIBBON = [(500, 0), (585, 0.03), (690, 0.03), (760, 0)]


def _grad(id_, x1, y1, x2, y2, lst, span, color, k=1.0):
    st = "".join(f'<stop offset="{o / span:.3f}" stop-color="{color}" stop-opacity="{a * k:.3f}"/>' for o, a in lst)
    return f'<linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{st}</linearGradient>'


def _mask_grad(id_, lst, lo, hi):
    st = "".join(f'<stop offset="{(o - lo) / (hi - lo):.3f}" stop-color="#fff" stop-opacity="{a}"/>' for o, a in lst)
    return f'<linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{lo}" y1="0" x2="{hi}" y2="0">{st}</linearGradient>'


def shaded_mark(base: str, shade: str, k: float, ribbon_k: float, ids: str) -> tuple[str, str]:
    """(defs, body) for the fold-shaded mark in 1000-unit space."""
    rx1, rx2 = (500 - OX) * S, (760 - OX) * S
    rb = "".join(f'<stop offset="{(o - 500) / 260:.3f}" stop-color="{shade}" stop-opacity="{a * ribbon_k / 0.03:.3f}"/>' for o, a in RIBBON)
    defs = (
        f'<clipPath id="{ids}-n"><path d="{PATH}"/></clipPath>'
        + _grad(f"{ids}-lu", 0, 0, 0, 170, LEFT_U, 170, shade, k)
        + _grad(f"{ids}-ru", 0, 0, 0, 200, RIGHT_U, 200, shade, k)
        + _mask_grad(f"{ids}-lv", LEFT_V, -130, 150)
        + _mask_grad(f"{ids}-rv", RIGHT_V, -100, 200)
        + f'<linearGradient id="{ids}-rb" gradientUnits="userSpaceOnUse" x1="{f(rx1)}" y1="0" x2="{f(rx2)}" y2="0">{rb}</linearGradient>'
        + f'<mask id="{ids}-lm" maskUnits="userSpaceOnUse" x="-200" y="-10" width="400" height="200"><rect x="-200" y="-10" width="400" height="200" fill="url(#{ids}-lv)"/></mask>'
        + f'<mask id="{ids}-rm" maskUnits="userSpaceOnUse" x="-110" y="-10" width="360" height="230"><rect x="-110" y="-10" width="360" height="230" fill="url(#{ids}-rv)"/></mask>'
    )
    body = (
        f'<path d="{PATH}" fill="{base}"/>'
        f'<g clip-path="url(#{ids}-n)">'
        f'<rect x="-100" y="-100" width="1300" height="1200" fill="url(#{ids}-rb)"/>'
        f'<g transform="translate({f(N1f[0])} {f(N1f[1])}) rotate({TH1}) scale({S:.4f})"><rect x="-200" y="0" width="400" height="170" fill="url(#{ids}-lu)" mask="url(#{ids}-lm)"/></g>'
        f'<g transform="translate({f(N2f[0])} {f(N2f[1])}) rotate({TH2}) scale({S:.4f} {-S:.4f})"><rect x="-110" y="0" width="360" height="200" fill="url(#{ids}-ru)" mask="url(#{ids}-rm)"/></g>'
        "</g>"
    )
    return defs, body


def _svg(inner: str, title: str, defs: str = "") -> str:
    d = f"<defs>{defs}</defs>" if defs else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VBW} {VBH}" role="img" aria-labelledby="t">'
        f'<title id="t">{title}</title>{d}{inner}</svg>\n'
    )


def mark_light_on_dark() -> str:
    defs, body = shaded_mark("#FAFAFA", "#000", 1.0, 0.03, "ns")
    return _svg(body, "Nightshift", defs)


def mark_dark_on_light() -> str:
    # A near-black mark cannot be darkened, so the fold is a lightening instead.
    defs, body = shaded_mark("#0E1014", "#fff", 0.8, 0.04, "ns")
    return _svg(body, "Nightshift", defs)


def wedge_left(w: float = 36.0):
    th = np.radians(TH1)
    e = np.array([np.cos(th), np.sin(th)])
    n = np.array([-e[1], e[0]])
    N = np.array(N1)
    return [N - e * 118, N, np.array([N1[0], N1[1] + w / n[1]]), N - e * 64 + n * w]


def wedge_right(w: float = 36.0):
    th = np.radians(TH2)
    e = np.array([np.cos(th), np.sin(th)])
    n = np.array([e[1], -e[0]])
    N = np.array(N2)
    E = np.array([864.0, N2[1] + (864.0 - N2[0]) * np.tan(th)])
    up = np.array([0, -w / abs(n[1])])  # towards the pillar (above the ribbon's upper edge)
    return [N, E, E + up, N + up]


def _poly(pts) -> str:
    return "M" + "L".join(f"{f(a)} {f(b)}" for a, b in (T(*p) for p in pts)) + "Z"


def mono_paths() -> tuple[str, str]:
    """(silhouette-with-fold-holes, fold-shapes) path data, 1000-unit space."""
    folds = _poly(wedge_left()) + _poly(wedge_right())
    return PATH + folds, folds


def mark_mono() -> str:
    d, folds = mono_paths()
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VBW} {VBH}" role="img" aria-labelledby="t">'
        '<title id="t">Nightshift</title>'
        f'<path fill="currentColor" fill-rule="evenodd" d="{d}"/>'
        f'<path fill="currentColor" fill-opacity="0.5" d="{folds}"/></svg>\n'
    )


def app_icon(size: int = 1024, frac: float = 0.55, rounded: bool = True, bg: str = "#000") -> str:
    """The mark on a black tile; `frac` is the mark's width as a share of the tile."""
    mw = size * frac
    k = mw / VBW
    x, y = (size - mw) / 2, (size - VBH * k) / 2
    defs, body = shaded_mark("#FAFAFA", "#000", 1.0, 0.03, "ns")
    rx = f' rx="{round(size * 0.2266)}"' if rounded else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" role="img" aria-labelledby="t">'
        f'<title id="t">Nightshift</title><defs>{defs}</defs>'
        f'<rect width="{size}" height="{size}"{rx} fill="{bg}"/>'
        f'<g transform="translate({x:.1f} {y:.1f}) scale({k:.4f})">{body}</g></svg>\n'
    )


def main() -> None:
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    (LOGO_DIR / "nightshift-mark.svg").write_text(mark_light_on_dark())
    (LOGO_DIR / "nightshift-mark-dark.svg").write_text(mark_dark_on_light())
    (LOGO_DIR / "nightshift-mark-mono.svg").write_text(mark_mono())
    # Maskable-safe: the mark's half-diagonal stays inside the 40%-radius safe circle.
    (LOGO_DIR / "nightshift-app-icon.svg").write_text(app_icon(1024, 0.55, True))
    (LOGO_DIR / "nightshift-maskable.svg").write_text(app_icon(1024, 0.46, False))
    # iOS rounds the tile itself, so the touch icon is a full-bleed square.
    (LOGO_DIR / "nightshift-apple-touch.svg").write_text(app_icon(1024, 0.58, False))
    # Browser-tab composition: a bigger mark so it survives 16 px.
    (APP_DIR / "icon.svg").write_text(app_icon(512, 0.72, True))
    print("wrote", [p.name for p in sorted(LOGO_DIR.glob("*.svg"))], "+ app/icon.svg")


if __name__ == "__main__":
    main()
