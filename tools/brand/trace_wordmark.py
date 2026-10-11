#!/usr/bin/env python3
"""Trace the owner-supplied NIGHTSHIFT lettering (a raster) into a clean vector.

    python3 tools/brand/trace_wordmark.py [lockup.png]

Needs numpy, pillow, scipy and scikit-image (a throwaway venv is fine; this is a
one-off provenance tool, not part of the app or CI). Reads
command-center/brand/logo/source/owner-supplied-wordmark-1842.png and writes

  command-center/brand/logo/nightshift-wordmark.svg   the ten letters, currentColor
  command-center/components/site/wordmarkArt.ts       the same path for the inline lockup

Method (the same family as tools/brand/trace_logo.py, for a drawing made of
straight stems and rounded turns)
  1. Sub-pixel contour of each letter at the 50% level (marching squares on a
     lightly blurred copy), resampled to 0.5 px steps.
  2. Ramer-Douglas-Peucker at 0.25 px finds the long straight sides; each is
     refitted as a total-least-squares line. A side within 0.7 degrees of
     horizontal or vertical is snapped to exactly that, and the horizontal sides
     that sit on the cap line or the baseline are snapped to one shared value, so
     the ten letters share a flat top and a flat foot.
  3. Between two lines the contour (a rounded corner or a large turn) is a
     least-squares cubic Bezier whose end tangents are the neighbouring lines'
     directions, split where one cubic is off by more than 0.35 px.
Prints the silhouette fidelity of a re-render against the artwork.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
from skimage import measure

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "command-center/brand/logo/source/owner-supplied-wordmark-1842.png"
OUT_SVG = REPO / "command-center/brand/logo/nightshift-wordmark.svg"
OUT_TS = REPO / "command-center/components/site/wordmarkArt.ts"
CROP = (545, 340, 1610, 500)  # the lettering in the 1842 x 854 lockup (left, top, right, bottom)
STEP = 0.5
RDP_EPS = 0.25
MIN_LINE = 12.0  # px: shorter straight sides are left to the Bezier fits
SPLIT_ERR = 0.35
AXIS_SNAP = 0.7  # degrees


def contours(gray: np.ndarray) -> list[np.ndarray]:
    out = []
    for c in measure.find_contours(gaussian_filter(gray, 0.7), 128):
        if len(c) < 60:
            continue
        c = c[:, ::-1]
        cc = np.vstack([c, c[:1]])
        seg = np.hypot(*np.diff(cc, axis=0).T)
        s = np.r_[0, np.cumsum(seg)]
        t = np.arange(0, s[-1], STEP)
        out.append(np.c_[np.interp(t, s, cc[:, 0]), np.interp(t, s, cc[:, 1])])
    return sorted(out, key=lambda p: p[:, 0].min())


def rdp(P: np.ndarray, eps: float) -> list[int]:
    keep = {0, len(P) - 1}
    stack = [(0, len(P) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        d = P[b] - P[a]
        n = np.hypot(*d) or 1.0
        dist = np.abs(d[0] * (P[a + 1 : b, 1] - P[a, 1]) - d[1] * (P[a + 1 : b, 0] - P[a, 0])) / n
        k = int(np.argmax(dist))
        if dist[k] > eps:
            m = a + 1 + k
            keep.add(m)
            stack += [(a, m), (m, b)]
    return sorted(keep)


def rdp_closed(P: np.ndarray, eps: float) -> list[int]:
    """RDP of a closed polyline (P[0] == P[-1]): split at the point farthest from the start."""
    far = int(np.argmax(((P - P[0]) ** 2).sum(1)))
    return sorted(set(rdp(P[: far + 1], eps)) | {far + i for i in rdp(P[far:], eps)})


def tls_line(pts: np.ndarray):
    mean = pts.mean(0)
    d = np.linalg.svd(pts - mean)[2][0]
    return mean, d


def bez(p0, p1, p2, p3, t):
    t = t[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def fit_cubic(pts, p0, p3, tA, tB):
    """Cubic from p0 to p3 with end tangent directions tA (leaving) and tB (arriving)."""
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    u = d / d[-1]
    a_len = b_len = np.hypot(*(p3 - p0)) / 3
    for _ in range(6):
        b0, b1, b2, b3 = (1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u**2, u**3
        base = np.outer(b0 + b1, p0) + np.outer(b2 + b3, p3)
        r = pts - base
        A1 = np.outer(b1, tA)
        A2 = np.outer(b2, -tB)
        m = np.array([[(A1 * A1).sum(), (A1 * A2).sum()], [(A1 * A2).sum(), (A2 * A2).sum()]])
        v = np.array([(A1 * r).sum(), (A2 * r).sum()])
        try:
            a_len, b_len = np.linalg.solve(m, v)
        except np.linalg.LinAlgError:
            break
        a_len, b_len = max(a_len, 0.05), max(b_len, 0.05)
        # re-parametrise: nearest point on the curve
        tt = np.linspace(0, 1, 200)
        curve = bez(p0, p0 + a_len * tA, p3 - b_len * tB, p3, tt)
        idx = np.argmin(((pts[:, None, :] - curve[None]) ** 2).sum(-1), axis=1)
        u = tt[idx]
    p1, p2 = p0 + a_len * tA, p3 - b_len * tB
    curve = bez(p0, p1, p2, p3, np.linspace(0, 1, 200))
    err = np.sqrt(((pts[:, None, :] - curve[None]) ** 2).sum(-1).min(1))
    return (p1, p2), err


def fit_gap(pts, p0, p3, tA, tB, out):
    """Append cubic segments from p0 to p3 following pts; split where one is not close enough."""
    if len(pts) < 3:
        pts = np.vstack([p0, (p0 + p3) / 2, p3])
    pts = np.vstack([p0, pts, p3])
    (p1, p2), err = fit_cubic(pts, p0, p3, tA, tB)
    if err.max() <= SPLIT_ERR or len(pts) < 12:
        out.append(("C", p1, p2, p3))
        return
    k = int(np.clip(np.argmax(err), 4, len(pts) - 5))
    mid = pts[k]
    tm = pts[k + 3] - pts[k - 3]
    tm = tm / np.hypot(*tm)
    fit_gap(pts[1 : k], p0, mid, tA, tm, out)
    fit_gap(pts[k + 1 : -1], mid, p3, tm, tB, out)


def fit_fillet(gap, L, N, k_fixed=None):
    """A short turn between two lines: a circular-fillet cubic whose tangent points sit k from their
    intersection; k is the one that follows the contour best (or k_fixed). None when the lines do not
    meet. Returns (tangent point in, segment, tangent point out, k, mean error, turn sign)."""
    cross = L["d"][0] * N["d"][1] - L["d"][1] * N["d"][0]
    if abs(cross) < 0.1:
        return None
    ip = intersect(L["mean"], L["d"], N["mean"], N["d"])
    theta = np.arccos(np.clip(np.dot(L["d"], N["d"]), -1, 1))
    ratio = (4 / 3) * np.tan(theta / 4) / np.tan(theta / 2)
    t = np.linspace(0, 1, 60)

    def make(k):
        p0, p3 = ip - L["d"] * k, ip + N["d"] * k
        return p0, p3, bez(p0, p0 + L["d"] * k * ratio, p3 - N["d"] * k * ratio, p3, t)

    def err_of(k):
        curve = make(k)[2]
        return np.sqrt(((gap[:, None, :] - curve[None]) ** 2).sum(-1).min(1)).mean()

    k = k_fixed if k_fixed is not None else min(np.arange(0.3, 10, 0.05), key=err_of)
    p0, p3, _ = make(k)
    return p0, ("C", p0 + L["d"] * k * ratio, p3 - N["d"] * k * ratio, p3), p3, k, err_of(k), np.sign(cross)


def project(p, mean, d):
    return mean + d * np.dot(p - mean, d)


def intersect(m1, d1, m2, d2):
    A = np.array([d1, -d2]).T
    t = np.linalg.solve(A, m2 - m1)
    return m1 + d1 * t[0]


def turn_at(P, vi, k):
    a, b, c = P[vi[k - 1]], P[vi[k]], P[vi[(k + 1) % len(vi)]]
    u, v = b - a, c - b
    return abs(np.degrees(np.arctan2(u[0] * v[1] - u[1] * v[0], np.dot(u, v))))


def trace_letter(P: np.ndarray):
    """Lines (fitted straight sides) of one letter, in contour order, from a real corner."""
    P = np.vstack([P, P[:1]])
    vi = rdp_closed(P, RDP_EPS)[:-1]
    k = max(range(len(vi)), key=lambda k: turn_at(P, vi, k))
    P = np.roll(P[:-1], -vi[k], axis=0)
    P = np.vstack([P, P[:1]])
    vi = rdp_closed(P, RDP_EPS)
    lines = []
    for a, b in zip(vi[:-1], vi[1:]):
        if np.hypot(*(P[b] - P[a])) < MIN_LINE:
            continue
        pts = P[a : b + 1]
        mean, d = tls_line(pts[4:-4])
        if np.dot(d, P[b] - P[a]) < 0:
            d = -d
        ang = np.degrees(np.arctan2(d[1], d[0]))
        for axis_ang in (0.0, 90.0, -90.0, 180.0, -180.0):
            if abs(ang - axis_ang) < AXIS_SNAP:
                d = np.round(np.array([np.cos(np.radians(axis_ang)), np.sin(np.radians(axis_ang))]), 12)
        lines.append(dict(a=a, b=b, mean=mean, d=d))
    return P, lines


def build(P, lines, top, base):
    for L in lines:  # flat sides on the shared cap line / baseline take exactly that value
        if abs(L["d"][1]) < 1e-9:
            y = L["mean"][1]
            if abs(y - top) < 1.2:
                L["mean"] = np.array([L["mean"][0], top])
            elif abs(y - base) < 1.2:
                L["mean"] = np.array([L["mean"][0], base])
    n = len(lines)
    for i, L in enumerate(lines):
        N = lines[(i + 1) % n]
        gap = P[L["b"] : N["a"] + 1] if i + 1 < n else np.vstack([P[L["b"] :], P[1 : N["a"] + 1]])
        e = project(P[L["b"]], L["mean"], L["d"])
        s = project(P[N["a"]], N["mean"], N["d"])
        L["gap"] = None
        if len(gap) <= 3 or np.hypot(*(s - e)) < 0.6:
            cross = abs(L["d"][0] * N["d"][1] - L["d"][1] * N["d"][0])
            if cross > 0.1:
                ip = intersect(L["mean"], L["d"], N["mean"], N["d"])
                if np.hypot(*(ip - e)) < 3.0 and np.hypot(*(ip - s)) < 3.0:
                    L["end"], N["start"] = ip, ip
                    continue
        L["end"], N["start"] = e, s
        L["gap"] = gap
    return lines


def to_path(letters, kmed=None, stats=None):
    ds = []
    allp = []
    for lines in letters:
        d = []
        n = len(lines)
        d.append(("M", lines[0]["start"]))
        for i, L in enumerate(lines):
            N = lines[(i + 1) % n]
            d.append(("L", L["end"]))
            allp.append(L["start"])
            allp.append(L["end"])
            if L["gap"] is not None:
                segs = []
                arc = np.hypot(*np.diff(L["gap"], axis=0).T).sum()
                axis = abs(L["d"][0] * N["d"][1] - L["d"][1] * N["d"][0]) > 0.999 and min(abs(L["d"])) < 1e-9
                # two flat/vertical sides meeting in a turn this short are a rounded corner. The artwork
                # draws them all with one radius (a flare in the contour there is its soft edge), so
                # the radius is the median of the well-fitted ones, per kind of turn
                fil = None
                if arc < 20:
                    sign = np.sign(L["d"][0] * N["d"][1] - L["d"][1] * N["d"][0])
                    fil = fit_fillet(L["gap"], L, N, k_fixed=kmed[sign] if (axis and kmed) else None)
                    if fil is not None and stats is not None and axis and fil[4] < 0.3:
                        stats.setdefault(fil[5], []).append(fil[3])
                    if fil is not None and fil[4] > 0.9 and not (axis and kmed):
                        fil = None
                if fil is not None:
                    d[-1] = ("L", fil[0])
                    d.append(fil[1])
                    allp += [fil[0], fil[2]]
                    N["start"] = fil[2]
                    continue
                fit_gap(L["gap"][1:-1], L["end"], N["start"], L["d"], N["d"], segs)
                for sg in segs:
                    d.append(sg)
                    allp += list(sg[1:])
        d[0] = ("M", lines[0]["start"])
        ds.append(d)
    return ds, np.array(allp)


def fmt(v: float) -> str:
    s = f"{v:.1f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def render_path(ds, ox, oy) -> str:
    out = []
    for d in ds:
        for seg in d:
            k = seg[0]
            pts = [(p[0] - ox, p[1] - oy) for p in seg[1:]]
            out.append(k + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts) if k != "C" else "C" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts))
        out.append("Z")
    return "".join(out)


def sample(ds, ox, oy, scale=8):
    """Polygons of the traced outline, for the fidelity check."""
    polys = []
    for d in ds:
        pts, cur = [], None
        for seg in d:
            k = seg[0]
            if k == "M":
                cur = seg[1]
                pts.append(cur)
            elif k == "L":
                cur = seg[1]
                pts.append(cur)
            else:
                t = np.linspace(0, 1, 24)[1:]
                pts += list(bez(cur, seg[1], seg[2], seg[3], t))
                cur = seg[3]
        polys.append([((x - ox) * scale, (y - oy) * scale) for x, y in pts])
    return polys


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC
    gray = np.array(Image.open(src).convert("L").crop(CROP), dtype=float)
    cs = contours(gray)
    assert len(cs) == 10, f"expected ten letters, found {len(cs)}"
    # shared cap line and baseline: the median of the letters' own flat tops and feet
    tops = np.array([c[:, 1].min() for c in cs])
    bases = np.array([c[:, 1].max() for c in cs])
    top, base = float(np.median(tops)), float(np.median(bases))
    letters = []
    for c in cs:
        P, lines = trace_letter(c)
        letters.append(build(P, lines, top, base))
    stats: dict = {}
    to_path(letters, None, stats)
    kmed = {sg: float(np.median(v)) for sg, v in stats.items()}
    ds, allp = to_path(letters, kmed)
    print('corner radius, tangent length per kind of turn:', {int(k): round(v, 2) for k, v in kmed.items()})
    edge = np.array([q for poly in sample(ds, 0, 0, 1) for q in poly])  # the drawn outline, not its control points
    ox = edge[:, 0].min()
    # shift so the cap line is exactly y = 0 and the left edge x = 0
    ox, oy = round(ox, 1), round(top, 1)
    W = round(edge[:, 0].max() - ox, 1)
    H = round(base - oy, 1)
    path = render_path(ds, ox, oy)

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(W)} {fmt(H)}" role="img" aria-labelledby="t">'
        f'<title id="t">Nightshift</title><path fill="currentColor" fill-rule="evenodd" d="{path}"/></svg>\n'
    )
    OUT_SVG.write_text(svg)
    OUT_TS.write_text(
        "// Generated by tools/brand/trace_wordmark.py from the owner's lettering; do not edit.\n"
        "// The ten letters of NIGHTSHIFT, one path, in a box whose height is the cap height.\n"
        f"export const WORDMARK_ART = {{\n  path: {path!r},\n  w: {fmt(W)},\n  h: {fmt(H)},\n}} as const;\n".replace("'", '"')
    )

    # fidelity: rasterise the traced outline at 8x in the artwork's own frame and compare silhouettes
    S = 8
    art = np.array(Image.fromarray(gray.astype(np.uint8)).resize((gray.shape[1] * S, gray.shape[0] * S), Image.BICUBIC)) > 128
    mask = Image.new("L", (art.shape[1], art.shape[0]), 0)
    dr = ImageDraw.Draw(mask)
    for poly in sample(ds, 0, 0, S):
        dr.polygon([(x + S / 2 - 0.5, y + S / 2 - 0.5) for x, y in poly], fill=255)  # pixel centres sit on integers
    m = np.array(mask) > 128
    iou = (m & art).sum() / (m | art).sum()
    print(f"{len(path)} bytes of path, viewBox 0 0 {fmt(W)} {fmt(H)}, silhouette IoU {iou:.4f} ({int((m ^ art).sum() / S / S)} px^2 differ)")


if __name__ == "__main__":
    main()
