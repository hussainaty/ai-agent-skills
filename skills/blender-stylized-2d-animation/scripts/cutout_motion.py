#!/usr/bin/env python3
"""Generate natural cut-out motion as dense per-frame keys for cutout_rig.py.

    python cutout_motion.py rigmap.json base_anim.json out_anim.json [--style kid|adult]

Motion is built from animation principles instead of sparse hand poses:

- Successive breaking of joints: each joint down a chain repeats its parent's
  motion a few frames later (shoulder -> elbow +2f -> wrist +4f; head ->
  antennae +3f). This is what makes limbs read as jointed, not as sticks.
- Arcs come for free from rotations around real pivots.
- Slow in / slow out: smoothstep on every transition; cycles use sines.
- Anticipation before a big move, overshoot and settle after it.
- Weight: the pelvis travels sideways over the standing foot and the torso
  leans over it. Arms swing as pendulums around the rest pose, never as a
  one-way flap.
- Foot lock: the body bobs, shifts and leans; each leg slides, tilts and
  counter-rotates so a planted foot does not move (hip_dx = the hip pivot's x
  offset from the torso pivot, length = hip to sole, both in pixels).
- Timing: "kid" walks take 10 frames per step at 24 fps with a bigger bounce;
  "adult" walks take 12.
Every frame is keyed (animate on ones), so the result is smooth at 24 fps.

rigmap.json names the joints and the sign that raises each limb outward
(rotations are counter-clockwise positive on screen):
{
  "torso": "torso", "head": "head", "antennae": ["antenna_l", "antenna_r"],
  "arms": {"l": {"upper": "upper_arm_l", "fore": "forearm_l", "hand": "hand_l", "sign": -1},
           "r": {"upper": "upper_arm_r", "fore": "forearm_r", "hand": "hand_r", "sign": 1}},
  "legs": {"l": {"thigh": "thigh_l", "shin": "shin_l", "sign": -1, "hip_dx": -36, "length": 330},
           "r": {"thigh": "thigh_r", "shin": "shin_r", "sign": 1, "hip_dx": 53, "length": 330}},
  "wave_arm": "r"
}
base_anim.json supplies fps, pad, limits, and any extra poses/shots to keep.
"""
import json
import math
import sys
from pathlib import Path

TAU = 2 * math.pi


def smooth(a: float, b: float, f: float) -> float:
    """Smoothstep from 0 at frame a to 1 at frame b (slow in, slow out)."""
    if f <= a:
        return 0.0
    if f >= b:
        return 1.0
    t = (f - a) / (b - a)
    return t * t * (3 - 2 * t)


def bell(f: float, centre: float, width: float) -> float:
    return math.exp(-((f - centre) / width) ** 2)


def lock_legs(pose: dict, rm: dict, lean: float, bob: float, dx: float, lifts: dict, swing: dict | None = None) -> None:
    """Keep the feet where they are while the pelvis moves.

    The legs hang from the torso, so a torso lean or a sideways shift would
    carry the feet along. Each thigh counter-rotates against the lean, tilts
    by asin(dx / leg length) so a foot stays under its own spot, and slides
    vertically to cancel the bob and the rise of the hip (hip_dx px from the
    torso pivot). lifts[side] raises a free foot; swing[side] adds a small
    outward knee swing (degrees for thigh, shin).
    """
    for side, leg in rm["legs"].items():
        L = leg.get("length", 330)
        tilt = -math.degrees(math.asin(max(-1, min(1, dx / L))))
        hip = leg.get("hip_dx", 0) * math.sin(math.radians(lean))
        th, sh = (swing or {}).get(side, (0, 0))
        pose[f"{leg['thigh']}@move"] = [0, round(-bob - lifts.get(side, 0) + hip, 2)]
        pose[leg["thigh"]] = round(-lean + tilt + th, 2)
        pose[leg["shin"]] = round(sh, 2)


def walk(rm: dict, style: str) -> dict:
    step = 10 if style == "kid" else 12
    cycle = 2 * step
    bob_amp, lift_h, sway, shift = (7.0, 34.0, 2.6, 9.0) if style == "kid" else (5.0, 26.0, 2.0, 6.0)
    arm_u, arm_f, arm_h = (7.0, 12.0, 8.0) if style == "kid" else (5.0, 9.0, 6.0)
    keys = []
    for f in range(cycle):
        ph = TAU * f / cycle
        bob = bob_amp * math.cos(TAU * (f - step * 0.25) / step)          # + = body down; lowest just after contact
        lead = TAU * (f + 2) / cycle                                      # weight arrives 2 frames before the foot lifts
        dx = shift * math.sin(lead)                                       # pelvis travels over the standing foot
        lean = -sway * math.sin(lead)                                     # and the torso leans over it
        pose = {"root": [round(dx, 2), round(bob, 2)]}
        lifts, swing = {}, {}
        for side, first in (("l", 0), ("r", step)):
            leg = rm["legs"][side]
            g = (f - first) % cycle
            lift = lift_h * math.sin(math.pi * g / step) ** 1.3 if g < step else 0.0
            lifts[side] = lift
            k = lift / lift_h
            swing[side] = (leg["sign"] * 5.0 * k, -leg["sign"] * 5.5 * k)   # free knee swings slightly outward
        lock_legs(pose, rm, lean, bob, dx, lifts, swing)
        pose[rm["torso"]] = round(lean, 2)
        pose[rm["head"]] = round(0.75 * sway * math.sin(TAU * (f - 2) / cycle), 2)   # counter-tilt, 2 frames late
        splay = 3.0 * math.cos(TAU * (f - step * 0.25 - 3) / step)            # antennae spring on the bob, 3 frames late
        drag = 3.5 * math.sin(TAU * (f - 4) / cycle)
        for i, name in enumerate(rm.get("antennae", [])):
            pose[name] = round(drag + (splay if i == 0 else -splay), 2)
        # Arm swing: a pendulum around the rest pose, opposite to the leg on its side. Seen from the
        # front, the forward half reads as the arm opening slightly with the elbow flexing; the back
        # half as the arm closing and straightening. The hand drags behind and flicks at each end.
        for side, phase in (("r", 0.0), ("l", math.pi)):
            arm = rm["arms"][side]
            sw = lambda lag: math.sin(TAU * (f - lag) / cycle + phase)
            s2 = sw(2)                                                        # elbow breaks 2 frames after the shoulder
            pose[arm["upper"]] = round(arm["sign"] * arm_u * sw(0), 2)
            pose[arm["fore"]] = round(arm["sign"] * (2 + arm_f * (s2 if s2 > 0 else 0.35 * s2)), 2)
            pose[arm["hand"]] = round(arm["sign"] * (arm_h * sw(4) + 2.0 * math.cos(TAU * (f - 4) / cycle + phase)), 2)
        keys.append([f + 1, pose])
    return {"name": "walk", "frames": cycle, "keys": keys, "render": "all"}


def wave(rm: dict, style: str) -> dict:
    n = 48
    arm = rm["arms"][rm.get("wave_arm", "r")]
    other = rm["arms"]["l" if rm.get("wave_arm", "r") == "r" else "r"]
    sg = arm["sign"]
    beat = 8 if style == "kid" else 9
    keys = []
    for f in range(n):
        up = smooth(5, 14, f) - smooth(37, 45, f)                              # shoulder leads
        fore = smooth(7, 17, f) - smooth(39, 47, f)                            # elbow follows
        hand = smooth(9, 19, f) - smooth(41, 48, f)                            # wrist last
        env = smooth(16, 20, f) * (1 - smooth(34, 38, f))                      # waving window
        osc = lambda lag: math.sin(TAU * (f - 18 - lag) / beat)
        dip = 8 * bell(f, 3, 2.5) - 4 * bell(f, 13, 4) + 3 * bell(f, 44, 3) + 1.5 * env * osc(1)   # anticipation, rise, settle
        lean = sg * (2.2 * up - 1.5 * bell(f, 3, 2.5) + 1.0 * env * osc(-2))   # the body joins in
        dx = sg * 4.0 * up                                                     # weight moves under the raised arm
        pose = {"root": [round(dx, 2), round(dip, 2)]}
        lock_legs(pose, rm, lean, dip, dx, {})
        pose[rm["torso"]] = round(lean, 2)
        pose[arm["upper"]] = round(sg * (66 * up - 7 * bell(f, 3, 2.5) + 5 * env * osc(-1)), 2)
        pose[arm["fore"]] = round(sg * (46 * fore + 8 * bell(f, 17, 2.5) + 13 * env * osc(0)), 2)   # overshoot, then wave
        pose[arm["hand"]] = round(sg * (8 * hand + 22 * env * osc(2)), 2)      # hand drags behind the forearm
        pose[other["upper"]] = round(other["sign"] * (3 * up + 1.5 * env * osc(1)), 2)   # the other arm balances
        pose[other["fore"]] = round(other["sign"] * (10 * (smooth(7, 16, f) - smooth(39, 47, f)) + 2 * env * osc(3)), 2)
        pose[other["hand"]] = round(other["sign"] * 5 * (smooth(9, 18, f) - smooth(41, 48, f)), 2)
        head = -sg * 3.5 * (smooth(8, 17, f) - smooth(38, 46, f))
        pose[rm["head"]] = round(head + 2.0 * env * osc(1), 2)
        head_late = -sg * 3.5 * (smooth(11, 20, f) - smooth(41, 48, f))
        for i, name in enumerate(rm.get("antennae", [])):
            pose[name] = round(-1.5 * head_late + 5 * env * osc(3) * (1 if i == 0 else 0.8), 2)
        keys.append([f + 1, pose])
    return {"name": "wave", "frames": n, "keys": keys, "render": "all"}


def idle(rm: dict, style: str) -> dict:
    n = 48
    keys = []
    for f in range(n):
        br = 2.0 * math.sin(TAU * f / n)                                       # breathing bob
        lean = 0.6 * math.sin(TAU * f / n + 1)
        pose = {"root": [0, round(br, 2)], rm["torso"]: round(lean, 2),
                rm["head"]: round(1.2 * math.sin(TAU * (f - 4) / n), 2)}
        lock_legs(pose, rm, lean, br, 0, {})
        for i, name in enumerate(rm.get("antennae", [])):
            pose[name] = round(2.5 * math.sin(TAU * (f - 8) / n + (0 if i == 0 else 0.6)), 2)
        for arm in rm["arms"].values():
            pose[arm["upper"]] = round(arm["sign"] * (1 + 1.2 * math.sin(TAU * (f - 2) / n)), 2)
            pose[arm["fore"]] = round(arm["sign"] * (2 + 2.5 * math.sin(TAU * (f - 5) / n)), 2)
            pose[arm["hand"]] = round(arm["sign"] * (1 + 3 * math.sin(TAU * (f - 8) / n)), 2)
        keys.append([f + 1, pose])
    return {"name": "idle", "frames": n, "keys": keys, "render": "all"}


def main(argv: list[str]) -> int:
    style = "kid"
    if "--style" in argv:
        style = argv[argv.index("--style") + 1]
        argv = [a for a in argv if a not in ("--style", style)]
    rm = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    base = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    made = [walk(rm, style), wave(rm, style), idle(rm, style)]
    names = {s["name"] for s in made}
    base["shots"] = [s for s in base.get("shots", []) if s["name"] not in names] + made
    Path(argv[2]).write_text(json.dumps(base), encoding="utf-8")
    print(json.dumps({"style": style, "shots": [(s["name"], s["frames"]) for s in base["shots"]]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
