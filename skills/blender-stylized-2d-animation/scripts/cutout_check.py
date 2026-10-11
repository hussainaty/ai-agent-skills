#!/usr/bin/env python3
"""Edge gate for POSED cut-out renders (the rest-pose diff cannot see hidden-area defects).

    python cutout_check.py REST.png POSED1.png [POSED2.png ...] [--max-extra 1.5]

For each transparent-background render it measures:
- islands: detached fragments (connected groups of opaque pixels apart from
  the main figure, 4 px or larger). A clean rig has none.
- un-inked edge %: silhouette pixels with no dark outline within 3 px inward.
  Line art has an outline almost everywhere, so a cut edge that was exposed
  by a moving joint shows up as a rise over the rest pose.

Exit code 1 if any posed frame has islands, or its un-inked share exceeds the
rest pose by more than --max-extra percentage points. Prints the worst spots
so they can be zoomed and fixed.
"""
import json
import sys
from collections import deque

from PIL import Image


def analyse(path: str) -> dict:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    solid = [[px[x, y][3] > 96 for x in range(w)] for y in range(h)]
    seen = [[False] * w for _ in range(h)]
    comps = []
    for y in range(h):
        for x in range(w):
            if solid[y][x] and not seen[y][x]:
                q = deque([(x, y)]); seen[y][x] = True; pts = []
                while q:
                    cx, cy = q.popleft(); pts.append((cx, cy))
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < w and 0 <= ny < h and solid[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True; q.append((nx, ny))
                comps.append(pts)
    comps.sort(key=len, reverse=True)
    islands = [{"size": len(c), "at": c[0]} for c in comps[1:] if len(c) >= 4]
    luma = lambda c: (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000
    edge = bare = 0
    spots = {}
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if not solid[y][x] or all(solid[b][a] for a, b in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))):
                continue
            edge += 1
            dark = min((luma(px[a, b]) for a in range(x - 3, x + 4) for b in range(y - 3, y + 4)
                        if 0 <= a < w and 0 <= b < h and px[a, b][3] > 96), default=255)
            if dark > 110:
                bare += 1
                key = (x // 24 * 24, y // 24 * 24)
                spots[key] = spots.get(key, 0) + 1
    worst = sorted(spots.items(), key=lambda kv: -kv[1])[:6]
    return {"file": path, "islands": islands, "edge_px": edge, "uninked_pct": round(100 * bare / max(edge, 1), 2),
            "worst_spots": [{"near": k, "px": v} for k, v in worst]}


def main(argv: list[str]) -> int:
    max_extra = 1.5
    if "--max-extra" in argv:
        max_extra = float(argv[argv.index("--max-extra") + 1])
        argv = [a for a in argv if a not in ("--max-extra", str(max_extra))][:]
        argv = [a for a in argv if not a.replace(".", "", 1).isdigit()]
    rest = analyse(argv[0])
    fail = bool(rest["islands"])
    out = {"rest": rest, "posed": []}
    for path in argv[1:]:
        r = analyse(path)
        r["extra_pct"] = round(r["uninked_pct"] - rest["uninked_pct"], 2)
        r["pass"] = not r["islands"] and r["extra_pct"] <= max_extra
        fail = fail or not r["pass"]
        out["posed"].append(r)
    print(json.dumps(out, indent=1))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
