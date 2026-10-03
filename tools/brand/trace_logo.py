#!/usr/bin/env python3
"""Trace the owner-supplied Nightshift N (a raster) into a clean vector outline.

    python3 tools/brand/trace_logo.py [artwork.png]

Needs numpy, pillow, scipy and scikit-image (a throwaway venv is fine; this is a
one-off provenance tool, not part of the app or CI). Prints the outline in
artwork pixel space, which is what TRACE_PATH in tools/brand/build_logo.py holds,
and the silhouette fidelity of a re-render against the artwork.

Method
  1. Sub-pixel contour of the white shape at the 50% level (marching squares on
     a lightly blurred copy), resampled to ~1 px steps.
  2. Straight runs found from the contour's local turning angle, each fitted as
     a total-least-squares line; vertical runs snapped to exactly vertical.
  3. Between two lines: a sharp corner is their intersection (the two fold
     notches); a small tip is a circular fillet of fitted radius; a large turn
     is a least-squares cubic Bezier with the neighbouring lines' directions as
     end tangents (split in two where one cubic is off by more than 0.45 px).
Result: 8 lines + 2 fillets + 4 turns of two cubics = 18 segments.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.optimize import minimize
from scipy.spatial import cKDTree
from skimage import measure

DEFAULT = Path(__file__).resolve().parents[2] / "command-center/brand/logo/source/owner-supplied-N-1254.png"
KINDS = ["sharp", "tip", "curve", "curve", "sharp", "tip", "curve", "curve"]  # gap after line i
R_TIP = 5.75  # fitted fillet radius of the two pillar tips, px


def contour(gray: np.ndarray) -> np.ndarray:
    c = max(measure.find_contours(gaussian_filter(gray, 0.7), 128), key=len)[:, ::-1]
    seg = np.hypot(*np.diff(np.vstack([c, c[:1]]), axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    m = int(s[-1])
    t = np.linspace(0, s[-1], m, endpoint=False)
    cc = np.vstack([c, c[:1]])
    return np.c_[np.interp(t, s, cc[:, 0]), np.interp(t, s, cc[:, 1])]


def straight_runs(P: np.ndarray):
    m = len(P)
    sm = lambda v, k: np.convolve(np.r_[v[-k:], v, v[:k]], np.ones(2 * k + 1) / (2 * k + 1), "valid")
    sx, sy = sm(P[:, 0], 3), sm(P[:, 1], 3)
    w = 8
    ang = np.degrees(np.arctan2(np.roll(sy, -w) - np.roll(sy, w), np.roll(sx, -w) - np.roll(sx, w)))
    da = (np.roll(ang, -4) - np.roll(ang, 4) + 180) % 360 - 180
    straight = np.abs(da) < 0.9
    start = int(np.argmin(straight))
    idx = (np.arange(m) + start) % m
    st = straight[idx]
    runs, cur = [], None
    for k in range(m):
        if st[k] and cur is None:
            cur = k
        if not st[k] and cur is not None:
            runs.append((cur, k - 1))
            cur = None
    if cur is not None:
        runs.append((cur, m - 1))
    lines = []
    for a, b in runs:
        if b - a < 18:
            continue
        pts = P[idx[a + 4 : b - 3]]
        mean = pts.mean(0)
        d = np.linalg.svd(pts - mean)[2][0]
        if np.dot(d, pts[-1] - pts[0]) < 0:
            d = -d
        if abs(abs(np.degrees(np.arctan2(d[1], d[0]))) - 90) < 0.3:  # snap verticals
            d = np.array([0.0, 1.0 if d[1] > 0 else -1.0])
        lines.append(dict(a=a, b=b, m=mean, d=d, start=P[idx[a]], end=P[idx[b]]))
    lines.sort(key=lambda l: l["a"])
    return lines, idx


proj = lambda l, p: l["m"] + l["d"] * np.dot(p - l["m"], l["d"])


def isect(l1, l2):
    t = np.linalg.solve(np.array([l1["d"], -l2["d"]]).T, l2["m"] - l1["m"])
    return l1["m"] + l1["d"] * t[0]


def bez(p0, p1, p2, p3, n=120):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def dist(pts, curve):
    return cKDTree(curve).query(pts)[0]


def fit1(pts, p0, p3, t0, t3):
    L = np.linalg.norm(p3 - p0)
    cost = lambda h: np.mean(dist(pts, bez(p0, p0 + t0 * abs(h[0]), p3 - t3 * abs(h[1]), p3)) ** 2)
    best = min((minimize(cost, [L * a, L * a], method="Nelder-Mead", options=dict(xatol=1e-3, fatol=1e-8, maxiter=2000)) for a in (0.2, 0.4, 0.6)), key=lambda r: r.fun)
    h = np.abs(best.x)
    c = (p0, p0 + t0 * h[0], p3 - t3 * h[1], p3)
    return c, dist(pts, bez(*c, 200)).max()


def fit2(pts, p0, p3, t0, t3):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    k = int(np.searchsorted(d, d[-1] / 2))
    pm = pts[k]
    tg = pts[min(k + 5, len(pts) - 1)] - pts[max(k - 5, 0)]
    ang0 = np.arctan2(tg[1], tg[0])

    def build(v):
        tm = np.array([np.cos(v[0]), np.sin(v[0])])
        h = np.abs(v[1:5])
        return (p0, p0 + t0 * h[0], pm - tm * h[1], pm), (pm, pm + tm * h[2], p3 - t3 * h[3], p3)

    cost = lambda v: np.mean(dist(pts, np.vstack([bez(*c) for c in build(v)])) ** 2)
    L = np.linalg.norm(p3 - p0)
    # v[5] is inert; it is kept because dropping it changes which minimum the
    # simplex settles in, and the committed outline was fitted with it.
    best = min((minimize(cost, [ang0, L * a, L * a, L * a, L * a, 0], method="Nelder-Mead", options=dict(xatol=1e-3, fatol=1e-9, maxiter=6000)) for a in (0.15, 0.25, 0.35)), key=lambda r: r.fun)
    cs = build(best.x)
    return list(cs), dist(pts, np.vstack([bez(*c, 200) for c in cs])).max()


def fillet(li, lj, r):
    v = isect(li, lj)
    th = np.arccos(np.clip(np.dot(li["d"], lj["d"]), -1, 1))
    k = r * np.tan(th / 2)
    p0, p3 = v - li["d"] * k, v + lj["d"] * k
    h = 4 / 3 * np.tan(th / 4) * r
    return p0, p0 + li["d"] * h, p3 - lj["d"] * h, p3


def trace(gray: np.ndarray) -> str:
    P = contour(gray)
    m = len(P)
    lines, idx = straight_runs(P)
    assert len(lines) == 8, f"expected 8 straight runs, found {len(lines)}"
    ends = [[proj(l, l["start"]), proj(l, l["end"])] for l in lines]
    segs = {}
    for i in range(8):
        j = (i + 1) % 8
        if KINDS[i] == "sharp":
            q = isect(lines[i], lines[j])
            ends[i][1], ends[j][0] = q, q
        elif KINDS[i] == "tip":
            p0, c1, c2, p3 = fillet(lines[i], lines[j], R_TIP)
            ends[i][1], ends[j][0] = p0, p3
            segs[i] = [(p0, c1, c2, p3)]
    for i in range(8):
        if KINDS[i] != "curve":
            continue
        j = (i + 1) % 8
        a, b = lines[i]["b"], lines[j]["a"] + (m if j == 0 else 0)
        pts = P[[idx[k % m] for k in range(a, b + 1)]]
        cs, e = fit1(pts, ends[i][1], ends[j][0], lines[i]["d"], lines[j]["d"])
        segs[i] = [cs]
        if e > 0.45:
            segs[i], e = fit2(pts, ends[i][1], ends[j][0], lines[i]["d"], lines[j]["d"])
    pt = lambda p: f"{p[0]:.1f} {p[1]:.1f}"
    d = ["M" + pt(ends[0][0])]
    for i in range(8):
        d.append("L" + pt(ends[i][1]))
        for c in segs.get(i, []):
            d.append("C" + " ".join(pt(p) for p in c[1:]))
    return " ".join(d + ["Z"])


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    gray = np.array(Image.open(src).convert("L")).astype(float)
    print(trace(gray))


if __name__ == "__main__":
    main()
