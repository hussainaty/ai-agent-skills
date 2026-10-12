#!/usr/bin/env python3
"""Contact sheet and frame-to-frame motion report for a rendered shot.

    python contact_sheet.py "renders/walk_*.png" OUT.png [--cols 10] [--scale 0.3] [--bg 247,247,247]

Writes OUT.png (every frame, labelled) and prints a JSON report of how much
changes between consecutive frames (percentage of pixels that differ). Use it
to review motion as a whole before accepting a shot:

- a spike between two frames is a pop (a drawing swap, a wrong key, a jump);
- a run of zeros is a hold that may be unintended;
- a loop is clean when the last-to-first change is close to its neighbours.

Borrowed practice: cc-blender-skill's animation quality gate ("no final
animation without a contact sheet").
"""
import glob
import json
import sys

from PIL import Image, ImageChops, ImageDraw


def flatten(path: str, bg) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    base = Image.new("RGBA", im.size, bg + (255,))
    base.alpha_composite(im)
    return base.convert("RGB")


def main(argv: list[str]) -> int:
    cols, scale, bg = 10, 0.3, (247, 247, 247)
    pos = []
    i = 0
    while i < len(argv):
        if argv[i] == "--cols":
            cols = int(argv[i + 1]); i += 2
        elif argv[i] == "--scale":
            scale = float(argv[i + 1]); i += 2
        elif argv[i] == "--bg":
            bg = tuple(int(v) for v in argv[i + 1].split(",")); i += 2
        else:
            pos.append(argv[i]); i += 1
    files = sorted(glob.glob(pos[0]))
    if not files:
        print(f"no frames match {pos[0]}", file=sys.stderr)
        return 2
    frames = [flatten(f, bg) for f in files]
    w, h = int(frames[0].width * scale), int(frames[0].height * scale)
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows * (h + 16)), bg)
    d = ImageDraw.Draw(sheet)
    for n, im in enumerate(frames):
        x, y = (n % cols) * w, (n // cols) * (h + 16)
        sheet.paste(im.resize((w, h), Image.LANCZOS), (x, y))
        d.text((x + 4, y + h + 2), f"F{n + 1:02d}", fill=(20, 40, 60))
    sheet.save(pos[1])

    def change(a, b):
        diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
        return round(100 * diff.histogram()[255] / (a.width * a.height), 2)

    steps = [change(frames[k], frames[k + 1]) for k in range(len(frames) - 1)]
    loop = change(frames[-1], frames[0])
    med = sorted(steps)[len(steps) // 2] if steps else 0
    pops = [{"between": [k + 1, k + 2], "changed_pct": v} for k, v in enumerate(steps) if med and v > 2.5 * med and v > 1]
    print(json.dumps({"frames": len(frames), "median_change_pct": med, "max_change_pct": max(steps, default=0),
                      "loop_change_pct": loop, "possible_pops": pops, "sheet": pos[1]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
