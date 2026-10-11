"""Regression tests for cutout_motion.py (pure Python, no Blender).

    python tests/test_cutout_motion.py

The planted foot's position is computed from the generated joint values by
forward kinematics, the same way cutout_rig.py applies them: the root moves
and rotates the torso, a thigh's "@move" is applied in the torso's space, and
rotations are counter-clockwise on screen (y points down).
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import cutout_motion as cm  # noqa: E402

RM = {"torso": "torso", "head": "head", "antennae": ["antenna_l", "antenna_r"],
      "arms": {"l": {"upper": "upper_arm_l", "fore": "forearm_l", "hand": "hand_l", "sign": -1},
               "r": {"upper": "upper_arm_r", "fore": "forearm_r", "hand": "hand_r", "sign": 1}},
      "legs": {"l": {"thigh": "thigh_l", "shin": "shin_l", "sign": -1, "hip_dx": -36, "length": 329},
               "r": {"thigh": "thigh_r", "shin": "shin_r", "sign": 1, "hip_dx": 53, "length": 329}},
      "wave_arm": "r"}


def rot(v, deg):
    """Rotate counter-clockwise as seen on screen (y down)."""
    t = math.radians(deg)
    return (v[0] * math.cos(t) + v[1] * math.sin(t), -v[0] * math.sin(t) + v[1] * math.cos(t))


def foot(pose: dict, side: str):
    leg = RM["legs"][side]
    lean = pose.get("torso", 0)
    rx, ry = pose.get("root", [0, 0])
    mx, my = pose.get(f"{leg['thigh']}@move", [0, 0])
    hx, hy = rot((leg["hip_dx"] + mx, my), lean)
    lx, ly = rot((0, leg["length"]), lean + pose.get(leg["thigh"], 0))
    return rx + hx + lx, ry + hy + ly


class MotionTests(unittest.TestCase):
    def test_walk_standing_foot_is_locked(self):
        for style, step in (("kid", 10), ("adult", 12)):
            keys = [k[1] for k in cm.walk(RM, style)["keys"]]
            self.assertEqual(len(keys), 2 * step)
            for side, frames in (("r", range(0, step)), ("l", range(step, 2 * step))):   # r stands while l swings
                pts = [foot(keys[f], side) for f in frames]
                dx = max(p[0] for p in pts) - min(p[0] for p in pts)
                dy = max(p[1] for p in pts) - min(p[1] for p in pts)
                self.assertLess(dx, 1.0, f"{style} {side} foot slides sideways {dx:.2f}px")
                self.assertLess(dy, 1.0, f"{style} {side} foot drifts vertically {dy:.2f}px")

    def test_walk_free_foot_lifts_and_lands(self):
        keys = [k[1] for k in cm.walk(RM, "kid")["keys"]]
        ys = [foot(keys[f], "l")[1] for f in range(10)]
        self.assertGreater(max(ys) - min(ys), 25, "the free foot must clearly leave the ground")
        self.assertAlmostEqual(ys[0], foot(keys[10], "l")[1], delta=1.0)        # back on the ground at contact

    def test_walk_arms_swing_both_ways_and_opposite(self):
        keys = [k[1] for k in cm.walk(RM, "kid")["keys"]]
        r = [k["upper_arm_r"] for k in keys]
        l = [k["upper_arm_l"] for k in keys]
        self.assertLess(min(r), -1)
        self.assertGreater(max(r), 1)                                            # a swing around rest, not a one-way flap
        self.assertLess(max(abs(v) for v in r + l), 10, "front-view arm swing stays moderate")
        self.assertGreater(max(r), 5, "but large enough to read as a swing")
        self.assertAlmostEqual(r[5], -l[15], delta=0.01)                         # mirrored half a cycle apart (signs flip per side)

    def test_joints_break_in_succession(self):
        keys = [k[1] for k in cm.walk(RM, "kid")["keys"]]
        peak = lambda name: max(range(len(keys)), key=lambda f: keys[f][name])
        up, fore = peak("upper_arm_r"), peak("forearm_r")
        self.assertIn((fore - up) % len(keys), (1, 2, 3), "the elbow peaks a couple of frames after the shoulder")

    def test_wave_keeps_feet_planted_and_returns_to_rest(self):
        keys = [k[1] for k in cm.wave(RM, "kid")["keys"]]
        for side in ("l", "r"):
            pts = [foot(k, side) for k in keys]
            self.assertLess(max(p[0] for p in pts) - min(p[0] for p in pts), 1.0)
            self.assertLess(max(p[1] for p in pts) - min(p[1] for p in pts), 1.0)
        self.assertLess(abs(keys[-1]["upper_arm_r"]), 2)
        self.assertGreater(max(k["upper_arm_r"] for k in keys), 55)
        self.assertLess(min(k["upper_arm_r"] for k in keys[:6]), -3, "anticipation: the arm pulls back before it rises")


if __name__ == "__main__":
    unittest.main()
