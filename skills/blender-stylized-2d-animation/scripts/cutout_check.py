#!/usr/bin/env python3
"""Edge gate for POSED cut-out renders (the rest-pose diff cannot see hidden-area defects).

    python cutout_check.py REST.png POSED1.png [POSED2.png ...] [--max-extra 1.5] [--summary]

Arguments may be glob patterns ("renders/walk_*.png"), so every frame of a
shot can be checked. For each transparent-background render it measures:

- islands: detached fragments (groups of opaque pixels apart from the main
  figure, 4 px or larger). A clean rig has none.
- pinholes: small enclosed gaps (3 to 60 px of background fully surrounded
  by the figure). A joint that opens when it bends shows up as one.
- un-inked edge %: silhouette pixels with no dark outline within 3 px
  inward. Line art has an outline almost everywhere, so a cut edge exposed
  by a moving joint shows as a rise over the rest pose.

Exit code 1 if any posed frame has islands, has pinholes the rest pose does
not have, or its un-inked share exceeds the rest pose by more than
--max-extra percentage points. --summary prints one line per failing frame
and the totals instead of the full JSON.
"""
import glob
import json
import sys
from collections import deque

from PIL import Image


def components(mask, w, h, want):
    seen = [[False] * w for _ in range(h)]
    out = []
    for y in range(h):
        for x in range(w):
            if mask[y][x] == want and not seen[y][x]:
                q = deque([(x, y)]); seen[y][x] = True; pts = []; border = False
                while q:
                    cx, cy = q.popleft(); pts.append((cx, cy))
                    if cx in (0, w - 1) or cy in (0, h - 1):
                        border = True
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] == want and not seen[ny][nx]:
                            seen[ny][nx] = True; q.append((nx, ny))
                out.append((pts, border))
    return out


def analyse(path: str) -> dict:
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    solid = [[px[x, y][3] > 96 for x in range(w)] for y in range(h)]
    comps = sorted(components(solid, w, h, True), key=lambda c: -len(c[0]))
    islands = [{"size": len(c[0]), "at": c[0][0]} for c in comps[1:] if len(c[0]) >= 4]
    pinholes = [{"size": len(pts), "at": pts[0]} for pts, border in components(solid, w, h, False)
                if not border and 3 <= len(pts) <= 60]
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
    return {"file": path, "islands": islands, "pinholes": pinholes, "edge_px": edge,
            "uninked_pct": round(100 * bare / max(edge, 1), 2),
            "worst_spots": [{"near": k, "px": v} for k, v in worst]}


def main(argv: list[str]) -> int:
    max_extra, summary = 1.5, False
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--max-extra":
            max_extra = float(argv[i + 1]); i += 2
        elif argv[i] == "--summary":
            summary = True; i += 1
        else:
            args.extend(sorted(glob.glob(argv[i])) or [argv[i]]); i += 1
    rest = analyse(args[0])
    fail = bool(rest["islands"])
    out = {"rest": rest, "posed": []}
    for path in args[1:]:
        r = analyse(path)
        r["extra_pct"] = round(r["uninked_pct"] - rest["uninked_pct"], 2)
        r["new_pinholes"] = max(0, len(r["pinholes"]) - len(rest["pinholes"]))
        r["pass"] = not r["islands"] and not r["new_pinholes"] and r["extra_pct"] <= max_extra
        fail = fail or not r["pass"]
        out["posed"].append(r)
    if summary:
        bad = [r for r in out["posed"] if not r["pass"]]
        for r in bad:
            print(f"FAIL {r['file']}: islands {[(i_['size'], i_['at']) for i_ in r['islands']]} "
                  f"pinholes {[(p['size'], p['at']) for p in r['pinholes']]} extra {r['extra_pct']}")
        print(json.dumps({"frames": len(out["posed"]), "failed": len(bad),
                          "max_extra_pct": max((r["extra_pct"] for r in out["posed"]), default=0),
                          "rest_uninked_pct": rest["uninked_pct"], "rest_pinholes": len(rest["pinholes"])}))
    else:
        print(json.dumps(out, indent=1))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
