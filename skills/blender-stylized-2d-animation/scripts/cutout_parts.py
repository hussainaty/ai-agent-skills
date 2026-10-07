#!/usr/bin/env python3
"""Cut an existing character drawing into rig parts WITHOUT redrawing anything.

    python cutout_parts.py spec.json OUT_DIR

Every output pixel is copied from the original art, so freckles, line weight,
highlights and small details survive by construction. The spec lists the
parts in priority order (first polygon that contains a pixel wins):

{
  "image": "front.png",
  "background": {"seeds": "border", "tolerance": 14},
  "parts": [
    {"name": "antenna_l", "poly": [[x, y], ...], "pivot": [x, y], "parent": "head", "z": 1},
    {"name": "thigh_l", "poly": [...], "pivot": [...], "parent": "torso", "z": 2,
     "extend": {"from_row": 586, "to_row": 520, "x": [766, 792]}}
  ]
}

"extend" rebuilds a part's hidden end (e.g. a thigh rod under the torso) by
repeating one clean row, so the joint never shows a gap when it rotates.
"sweep": {"from": [x, y], "to": [x, y], "half_width": n} does the same for a
rod at any angle: a clean cross-section at "from" slides along the axis to
"to" (e.g. the upper-arm rod under a fixed shoulder cap).
"complete": {"polys": [...], "edges": [[...]], "line_width": 3} draws the
part's HIDDEN area (covered by a part in front, e.g. the torso under the
shoulder caps) like an artist would: "polys" is the part's true silhouette
there, filled by diffusing body colour (outline pixels excluded, so nothing
smears), and "edges" is the measured contour, inked in the part's own outline
colour. Only hidden pixels are touched, so the rest pose stays identical.
It only fills pixels that a part with a higher z covers in the original,
so the rest pose is pixel-identical and the rebuilt end only shows when the
joint moves.

Outputs: <name>.png (full-canvas RGBA, original pixels), rig.json (pivots,
parents, z, canvas size) and review.png (each part tinted, unassigned
foreground in magenta). A non-zero "unassigned" count fails the review gate.
"""
import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

TINTS = [(255, 99, 71), (60, 179, 113), (65, 105, 225), (238, 130, 238), (255, 215, 0), (0, 206, 209),
         (255, 140, 0), (154, 205, 50), (199, 21, 133), (70, 130, 180), (210, 105, 30), (123, 104, 238),
         (46, 139, 87), (220, 20, 60), (100, 149, 237), (218, 165, 32)]


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


def main(spec_path: str, out_dir: str) -> int:
    spec_file = Path(spec_path)
    spec = json.loads(spec_file.read_text(encoding="utf-8"))
    img = Image.open((spec_file.parent / spec["image"]).resolve()).convert("RGB")
    w, h = img.size
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    bg = background_mask(img, spec.get("background", {}).get("tolerance", 14))

    owner = [[-1] * w for _ in range(h)]
    masks = []
    for part in spec["parts"]:
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
    for i, part in enumerate(spec["parts"]):
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        lp = layer.load()
        count = 0
        for y in range(h):
            for x in range(w):
                if owner[y][x] == i:
                    lp[x, y] = src[x, y] + (255,)
                    count += 1
        ext = part.get("extend")
        if ext:  # rebuild the hidden end from one clean row
            x0, x1 = ext["x"]
            step = -1 if ext["to_row"] < ext["from_row"] else 1
            my_z = part.get("z", 0)
            for y in range(ext["from_row"] + step, ext["to_row"] + step, step):
                for x in range(x0, x1 + 1):
                    o = owner[y][x]
                    covered = o >= 0 and spec["parts"][o].get("z", 0) > my_z
                    # only rebuild where a part in front hides it at rest, so the rest pose is unchanged
                    if lp[x, y][3] == 0 and lp[x, ext["from_row"]][3] == 255 and covered:
                        lp[x, y] = lp[x, ext["from_row"]]
        sweep = part.get("sweep")
        if sweep:  # rebuild a hidden rod end by sliding a clean cross-section along the rod axis
            import math
            (fx, fy), (tx, ty), hw = sweep["from"], sweep["to"], sweep["half_width"]
            L = math.hypot(tx - fx, ty - fy)
            dx_, dy_ = (tx - fx) / L, (ty - fy) / L
            nx_, ny_ = -dy_, dx_
            my_z = part.get("z", 0)
            t = 0.0
            while t <= L:
                s_ = -hw
                while s_ <= hw:
                    sx, sy = round(fx + nx_ * s_), round(fy + ny_ * s_)
                    qx, qy = round(fx + dx_ * t + nx_ * s_), round(fy + dy_ * t + ny_ * s_)
                    if 0 <= qx < w and 0 <= qy < h and lp[qx, qy][3] == 0 and lp[sx, sy][3] == 255:
                        o = owner[qy][qx]
                        if o >= 0 and spec["parts"][o].get("z", 0) > my_z:
                            lp[qx, qy] = lp[sx, sy]
                    s_ += 0.5
                t += 0.5
        comp = part.get("complete")
        if comp:  # draw the hidden part of this piece the way an artist would: body colour + inked contour
            sil = Image.new("L", (w, h), 0)
            for poly in comp["polys"]:
                ImageDraw.Draw(sil).polygon([tuple(p) for p in poly], fill=255)
            sp = sil.load()
            def hidden(x, y):
                o = owner[y][x]
                return o >= 0 and spec["parts"][o].get("z", 0) > part.get("z", 0)
            luma = lambda c: (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000
            todo = {(x, y) for y in range(h) for x in range(w) if sp[x, y] and lp[x, y][3] == 0 and hidden(x, y)}
            while todo:  # diffuse body colour only (ignore outline pixels so nothing smears)
                ready = []
                for x, y in todo:
                    nb = [lp[nx, ny] for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1))
                          if 0 <= nx < w and 0 <= ny < h and lp[nx, ny][3] == 255 and luma(lp[nx, ny]) >= comp.get("min_luma", 90)]
                    if nb:
                        ready.append((x, y, tuple(sum(c[i] for c in nb) // len(nb) for i in range(3)) + (255,)))
                if not ready:
                    break
                for x, y, c in ready:
                    lp[x, y] = c
                    todo.discard((x, y))
            dark = sorted((lp[x, y][:3] for y in range(h) for x in range(w)
                           if lp[x, y][3] == 255 and luma(lp[x, y]) < 50), key=luma)
            ink = dark[len(dark) // 2] + (255,) if dark else (12, 40, 58, 255)
            stroke = Image.new("L", (w, h), 0)
            for edge in comp.get("edges", []):
                ImageDraw.Draw(stroke).line([tuple(p) for p in edge], fill=255, width=comp.get("line_width", 3), joint="curve")
            st = stroke.load()
            for y in range(h):
                for x in range(w):
                    if st[x, y] and hidden(x, y):
                        lp[x, y] = ink
        layer.save(out / f"{part['name']}.png")
        t = TINTS[i % len(TINTS)]
        for y in range(h):
            for x in range(w):
                if owner[y][x] == i:
                    r, g, b, a = rv[x, y]
                    rv[x, y] = ((r + t[0]) // 2, (g + t[1]) // 2, (b + t[2]) // 2, 255)
        rig["parts"].append({k: part[k] for k in ("name", "pivot", "parent", "z") if k in part} | {"pixels": count})
    for y in range(h):
        for x in range(w):
            if not bg[y][x] and owner[y][x] == -1:
                rv[x, y] = (255, 0, 255, 255)
                unassigned += 1
    d = ImageDraw.Draw(review)
    for part in spec["parts"]:
        px_, py_ = part["pivot"]
        d.ellipse([px_ - 4, py_ - 4, px_ + 4, py_ + 4], outline=(0, 0, 0), width=2)
    review.save(out / "review.png")
    rig["unassigned_pixels"] = unassigned
    (out / "rig.json").write_text(json.dumps(rig, indent=2), encoding="utf-8")
    print(json.dumps({"parts": [(p["name"], p["pixels"]) for p in rig["parts"]], "unassigned": unassigned}))
    return 1 if unassigned else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
