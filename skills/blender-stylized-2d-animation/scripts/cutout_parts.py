#!/usr/bin/env python3
"""Cut an existing character drawing into rig parts WITHOUT redrawing anything.

    python cutout_parts.py spec.json OUT_DIR

Every visible output pixel is copied from the original art, so freckles, line
weight, highlights and small details survive by construction. The spec lists
the parts in priority order (the first polygon that contains a pixel wins):

{
  "image": "front.png",
  "background": {"tolerance": 14},
  "defringe": true,
  "parts": [
    {"name": "antenna_l", "poly": [[x, y], ...], "pivot": [x, y], "parent": "head", "z": 1},
    {"name": "thigh_l", "poly": [...], "pivot": [...], "parent": "torso", "z": 2,
     "extend": {"from_row": 586, "to_row": 520, "x": [766, 792]}}
  ]
}

Repair operations (all optional, applied in this order). They only write
pixels that are missing or hidden behind a part with a higher z at rest, so
the rest pose stays the same and the repairs only show when a joint moves.

"extend": {"from_row", "to_row", "x": [x0, x1]} (or a list of them) rebuilds
a vertical rod's hidden end (a thigh under the torso, or under the knee
ball) by repeating one clean row.

"sweep": {"from": [x, y], "to": [x, y], "half_width": n} slides a clean
cross-section along an axis at any angle (uniform rods only).

"rod": {"axis": [[x, y], [x, y]], "segments": [{"t0": a, "ext0": [lo, hi],
"tc": b, "extc": [lo, hi], ...}]} rebuilds a tapered rod between t0 and tc
(distance along the axis) from its clean cross-section at tc, scaled to the
outline extents (lo/hi = signed distance from the axis). Sampling is
bilinear, so edges stay smooth. Options per segment:
  "edge": ["lo"|"hi", n]  also re-ink n px on the side whose outline a cut
                          destroyed (dark pixels only, on visible pixels)
  "round_start": true     close the t0 end with a rounded, inked tip
  "replace": true         rebuild every pixel of the stretch (use only where
                          a part in front covers it at rest; confirm with
                          the rest-pose diff)
  "replace_above_luma": n replace only pixels at least this bright (a
                          neighbour's white highlight caught inside the cut)
  "src_t", "src_ext"      copy from a clean cross-section elsewhere on the
                          rod when the one at tc is damaged too
  "trim_only": true       only remove leftovers outside the outline
Use it when a cut ran along a rod's edge, or its end is hidden under a cap.

"complete": {"polys": [...], "edges": [[...]], "line_width": 3} draws the
part's hidden area (the torso under the arms, the top of a ball under a rod
tip) the way an artist would: "polys" is the part's true silhouette there,
filled by diffusing body colour (outline pixels excluded, so nothing
smears); "edges" is the measured contour, inked in the part's own outline
colour. Fill and ink are anti-aliased (4x supersampled), and the fill is
smoothed. "radial": [{"center": [x, y], "r": n}] completes a ball joint
instead: hidden pixels take the ball's own colour-by-radius profile, which
also continues its rim outline. "bleed": n lets the ink cover background
slivers within n px of a hidden pixel, so the rebuilt line is not clipped into
teeth by a tiny gap in the original.

"alt": {"above_deg": n, "ops": {...}} makes a second drawing of the part
(<name>__alt.png) with the given repair ops replacing the part's own. The
rig shows it instead of the first drawing whenever the joint is rotated more
than n degrees from rest. This is the cut-out "drawing swap": use it when no
single image is right both at rest and when raised (for example, a rod whose
top carries part of a shoulder drawing).

"underlay": {"z": n, "grow": 2} adds a patch (<name>__under.png): the
part's silhouette grown by a few pixels, in outline colour, attached to the
part but layered at z (behind the neighbour it rests against). It is fully
hidden at rest. When the part lifts away, it fills the hairline that would
open between the two outlines, so they read as touching. This is the studio
"patch articulation".

Top-level "skins": [{"name": "arm_r", "layers": ["forearm_r", "upper_arm_r__alt"],
"joints": ["upper_arm_r", "forearm_r"], "z": 8, "blend": 10}] flattens the
listed part images (back to front) into <name>__skin.png. The rig draws it on
a fine mesh that two bones bend at the second joint, blending over +/- "blend"
pixels, instead of the rigid planes of those parts. A bent joint then has no
seam at all. Use it for limbs; keep rigid planes for heads, bodies and props.
Optional "alt_layers" + "alt_above_deg" give the skin a second look that
cross-fades in above that angle of its first joint (the drawing swap).

"line_only": true (or a paper luma, e.g. 250) keeps only the drawn line of a
part: lighter pixels become transparent, darker ones the outline colour. Use
it for a line that is scaled or moved over other art (a lower lip), so it
carries no patch of paper with it. On "complete", "soft": false keeps the
fill fully opaque to its edge (use it under parts that sit inside a body,
such as eyes and a mouth), and "min_luma" sets which pixels may seed the fill.

"paint": {"polys": [...], "color": [r, g, b]} is the only op that invents
pixels: a flat fill (default: the outline colour), written only where a part
in front hides it at rest. Use it for something the drawing does not contain
and a moving part must reveal, such as the dark inside of a mouth behind the
lips. Say in the delivery notes that it is synthetic. With "anywhere": true
the fill is not limited to hidden pixels; pair it with the part's
"rest_scale": [sx, sy], which the rig applies as the part's size at rest. Paint
the shape at its largest and let the rig shrink it, because shrinking a
raster stays smooth and stretching it shows steps.

"defringe" (default true) removes the page-colour matte from outline rim
pixels: a rim pixel that was blended with the background becomes the outline
colour with partial alpha. Without it, a part moved over another part shows a
pale fringe.

Outputs: <name>.png (full-canvas RGBA), rig.json (pivots, parents, z, canvas
size) and review.png (each part tinted, unassigned foreground in magenta). A
non-zero "unassigned" count fails the review gate (exit code 1).
"""
import json
import math
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

TINTS = [(255, 99, 71), (60, 179, 113), (65, 105, 225), (238, 130, 238), (255, 215, 0), (0, 206, 209),
         (255, 140, 0), (154, 205, 50), (199, 21, 133), (70, 130, 180), (210, 105, 30), (123, 104, 238),
         (46, 139, 87), (220, 20, 60), (100, 149, 237), (218, 165, 32)]
SS = 4  # supersampling for anti-aliased fills and ink


def luma(c) -> int:
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000


def background_mask(img: Image.Image, tolerance: int) -> list[list[bool]]:
    """Flood-fill from the border: only background connected to the edge is removed,
    so white areas inside outlines (face screen, chest highlight) are kept."""
    w, h = img.size
    px = img.load()
    ref = px[0, 0]
    bg = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        q.extend([(x, 0), (x, h - 1)])
    for y in range(h):
        q.extend([(0, y), (w - 1, y)])
    while q:
        x, y = q.popleft()
        if not (0 <= x < w and 0 <= y < h) or bg[y][x]:
            continue
        p = px[x, y]
        if max(abs(p[i] - ref[i]) for i in range(3)) > tolerance:
            continue
        bg[y][x] = True
        q.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    return bg


def bilinear(px, w, h, x, y):
    """Premultiplied bilinear sample of an RGBA pixel access object."""
    x0, y0 = math.floor(x), math.floor(y)
    fx, fy = x - x0, y - y0
    acc = [0.0, 0.0, 0.0, 0.0]
    for xi, yi, wt in ((x0, y0, (1 - fx) * (1 - fy)), (x0 + 1, y0, fx * (1 - fy)),
                       (x0, y0 + 1, (1 - fx) * fy), (x0 + 1, y0 + 1, fx * fy)):
        if 0 <= xi < w and 0 <= yi < h and wt > 0:
            r, g, b, a = px[xi, yi]
            af = a / 255 * wt
            acc[0] += r * af; acc[1] += g * af; acc[2] += b * af; acc[3] += af
    if acc[3] < 1e-4:
        return (0, 0, 0, 0)
    return (round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(acc[3] * 255))


def coverage(size, draw_fn) -> Image.Image:
    """Draw at SS x and box-filter down: an anti-aliased 0..255 coverage mask."""
    w, h = size
    big = Image.new("L", (w * SS, h * SS), 0)
    draw_fn(ImageDraw.Draw(big), SS)
    return big.resize((w, h), Image.BOX)


def bleed_rgb(img: Image.Image, radius: int = 3) -> Image.Image:
    """Extend each part's colours into its transparent surroundings (alpha unchanged).

    Transparent pixels are stored as black. A renderer that filters straight-alpha
    textures blends that black into the part's edge, which shows as a thin grey line
    wherever a light part sits on a light part. With the colours extended, the edge
    blends with its own colour instead.
    """
    under = Image.new("RGBA", img.size, (0, 0, 0, 0))
    solid = Image.merge("RGBA", (*img.split()[:3], img.getchannel("A").point(lambda v: 255 if v > 0 else 0)))
    for r in range(radius, 0, -1):                       # far first, near last: nearest colour wins
        for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r), (r, r), (-r, -r), (r, -r), (-r, r)):
            shifted = Image.new("RGBA", img.size, (0, 0, 0, 0))
            shifted.paste(solid, (dx, dy))
            under.alpha_composite(shifted)
    under.alpha_composite(solid)
    return Image.merge("RGBA", (*under.split()[:3], img.getchannel("A")))


def main(spec_path: str, out_dir: str) -> int:
    spec_file = Path(spec_path)
    spec = json.loads(spec_file.read_text(encoding="utf-8"))
    img = Image.open((spec_file.parent / spec["image"]).resolve()).convert("RGB")
    w, h = img.size
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    bg = background_mask(img, spec.get("background", {}).get("tolerance", 14))
    bg_rgb = img.getpixel((0, 0))
    parts = spec["parts"]

    owner = [[-1] * w for _ in range(h)]
    masks = []
    for part in parts:
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).polygon([tuple(p) for p in part["poly"]], fill=255)
        masks.append(m.load())
    for y in range(h):
        for x in range(w):
            if bg[y][x]:
                continue
            for i, m in enumerate(masks):
                if m[x, y]:
                    owner[y][x] = i
                    break

    src = img.load()
    review = img.convert("RGBA")
    rv = review.load()
    unassigned = 0
    rig = {"canvas": [w, h], "parts": []}

    def z_of(i):
        return parts[i].get("z", 0)

    for i, part in enumerate(parts):
        base_part = part
        variants = [(part["name"], part)]
        if part.get("alt"):   # a second drawing of the same part, swapped in by the rig above an angle
            variants.append((part["name"] + "__alt", {**part, **part["alt"]["ops"]}))
        for save_name, part in variants:
            my_z = part.get("z", 0)
            layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            lp = layer.load()
            count = 0
            for y in range(h):
                for x in range(w):
                    if owner[y][x] == i:
                        lp[x, y] = src[x, y] + (255,)
                        count += 1

            def hidden(x, y):
                o = owner[y][x]
                return o >= 0 and z_of(o) > my_z

            dark = sorted((lp[x, y][:3] for y in range(h) for x in range(w)
                           if lp[x, y][3] == 255 and luma(lp[x, y]) < 50), key=luma)
            ink = dark[len(dark) // 2] if dark else (12, 40, 58)

            # --- defringe: outline rim pixels blended with the page become ink with partial alpha
            if spec.get("defringe", True):
                lb, li = luma(bg_rgb), luma(ink)
                rim = []
                for y in range(h):
                    for x in range(w):
                        if owner[y][x] != i:
                            continue
                        nb = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
                        if not any(0 <= a < w and 0 <= b < h and bg[b][a] for a, b in nb):
                            continue
                        near_ink = any(0 <= a < w and 0 <= b < h and owner[b][a] == i and luma(src[a, b]) < 90
                                       for a in range(x - 2, x + 3) for b in range(y - 2, y + 3))
                        lc = luma(src[x, y])
                        if near_ink and lc > li + 25:
                            rim.append((x, y, max(0.0, min(1.0, (lb - lc) / max(lb - li, 1)))))
                for x, y, a in rim:
                    lp[x, y] = tuple(ink) + (round(a * 255),)

            # --- extend: repeat one clean row into hidden pixels (vertical rods)
            exts = part.get("extend") or []
            for ext in exts if isinstance(exts, list) else [exts]:
                x0, x1 = ext["x"]
                step = -1 if ext["to_row"] < ext["from_row"] else 1
                for y in range(ext["from_row"] + step, ext["to_row"] + step, step):
                    for x in range(x0, x1 + 1):
                        if lp[x, y][3] == 0 and lp[x, ext["from_row"]][3] > 0 and hidden(x, y):
                            lp[x, y] = lp[x, ext["from_row"]]

            # --- sweep: slide a clean cross-section along an axis (uniform rods)
            sweep = part.get("sweep")
            if sweep:
                (fx, fy), (tx, ty), hw = sweep["from"], sweep["to"], sweep["half_width"]
                L = math.hypot(tx - fx, ty - fy)
                dx_, dy_ = (tx - fx) / L, (ty - fy) / L
                nx_, ny_ = -dy_, dx_
                t = 0.0
                while t <= L:
                    s_ = -hw
                    while s_ <= hw:
                        sx, sy = round(fx + nx_ * s_), round(fy + ny_ * s_)
                        qx, qy = round(fx + dx_ * t + nx_ * s_), round(fy + dy_ * t + ny_ * s_)
                        if 0 <= qx < w and 0 <= qy < h and lp[qx, qy][3] == 0 and lp[sx, sy][3] == 255 and hidden(qx, qy):
                            lp[qx, qy] = lp[sx, sy]
                        s_ += 0.5
                    t += 0.5

            # --- rod: rebuild a tapered rod from a clean cross-section (bilinear, anti-aliased)
            rod = part.get("rod")
            if rod:
                (ax, ay), (bx, by) = rod["axis"]
                L = math.hypot(bx - ax, by - ay)
                dx_, dy_ = (bx - ax) / L, (by - ay) / L
                nx_, ny_ = -dy_, dx_
                rsrc = layer.copy().load()
                for seg in rod["segments"]:
                    t0, tc = seg["t0"], seg["tc"]
                    (lo0, hi0), (loc, hic) = seg["ext0"], seg["extc"]
                    r0 = (hi0 - lo0) / 2
                    side, band = seg.get("edge", [None, 0])

                    def ext(t):
                        k = (t - t0) / (tc - t0)
                        lo, hi = lo0 + (loc - lo0) * k, hi0 + (hic - hi0) * k
                        if seg.get("round_start") and t < t0 + r0:      # rounded tip: shrink toward the centre line
                            f = math.sqrt(max(0.0, 1 - ((t0 + r0 - t) / r0) ** 2))
                            c, half = (lo + hi) / 2, (hi - lo) / 2 * f
                            lo, hi = c - half, c + half
                        return lo, hi

                    for y in range(h):
                        for x in range(w):
                            t = (x - ax) * dx_ + (y - ay) * dy_
                            if not t0 <= t < tc:
                                continue
                            s_ = (x - ax) * nx_ + (y - ay) * ny_
                            lo, hi = ext(t)
                            outside = s_ < lo - 1.0 or s_ > hi + 1.0 or hi - lo < 0.5
                            if outside:
                                if lp[x, y][3] and owner[y][x] in (i, -1) or (lp[x, y][3] and hidden(x, y)):
                                    lp[x, y] = (0, 0, 0, 0)             # leftovers outside the true outline
                                continue
                            if seg.get("trim_only"):
                                continue
                            u = (s_ - lo) / (hi - lo)
                            if not 0.0 <= u <= 1.0:                     # never sample past the clean cross-section:
                                if lp[x, y][3] and (owner[y][x] in (i, -1) or hidden(x, y)):
                                    lp[x, y] = (0, 0, 0, 0)             # whatever lies beyond it is a neighbour's stray pixel
                                continue
                            st = seg.get("src_t", tc)                   # clean cross-section to copy from
                            slo, shi = seg.get("src_ext", (loc, hic))
                            ss = slo + u * (shi - slo)
                            c = bilinear(rsrc, w, h, ax + dx_ * st + nx_ * ss, ay + dy_ * st + ny_ * ss)
                            if c[3] == 0:
                                continue
                            missing = lp[x, y][3] == 0 or hidden(x, y)
                            on_edge = (side == "lo" and s_ - lo < band) or (side == "hi" and hi - s_ < band)
                            stray = "replace_above_luma" in seg and luma(lp[x, y]) >= seg["replace_above_luma"]
                            if missing or seg.get("replace") or stray or (on_edge and luma(c) < seg.get("edge_max_luma", 200)):
                                lp[x, y] = c

            # --- complete: body colour + inked contour for hidden areas (anti-aliased)
            comp = part.get("complete")
            for ball in (comp or {}).get("radial", []):                 # a ball: shade hidden pixels by its own radius profile
                (cx_, cy_), R = ball["center"], ball["r"]
                bins = {}
                for y in range(max(0, int(cy_ - R - 2)), min(h, int(cy_ + R + 3))):
                    for x in range(max(0, int(cx_ - R - 2)), min(w, int(cx_ + R + 3))):
                        d = math.hypot(x - cx_, y - cy_)
                        if d <= R + 1.5 and owner[y][x] == i and lp[x, y][3] > 0:
                            bins.setdefault(round(d), []).append(lp[x, y])
                prof = {k: tuple(sum(c[j] for c in v) // len(v) for j in range(4)) for k, v in bins.items()}
                if not prof:
                    continue
                for y in range(max(0, int(cy_ - R - 2)), min(h, int(cy_ + R + 3))):
                    for x in range(max(0, int(cx_ - R - 2)), min(w, int(cx_ + R + 3))):
                        d = math.hypot(x - cx_, y - cy_)
                        if d <= R + 1.5 and lp[x, y][3] == 0 and hidden(x, y):
                            lp[x, y] = prof[min(prof, key=lambda k: abs(k - d))]
            if comp and comp.get("polys"):
                sil = coverage((w, h), lambda d, k: [d.polygon([(px_ * k, py_ * k) for px_, py_ in poly], fill=255)
                                                     for poly in comp["polys"]]).load()
                grow = comp.get("grow", 0)   # also fill hidden pixels this close to the silhouette: no ring of holes at its edge

                def in_sil(x, y):
                    if sil[x, y]:
                        return True
                    return any(0 <= x + dx < w and 0 <= y + dy < h and sil[x + dx, y + dy]
                               for dx in range(-grow, grow + 1) for dy in range(-grow, grow + 1))

                todo = {(x, y) for y in range(h) for x in range(w) if lp[x, y][3] == 0 and hidden(x, y) and in_sil(x, y)}
                filled = set(todo)
                while todo:  # diffuse body colour only (outline pixels excluded, so nothing smears)
                    ready = []
                    for x, y in todo:
                        nb = [lp[nx, ny] for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                              if 0 <= nx < w and 0 <= ny < h and lp[nx, ny][3] == 255
                              and luma(lp[nx, ny]) >= comp.get("min_luma", 90)]
                        if nb:
                            ready.append((x, y, tuple(sum(c[j] for c in nb) // len(nb) for j in range(3)) + (255,)))
                    if not ready:
                        break
                    for x, y, c in ready:
                        lp[x, y] = c
                        todo.discard((x, y))
                for _ in range(comp.get("smooth", 8)):                  # diffusion streaks -> smooth shading
                    upd = []
                    for x, y in filled:
                        if lp[x, y][3] == 0:
                            continue
                        nb = [lp[nx, ny] for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1), (x, y))
                              if 0 <= nx < w and 0 <= ny < h and lp[nx, ny][3] == 255
                              and ((nx, ny) in filled or luma(lp[nx, ny]) >= comp.get("min_luma", 90))]
                        if nb:
                            upd.append((x, y, tuple(sum(c[j] for c in nb) // len(nb) for j in range(3)) + (255,)))
                    for x, y, c in upd:
                        lp[x, y] = c
                for x, y in filled:                                     # soft silhouette edge
                    if comp.get("soft", True) and lp[x, y][3] and sil[x, y] < 255:
                        lp[x, y] = lp[x, y][:3] + (sil[x, y],)
                lw = comp.get("line_width", 3)
                stroke = coverage((w, h), lambda d, k: [d.line([(px_ * k, py_ * k) for px_, py_ in edge], fill=255,
                                                               width=round(lw * k), joint="curve")
                                                        for edge in comp.get("edges", [])]).load()
                bleed = comp.get("bleed", 0)   # also ink background slivers this close to a hidden pixel

                def inkable(x, y):
                    if hidden(x, y):
                        return True
                    return bool(bleed) and bg[y][x] and any(
                        0 <= x + dx < w and 0 <= y + dy < h and hidden(x + dx, y + dy)
                        for dx in range(-bleed, bleed + 1) for dy in range(-bleed, bleed + 1))

                for y in range(h):
                    for x in range(w):
                        cv = stroke[x, y]
                        if cv and inkable(x, y):
                            r, g, b, a = lp[x, y]
                            f = cv / 255
                            if a == 0:
                                lp[x, y] = tuple(ink) + (cv,)
                            else:
                                lp[x, y] = (round(ink[0] * f + r * (1 - f)), round(ink[1] * f + g * (1 - f)),
                                            round(ink[2] * f + b * (1 - f)), max(a, cv))

            if part.get("line_only"):   # keep only the drawn line: paper-coloured pixels become transparent
                paper = luma(bg_rgb) if part["line_only"] is True else part["line_only"]
                li_ = luma(ink)
                for y in range(h):
                    for x in range(w):
                        if lp[x, y][3]:
                            a_ = max(0.0, min(1.0, (paper - luma(lp[x, y])) / max(paper - li_, 1)))
                            lp[x, y] = tuple(ink) + (round(a_ * lp[x, y][3]),)
            paint = part.get("paint")
            if paint:   # the one place new pixels are invented: a flat fill that something in front hides at rest
                col = tuple(paint["color"]) if isinstance(paint.get("color"), list) else tuple(ink)
                cov = coverage((w, h), lambda d, k: [d.polygon([(px_ * k, py_ * k) for px_, py_ in poly], fill=255)
                                                     for poly in paint["polys"]]).load()
                for y in range(h):
                    for x in range(w):
                        if cov[x, y] and (paint.get("anywhere") or hidden(x, y)):
                            lp[x, y] = col + (cov[x, y],)
            bleed_rgb(layer).save(out / f"{save_name}.png")
        part = base_part
        und = part.get("underlay")
        if und:   # patch articulation: an ink strip that follows this part but sits BEHIND its neighbour
            base_img = Image.open(out / f"{part['name']}.png").load()
            g = und.get("grow", 2)
            clear = und.get("clear", 2)    # how far the patch stays from soft rim pixels (it shows through them)
            patch = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            pp = patch.load()
            n_under = 0
            for y in range(h):
                for x in range(w):
                    o = owner[y][x]
                    if o < 0 or z_of(o) <= und["z"]:
                        continue          # keep only what something in front hides at rest: the rest pose cannot change
                    if any(not (0 <= x + dx < w and 0 <= y + dy < h) or owner[y + dy][x + dx] < 0
                           or z_of(owner[y + dy][x + dx]) <= und["z"]
                           for dx in (-clear, 0, clear) for dy in (-clear, 0, clear)):
                        continue          # stay clear of soft rim pixels, which would let the patch show through
                    if any(0 <= x + dx < w and 0 <= y + dy < h and base_img[x + dx, y + dy][3] > 128
                           for dx in range(-g, g + 1) for dy in range(-g, g + 1) if dx * dx + dy * dy <= g * g + 1):
                        pp[x, y] = tuple(ink) + (255,)
                        n_under += 1
            ub = und.get("bleed", 0)          # also cover hairlines of page colour this close to the patch
            if ub:
                add = [(x, y) for y in range(h) for x in range(w)
                       if bg[y][x] and not pp[x, y][3] and any(
                           0 <= x + dx < w and 0 <= y + dy < h and pp[x + dx, y + dy][3]
                           for dx in range(-ub, ub + 1) for dy in range(-ub, ub + 1))
                       and sum(1 for dx in (-3, 0, 3) for dy in (-3, 0, 3)
                               if 0 <= x + dx < w and 0 <= y + dy < h and not bg[y + dy][x + dx]) >= 5]
                for x, y in add:               # only slivers enclosed by the figure, never open background
                    pp[x, y] = tuple(ink) + (255,)
            from PIL import ImageFilter                              # smooth the outline: drop spikes thinner than 3 px
            alpha = patch.getchannel("A").filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
            alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
            keep = alpha.load()
            n_under = 0
            for y in range(h):
                for x in range(w):
                    if pp[x, y][3] and not keep[x, y]:
                        pp[x, y] = (0, 0, 0, 0)
                    elif pp[x, y][3]:
                        n_under += 1
            bleed_rgb(patch).save(out / f"{part['name']}__under.png")
            rig["parts"].append({"name": part["name"] + "__under", "pivot": part["pivot"], "parent": part["name"],
                                 "z": und["z"], "pixels": n_under, "follows_base_of": part["name"]})
        t = TINTS[i % len(TINTS)]
        for y in range(h):
            for x in range(w):
                if owner[y][x] == i:
                    r, g, b, a = rv[x, y]
                    rv[x, y] = ((r + t[0]) // 2, (g + t[1]) // 2, (b + t[2]) // 2, 255)
        entry = {k: part[k] for k in ("name", "pivot", "parent", "z", "rest_scale") if k in part} | {"pixels": count}
        if part.get("alt"):
            entry["alt_above_deg"] = part["alt"]["above_deg"]
        rig["parts"].append(entry)

    for skin in spec.get("skins", []):   # a limb bent by bones: its layers flattened into one image, back to front
        img_s = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        for layer_name in skin["layers"]:
            img_s.alpha_composite(Image.open(out / f"{layer_name}.png"))
        bleed_rgb(img_s).save(out / f"{skin['name']}__skin.png")
        if skin.get("alt_layers"):         # a second look for raised angles (drawing swap on the skin)
            img_a = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            for layer_name in skin["alt_layers"]:
                img_a.alpha_composite(Image.open(out / f"{layer_name}.png"))
            bleed_rgb(img_a).save(out / f"{skin['name']}__skin_alt.png")
            bb_a, bb_s = img_a.getbbox(), img_s.getbbox()
            img_s_bbox = [min(bb_a[0], bb_s[0]), min(bb_a[1], bb_s[1]), max(bb_a[2], bb_s[2]), max(bb_a[3], bb_s[3])]
        else:
            img_s_bbox = list(img_s.getbbox())
        entry = {k: skin[k] for k in ("name", "joints", "layers", "z", "alt_layers", "alt_above_deg") if k in skin}
        entry.update(bbox=img_s_bbox, blend=skin.get("blend", 10), grid=skin.get("grid", 4),
                     fade_under=skin.get("fade_under"))
        rig.setdefault("skins", []).append(entry)

    for y in range(h):
        for x in range(w):
            if not bg[y][x] and owner[y][x] == -1:
                rv[x, y] = (255, 0, 255, 255)
                unassigned += 1
    d = ImageDraw.Draw(review)
    for part in parts:
        px_, py_ = part["pivot"]
        d.ellipse([px_ - 4, py_ - 4, px_ + 4, py_ + 4], outline=(0, 0, 0), width=2)
    review.save(out / "review.png")
    rig["unassigned_pixels"] = unassigned
    (out / "rig.json").write_text(json.dumps(rig, indent=2), encoding="utf-8")
    print(json.dumps({"parts": [(p["name"], p["pixels"]) for p in rig["parts"]], "unassigned": unassigned}))
    return 1 if unassigned else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
