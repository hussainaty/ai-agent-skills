"""Regression tests for cutout_parts.py on a synthetic figure (no Blender needed).

    python tests/test_cutout_parts.py
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cutout_parts.py"
BG = (247, 247, 247)


def figure(path: Path) -> None:
    """A body with a white highlight, a rod (thigh) entering under it, a freckle, and an outline."""
    im = Image.new("RGB", (120, 160), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([50, 70, 66, 150], fill=(80, 170, 210), outline=(10, 40, 60), width=2)   # rod, top hidden
    d.ellipse([20, 10, 100, 90], fill=(100, 200, 230), outline=(10, 40, 60), width=3)    # body over it
    d.ellipse([40, 25, 80, 55], fill=(255, 255, 255))                                     # white highlight
    d.point((70, 70), fill=(150, 180, 200))                                               # a freckle
    im.save(path)


def spec(extend=True) -> dict:
    rod = {"name": "rod", "poly": [[45, 60], [72, 60], [72, 155], [45, 155]], "pivot": [58, 80], "parent": "body", "z": 1}
    if extend:
        rod["extend"] = {"from_row": 95, "to_row": 60, "x": [48, 68]}
    body = {"name": "body", "poly": [[0, 0], [120, 0], [120, 92], [0, 92]], "pivot": [60, 50], "parent": None, "z": 2}
    return {"image": "fig.png", "background": {"tolerance": 14}, "parts": [body, rod]}


def run(tmp: Path, sp: dict):
    (tmp / "spec.json").write_text(json.dumps(sp), encoding="utf-8")
    r = subprocess.run([sys.executable, str(SCRIPT), str(tmp / "spec.json"), str(tmp / "out")],
                       capture_output=True, text=True)
    return r


def reassemble(tmp: Path, names_by_z) -> Image.Image:
    base = Image.new("RGBA", (120, 160), BG + (255,))
    for n in names_by_z:
        base.alpha_composite(Image.open(tmp / "out" / f"{n}.png"))
    return base.convert("RGB")


class CutoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        figure(self.tmp / "fig.png")

    def test_every_pixel_assigned_and_rest_pose_identical(self):
        r = run(self.tmp, spec())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads((self.tmp / "out" / "rig.json").read_text())["unassigned_pixels"], 0)
        rest = reassemble(self.tmp, ["rod", "body"])
        diff = ImageChops.difference(rest, Image.open(self.tmp / "fig.png").convert("RGB"))
        self.assertIsNone(diff.getbbox(), "rest pose must be pixel-identical to the original")

    def test_white_inside_outline_is_kept(self):
        run(self.tmp, spec())
        body = Image.open(self.tmp / "out" / "body.png")
        self.assertEqual(body.getpixel((60, 40))[3], 255, "white highlight inside the outline must not be keyed out")
        self.assertEqual(body.getpixel((70, 70))[:3], (150, 180, 200), "small details (freckle) must be copied exactly")

    def test_extend_rebuilds_only_hidden_pixels(self):
        run(self.tmp, spec(extend=True))
        rod = Image.open(self.tmp / "out" / "rod.png")
        self.assertEqual(rod.getpixel((58, 75))[3], 255, "hidden rod end under the body is rebuilt")
        self.assertEqual(rod.getpixel((58, 30))[3], 0, "nothing is rebuilt outside the part in front")
        run(self.tmp, spec(extend=False))
        self.assertEqual(Image.open(self.tmp / "out" / "rod.png").getpixel((58, 75))[3], 0)

    def test_unassigned_pixels_fail_the_gate(self):
        sp = spec()
        sp["parts"][1]["poly"] = [[45, 92], [72, 92], [72, 120], [45, 120]]   # rod polygon too short
        r = run(self.tmp, sp)
        self.assertEqual(r.returncode, 1)
        self.assertGreater(json.loads((self.tmp / "out" / "rig.json").read_text())["unassigned_pixels"], 0)


if __name__ == "__main__":
    unittest.main()
