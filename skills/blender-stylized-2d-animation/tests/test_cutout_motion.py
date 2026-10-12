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
      "wave_arm": "r", "eyes": ["eye_l", "eye_r"],
      "mouth": {"top": "lip_top", "jaw": "jaw", "inside": "mouth_in"}}


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
        self.assertLess(abs(keys[-1]["upper_arm_r"]), 0.5)
        self.assertLess(abs(keys[0]["upper_arm_r"]), 0.5, "the wave starts exactly at rest, so it cuts cleanly from idle")
        self.assertLess(abs(keys[0]["root"][1]), 0.5)
        self.assertGreater(max(k["upper_arm_r"] for k in keys), 55)
        self.assertLess(min(k["upper_arm_r"] for k in keys[:8]), -3, "anticipation: the arm pulls back before it rises")


class FaceTests(unittest.TestCase):
    def test_blink_is_fast_down_slow_up_and_reopens(self):
        seq = [cm.blink_scale(f, [10]) for f in range(30)]
        self.assertEqual(seq[9], 1.0)
        self.assertLessEqual(min(seq), 0.12, "the eye must really close")
        closed = [f for f, v in enumerate(seq) if v <= 0.12]
        self.assertLessEqual(len(closed), 3, "a blink holds shut for only a frame or two")
        down = closed[0] - 10 + 1                      # frames from start to shut
        up = max(f for f, v in enumerate(seq) if v < 1) - closed[-1]
        self.assertLess(down, up, "eyes close faster than they open")
        self.assertEqual(seq[20], 1.0)

    def test_basmala_lips_close_on_every_b_and_m(self):
        shot = cm.speak(RM, "kid")
        jaw = [k[1]["jaw@scale"][1] for k in shot["keys"]]
        lead = 10
        t = lead
        closures = 0
        for vis, n in cm.BASMALA:
            if vis == "closed":
                closures += 1
                seg = jaw[t:t + n]
                self.assertTrue(all(v <= 0.31 for v in seg), f"lips must stay shut for the whole b/m at frame {t + 1}: {seg}")
                self.assertGreaterEqual(n, 3, "a closure shorter than 3 frames does not read")
            t += n
        self.assertEqual(closures, 4, "b, m, m, m in bismi llahi r-rahmani r-rahim")
        self.assertEqual(len(jaw), lead + sum(n for _, n in cm.BASMALA) + 14)

    def test_basmala_opens_widest_on_the_long_alif_and_narrow_on_kasra(self):
        shot = cm.speak(RM, "kid")
        keys = [k[1] for k in shot["keys"]]
        jaw = [k["jaw@scale"][1] for k in keys]
        wide = [k["jaw@scale"][0] for k in keys]
        t, spans = 10, []
        for vis, n in cm.BASMALA:
            spans.append((vis, t, t + n)); t += n
        aa = [max(jaw[a:b]) for v, a, b in spans if v == "aa"]
        ii = [(max(jaw[a:b]), max(wide[a:b])) for v, a, b in spans if v == "i"]
        self.assertEqual(len(aa), 2)                                   # Allaah, rahmaan
        self.assertTrue(all(v >= 2.3 for v in aa), aa)
        self.assertTrue(all(j <= 1.7 for j, _ in ii), "kasra stays narrow")
        self.assertTrue(any(wd >= 1.05 for _, wd in ii), "and the lips spread on it")
        self.assertEqual(max(jaw), max(aa))

    def test_speech_starts_and_ends_at_rest_with_feet_planted(self):
        shot = cm.speak(RM, "kid")
        keys = [k[1] for k in shot["keys"]]
        for k in (keys[0], keys[-1]):
            self.assertEqual(k["jaw@scale"], [1.0, 1.0])
            self.assertEqual(k["mouth_in@scale"], [1.0, 1.0])
        self.assertTrue(all(k["mouth_in@scale"] == k["jaw@scale"] for k in keys), "interior follows the lower lip")
        self.assertTrue(all(k["lip_top@scale"][1] == 1 for k in keys), "the upper lip and teeth never stretch vertically")
        for side in ("l", "r"):
            pts = [foot(k, side) for k in keys]
            self.assertLess(max(p_[0] for p_ in pts) - min(p_[0] for p_ in pts), 1.0)
            self.assertLess(max(p_[1] for p_ in pts) - min(p_[1] for p_ in pts), 1.0)
        self.assertTrue(any(k["eye_l@scale"][1] < 0.2 for k in keys), "the character blinks while speaking")

    def test_no_joint_jumps_between_frames_in_any_shot(self):
        """A sign flip or a missing ease shows up as one joint jumping in a single frame."""
        limits = {"upper": 14, "fore": 16, "hand": 20, "head": 1.6, "torso": 1.2, "antenna": 4.5}
        for shot in (cm.walk(RM, "kid"), cm.wave(RM, "kid"), cm.idle(RM, "kid"), cm.speak(RM, "kid")):
            keys = [k[1] for k in shot["keys"]]
            for name in ("head", "torso", "antenna_l", "antenna_r", "upper_arm_l", "upper_arm_r",
                         "forearm_l", "forearm_r", "hand_l", "hand_r"):
                lim = next(v for k, v in limits.items() if k in name)
                worst = max(abs(keys[i + 1].get(name, 0) - keys[i].get(name, 0)) for i in range(len(keys) - 1))
                self.assertLess(worst, lim, f"{shot['name']}: {name} jumps {worst:.2f} deg in one frame")

    def test_shapes_blend_between_sounds(self):
        track = cm.mouth_track(cm.BASMALA, 10, 14)
        jumps = [abs(track[i + 1][0] - track[i][0]) for i in range(len(track) - 1)]
        self.assertLess(max(jumps), 1.3, "no frame-to-frame snap bigger than a closure opening")
        self.assertEqual(track[0], cm.VISEMES["rest"])


if __name__ == "__main__":
    unittest.main()
