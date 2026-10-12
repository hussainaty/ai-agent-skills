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

    def test_alt_writes_a_second_drawing_and_records_the_swap_angle(self):
        sp = spec()
        sp["parts"][1]["alt"] = {"above_deg": 20, "ops": {"extend": {"from_row": 95, "to_row": 40, "x": [48, 68]}}}
        self.assertEqual(run(self.tmp, sp).returncode, 0)
        base = Image.open(self.tmp / "out" / "rod.png")
        alt = Image.open(self.tmp / "out" / "rod__alt.png")
        self.assertEqual(base.getpixel((58, 50))[3], 0, "the first drawing keeps its own repair")
        self.assertEqual(alt.getpixel((58, 50))[3], 255, "the alternative drawing uses the overriding repair")
        rig = json.loads((self.tmp / "out" / "rig.json").read_text())
        self.assertEqual(next(p for p in rig["parts"] if p["name"] == "rod")["alt_above_deg"], 20)

    def test_underlay_patch_is_hidden_at_rest(self):
        sp = spec()
        sp["parts"][1]["underlay"] = {"z": 0.5, "grow": 2}      # behind the rod (z 1) and the body (z 2)
        self.assertEqual(run(self.tmp, sp).returncode, 0)
        patch = Image.open(self.tmp / "out" / "rod__under.png")
        self.assertIsNotNone(patch.getbbox(), "a patch is written")
        rest = Image.new("RGBA", (120, 160), BG + (255,))
        for n in ("rod__under", "rod", "body"):                 # back to front
            rest.alpha_composite(Image.open(self.tmp / "out" / f"{n}.png"))
        diff = ImageChops.difference(rest.convert("RGB"), Image.open(self.tmp / "fig.png").convert("RGB"))
        self.assertLess(max(diff.getextrema()[i][1] for i in range(3)), 12, "the patch must not show in the rest pose")
        rig = json.loads((self.tmp / "out" / "rig.json").read_text())
        under = next(p for p in rig["parts"] if p["name"] == "rod__under")
        self.assertEqual((under["parent"], under["z"]), ("rod", 0.5))

    def test_unassigned_pixels_fail_the_gate(self):
        sp = spec()
        sp["parts"][1]["poly"] = [[45, 92], [72, 92], [72, 120], [45, 120]]   # rod polygon too short
        r = run(self.tmp, sp)
        self.assertEqual(r.returncode, 1)
        self.assertGreater(json.loads((self.tmp / "out" / "rig.json").read_text())["unassigned_pixels"], 0)


class EdgeQualityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_defringe_turns_page_blended_rim_into_ink_with_alpha(self):
        im = Image.new("RGB", (60, 60), BG)
        d = ImageDraw.Draw(im)
        d.rectangle([20, 20, 40, 40], fill=(100, 200, 230), outline=(10, 40, 60), width=2)
        for y in range(20, 41):                       # a soft rim pixel: outline blended half-way with the page
            im.putpixel((19, y), (128, 143, 153))
        im.save(self.tmp / "fig.png")
        sp = {"image": "fig.png", "parts": [{"name": "box", "poly": [[0, 0], [60, 0], [60, 60], [0, 60]], "pivot": [30, 30], "parent": None, "z": 1}]}
        self.assertEqual(run(self.tmp, sp).returncode, 0)
        box = Image.open(self.tmp / "out" / "box.png")
        r, g, b, a = box.getpixel((19, 30))
        self.assertLess(a, 200, "the rim pixel must become partly transparent")
        self.assertGreater(a, 60)
        self.assertLess(max(r, g, b), 90, "and take the outline colour, not the page-blended grey")
        self.assertEqual(box.getpixel((30, 30)), (100, 200, 230, 255), "interior pixels are untouched")
        rest = Image.new("RGBA", (60, 60), BG + (255,)); rest.alpha_composite(box)
        diff = ImageChops.difference(rest.convert("RGB"), im)
        self.assertLess(max(diff.getextrema()[i][1] for i in range(3)), 12, "over the page it still looks the same")

    def test_edge_gate_flags_islands_and_bare_edges(self):
        check = Path(__file__).resolve().parents[1] / "scripts" / "cutout_check.py"
        def frame(name, extra):
            im = Image.new("RGBA", (80, 80), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
            d.ellipse([20, 20, 60, 60], fill=(100, 200, 230, 255), outline=(10, 40, 60, 255), width=3)
            extra(d); im.save(self.tmp / name); return str(self.tmp / name)
        rest = frame("rest.png", lambda d: None)
        good = frame("good.png", lambda d: None)
        island = frame("island.png", lambda d: d.rectangle([2, 2, 6, 6], fill=(10, 40, 60, 255)))
        bare = frame("bare.png", lambda d: d.rectangle([40, 30, 75, 50], fill=(100, 200, 230, 255)))   # un-inked slab
        ok = subprocess.run([sys.executable, str(check), rest, good], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stdout)
        for bad in (island, bare):
            r = subprocess.run([sys.executable, str(check), rest, bad], capture_output=True, text=True)
            self.assertEqual(r.returncode, 1, r.stdout)


if __name__ == "__main__":
    unittest.main()
