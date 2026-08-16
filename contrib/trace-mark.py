"""Trace the SOZVON mark out of its raster master into an SVG outline.

The identity has no vector original: the mark exists as a rendered image.  A
redraw by eye is a different drawing -- the first attempt at one had the
handset a fifth too narrow and both capsules the same shape, which they are
not -- so the outline is recovered from the pixels instead.

The drawing is antialiased, and that is what makes this accurate: the grey
along an edge says where the edge really fell inside the pixel, so marching
squares along the half-intensity iso-line lands well under a pixel of the
truth.  Contours are then thinned with Douglas-Peucker and smoothed into cubic
Beziers through every kept point.

    python contrib/trace-mark.py <master.png> <component> <tolerance> <out.svg>

`component` selects one connected blob by size, largest first, so a mark drawn
alongside other artwork can still be lifted out of it; 0 is the largest.  A
tolerance of 0.6 pixels was what the current master used: tighter settings
gained nothing measurable and tripled the file.

Filled outlines rather than strokes on purpose: the master's line is not of
one width -- the shell is heavier than the inner highlight -- so no single
stroke width can reproduce it.  Filling is also what makes the result exact as
a CSS mask, where only the alpha channel counts.

Check the result rather than trusting it, and check it by ink coverage, not by
thresholding both sides: a boundary drawn at half intensity necessarily loses
a half-pixel rim against a binarised mask, which reads as a 10% error that is
not there.  The current master differs from its raster by 1.5% mean coverage.

Requires numpy, scipy and Pillow.  Feed the output to
contrib/build-mark-assets.py, which regenerates everything else.
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage


def component(path, keep):
    """The mask of one connected component, and the greyscale it came from."""
    g = np.array(Image.open(path).convert('L')).astype(float)
    lab, n = ndimage.label(g > 110)
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1] + 1
    idx = order[keep]
    return g * (lab == idx)


def contours(g, level=128.0):
    """Marching squares with linear interpolation; returns closed loops."""
    h, w = g.shape
    segs = {}

    def interp(p, q, vp, vq):
        t = (level - vp) / (vq - vp)
        return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)

    for y in range(h - 1):
        for x in range(w - 1):
            v = (g[y, x], g[y, x + 1], g[y + 1, x + 1], g[y + 1, x])
            case = (v[0] > level) | ((v[1] > level) << 1) | \
                   ((v[2] > level) << 2) | ((v[3] > level) << 3)
            if case == 0 or case == 15:
                continue
            c = [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]
            e = [None] * 4
            if (case >> 0 & 1) != (case >> 1 & 1):
                e[0] = interp(c[0], c[1], v[0], v[1])
            if (case >> 1 & 1) != (case >> 2 & 1):
                e[1] = interp(c[1], c[2], v[1], v[2])
            if (case >> 2 & 1) != (case >> 3 & 1):
                e[2] = interp(c[2], c[3], v[2], v[3])
            if (case >> 3 & 1) != (case >> 0 & 1):
                e[3] = interp(c[3], c[0], v[3], v[0])
            pts = [p for p in e if p is not None]
            # Ambiguous saddles (5, 10) produce four crossings; pairing them the
            # short way keeps the thin line connected instead of pinching it.
            if len(pts) == 4:
                pairs = [(pts[0], pts[3]), (pts[1], pts[2])]
            else:
                pairs = [(pts[0], pts[1])]
            for a, b in pairs:
                segs.setdefault(round2(a), []).append(round2(b))
                segs.setdefault(round2(b), []).append(round2(a))
    return chain(segs)


def round2(p):
    return (round(p[0], 4), round(p[1], 4))


def chain(segs):
    """Walk the segment graph into closed loops."""
    loops = []
    seen = set()
    for start in list(segs):
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        cur, prev = start, None
        while True:
            nxt = None
            for cand in segs.get(cur, ()):
                if cand != prev and cand not in seen:
                    nxt = cand
                    break
            if nxt is None:
                break
            loop.append(nxt)
            seen.add(nxt)
            prev, cur = cur, nxt
        if len(loop) > 8:
            loops.append(loop)
    return loops


def dp(points, eps):
    """Douglas-Peucker."""
    if len(points) < 3:
        return points
    a, b = np.array(points[0]), np.array(points[-1])
    ab = b - a
    n = np.hypot(*ab)
    pts = np.array(points)
    if n == 0:
        d = np.hypot(*(pts - a).T)
    else:
        rel = pts - a
        d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        return dp(points[:i + 1], eps)[:-1] + dp(points[i:], eps)
    return [points[0], points[-1]]


def bezier(loop):
    """Catmull-Rom through the points, as cubic Beziers: smooth and exact at
    every knot, which is what keeps the traced curve on the original edge."""
    p = loop[:]
    if p[0] != p[-1]:
        p.append(p[0])
    n = len(p) - 1
    out = [f'M{p[0][0]:.2f},{p[0][1]:.2f}']
    for i in range(n):
        p0 = p[(i - 1) % n]
        p1, p2 = p[i], p[i + 1]
        p3 = p[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        out.append(f'C{c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} '
                   f'{p2[0]:.2f},{p2[1]:.2f}')
    out.append('Z')
    return ''.join(out)


def main():
    src, keep, eps, out = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    g = component(src, keep)
    ys, xs = np.nonzero(g > 110)
    pad = 2
    y0, y1 = ys.min() - pad, ys.max() + pad
    x0, x1 = xs.min() - pad, xs.max() + pad
    g = g[y0:y1 + 1, x0:x1 + 1]
    loops = contours(g)
    loops.sort(key=len, reverse=True)
    paths = [bezier(dp(l, eps)) for l in loops]
    w, h = g.shape[1], g.shape[0]
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
           f'width="{w}" height="{h}">\n'
           f'  <path fill="#000" fill-rule="evenodd" d="{"".join(paths)}"/>\n'
           f'</svg>\n')
    open(out, 'w', encoding='utf-8').write(svg)
    print(f'{out}: {len(loops)} loops, '
          f'{sum(len(dp(l, eps)) for l in loops)} points, {len(svg)} bytes, '
          f'box {w}x{h}')


if __name__ == '__main__':
    main()
