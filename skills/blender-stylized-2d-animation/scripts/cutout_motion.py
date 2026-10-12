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
- Blinks: fast down (2 frames), a 1-frame hold, slower up (3 frames).
- Lip-sync: a viseme list with frame counts. Shapes blend into each other, but a lip
  closure (b, m) is held exactly. The built-in phrase is the Arabic basmala.
Every frame is keyed (animate on ones), so the result is smooth at 24 fps.

rigmap.json names the joints and the sign that raises each limb outward
(rotations are counter-clockwise positive on screen):
{
  "torso": "torso", "head": "head", "antennae": ["antenna_l", "antenna_r"],
  "arms": {"l": {"upper": "upper_arm_l", "fore": "forearm_l", "hand": "hand_l", "sign": -1},
           "r": {"upper": "upper_arm_r", "fore": "forearm_r", "hand": "hand_r", "sign": 1}},
  "legs": {"l": {"thigh": "thigh_l", "shin": "shin_l", "sign": -1, "hip_dx": -36, "length": 330},
           "r": {"thigh": "thigh_r", "shin": "shin_r", "sign": 1, "hip_dx": 53, "length": 330}},
  "wave_arm": "r",
  "eyes": ["eye_l", "eye_r"],                       # optional: enables blinks
  "mouth": {"top": "lip_top", "jaw": "jaw", "inside": "mouth_in"}   # optional: enables the speak shot
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
            u = (g / step) ** 1.25 if g < step else 0.0                       # peak a little late: quicker drop into contact
            lift = lift_h * math.sin(math.pi * u) ** 1.2 if g < step else 0.0
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
            pose[arm["fore"]] = round(arm["sign"] * (2 + arm_f * (s2 if s2 > 0 else 0.6 * s2)), 2)
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
        ends = smooth(0, 2, f) * (1 - smooth(n - 3, n - 1, f))                  # exactly at rest on the first and last frame
        dip = ends * (8 * bell(f, 4, 2.5) - 4 * bell(f, 13, 4) + 3 * bell(f, 43, 3)) + 1.5 * env * osc(1)   # anticipation, rise, settle
        lean = sg * (2.2 * up - 1.5 * ends * bell(f, 4, 2.5) + 1.0 * env * osc(-2))   # the body joins in
        dx = sg * 4.0 * up                                                     # weight moves under the raised arm
        pose = {"root": [round(dx, 2), round(dip, 2)]}
        lock_legs(pose, rm, lean, dip, dx, {})
        pose[rm["torso"]] = round(lean, 2)
        pose[arm["upper"]] = round(sg * (66 * up - 7 * ends * bell(f, 4, 2.5) + 5 * env * osc(-1)), 2)
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


def blink_scale(f: int, at: list[int]) -> float:
    """Eye height (1 = open) for frame f, for blinks starting at the frames in `at`.
    A blink closes in 2 frames, holds 1, and opens in 3: fast down, slower up."""
    shape = [0.55, 0.1, 0.1, 0.35, 0.7, 0.92]
    for t in at:
        if 0 <= f - t < len(shape):
            return shape[f - t]
    return 1.0


def add_blinks(shot: dict, rm: dict, at: list[int]) -> dict:
    for i, (_, pose) in enumerate(shot["keys"]):
        for eye in rm.get("eyes", []):
            pose[f"{eye}@scale"] = [1, blink_scale(i, at)]
    return shot


# Mouth shapes (visemes). Each is (jaw, width): jaw scales the lower lip about the mouth corners
# (1 = the drawn smile, < 1 closes, > 1 opens) and width scales the whole mouth sideways.
# Only sounds made at the lips and teeth are visible on a face. Sounds from the back of the mouth
# and throat (Arabic h, the pharyngeal H, and to a degree r, l, n) take the shape of the vowel
# beside them, so they are given in-between shapes here.
VISEMES = {
    "rest": (1.0, 1.0),
    "closed": (0.3, 1.0),     # b, m: lips pressed together
    "s": (1.05, 1.05),        # teeth together, lips a little spread
    "i": (1.3, 1.07),         # kasra / long ii: narrow and spread
    "l": (1.5, 1.0),          # tongue tip up, mouth part open
    "n": (1.35, 1.0),
    "r": (1.4, 1.0),
    "h": (1.6, 1.0),          # glottal: open, shaped by the vowels around it
    "a": (2.0, 0.97),         # fatha: open
    "H": (1.9, 0.97),         # pharyngeal H (as in rahman): open, like its vowel
    "aa": (2.6, 0.94),        # long alif, widest; deepest after the heavy l of "Allah"
}

# "bismi llaahi r-rahmaani r-rahiim" as (viseme, frames at 24 fps). About 3.5 seconds, an unhurried recitation pace.
BASMALA = [("closed", 3), ("i", 3), ("s", 3), ("closed", 3), ("i", 3),                  # bis-mi
           ("l", 2), ("l", 2), ("aa", 7), ("h", 3), ("i", 3),                           # l-laa-hi
           ("r", 2), ("r", 2), ("a", 4), ("H", 3), ("closed", 3), ("aa", 7), ("n", 3), ("i", 3),   # r-rah-maa-ni
           ("r", 2), ("r", 2), ("a", 4), ("H", 3), ("i", 8), ("closed", 4)]            # r-ra-hii-m


def mouth_track(phones: list, lead: int, tail: int) -> list:
    """Per-frame (jaw, width). Shapes blend into each other (coarticulation), but a lip closure is
    held exactly for its full length, because a b or m that never closes is the most visible error."""
    steps = [("rest", lead)] + list(phones) + [("rest", tail)]
    raw = [v for v, n in steps for _ in range(n)]
    tgt = [VISEMES[v] for v in raw]
    out = []
    for i in range(len(tgt)):
        if raw[i] == "closed":
            out.append(tgt[i])
            continue
        lo, hi = max(0, i - 1), min(len(tgt) - 1, i + 1)
        w = [(lo, 0.25), (i, 0.5), (hi, 0.25)]
        out.append((sum(tgt[j][0] * k for j, k in w), sum(tgt[j][1] * k for j, k in w)))
    shut = VISEMES["closed"]
    mix = lambda p_, q_, k: (p_[0] + (q_[0] - p_[0]) * k, p_[1] + (q_[1] - p_[1]) * k)
    for i in range(len(out)):          # lips part and meet over a few frames, never in one
        if raw[i] == "closed":
            continue
        since = next((d for d in (1, 2) if i - d >= 0 and raw[i - d] == "closed"), None)
        until = next((d for d in (1, 2) if i + d < len(raw) and raw[i + d] == "closed"), None)
        if since:
            out[i] = mix(shut, out[i], 0.5 if since == 1 else 0.85)
        if until:
            out[i] = mix(out[i], shut, 0.45 if until == 1 else 0.12)
    out[0] = out[-1] = VISEMES["rest"]
    return out


def speak(rm: dict, style: str, phones: list | None = None, name: str = "speak") -> dict:
    """A talking shot: lip-sync from a viseme list, with the body alive underneath
    (breathing, small head nods on the long vowels, a light hand gesture, blinks)."""
    phones = phones or BASMALA
    lead, tail = 10, 14
    track = mouth_track(phones, lead, tail)
    n = len(track)
    m = rm["mouth"]
    stress, t = [], lead                                        # frame at the middle of each long vowel
    for v, k in phones:
        if v in ("aa",) or (v == "i" and k >= 6):
            stress.append(t + k / 2)
        t += k
    arm = rm["arms"][rm.get("wave_arm", "r")]
    other = rm["arms"]["l" if rm.get("wave_arm", "r") == "r" else "r"]
    sg = arm["sign"]
    keys = []
    for f in range(n):
        jaw, wide = track[f]
        talk = smooth(lead - 6, lead + 4, f) * (1 - smooth(n - tail - 2, n - 4, f))    # 1 while speaking
        br = 1.6 * math.sin(TAU * f / 48)
        nod = sum(bell(f, c - 1, 3.0) for c in stress)                                 # dips into each stressed vowel
        tilt = sum(bell(f, c - 1, 3.5) * (1 if i % 2 == 0 else -1) for i, c in enumerate(stress))   # each nod leans its own way, eased
        lean = 0.5 * math.sin(TAU * f / 48 + 1) + sg * 0.8 * talk
        pose = {"root": [0, round(br + 1.5 * nod, 2)], rm["torso"]: round(lean, 2),
                rm["head"]: round(-sg * 1.5 * talk + 1.3 * tilt, 2)}
        lock_legs(pose, rm, lean, br + 1.5 * nod, 0, {})
        for i, a_name in enumerate(rm.get("antennae", [])):
            pose[a_name] = round(2.0 * math.sin(TAU * (f - 8) / 48 + (0 if i == 0 else 0.6))
                                 + 3.0 * sum(bell(f, c + 3, 3.0) for c in stress) * (1 if i == 0 else -1), 2)
        g = talk * (1 + 0.25 * math.sin(TAU * (f - 2) / 30))                           # a small open-hand gesture
        pose[arm["upper"]] = round(sg * (1 + 9 * g), 2)
        pose[arm["fore"]] = round(sg * (2 + 26 * smooth(lead - 4, lead + 8, f) * (1 - smooth(n - tail, n - 2, f))
                                        + 4 * math.sin(TAU * (f - 4) / 30) * talk), 2)
        pose[arm["hand"]] = round(sg * (1 + 12 * smooth(lead - 2, lead + 10, f) * (1 - smooth(n - tail + 2, n - 1, f))), 2)
        pose[other["upper"]] = round(other["sign"] * (1 + 2 * talk), 2)
        pose[other["fore"]] = round(other["sign"] * (2 + 5 * talk), 2)
        pose[other["hand"]] = round(other["sign"] * (1 + 2 * talk), 2)
        pose[f"{m['jaw']}@scale"] = [round(wide, 3), round(jaw, 3)]
        pose[f"{m['inside']}@scale"] = [round(wide, 3), round(jaw, 3)]
        pose[f"{m['top']}@scale"] = [round(wide, 3), 1]
        keys.append([f + 1, pose])
    shot = {"name": name, "frames": n, "keys": keys, "render": "all"}
    return add_blinks(shot, rm, [3, n - 9])


def main(argv: list[str]) -> int:
    style = "kid"
    if "--style" in argv:
        style = argv[argv.index("--style") + 1]
        argv = [a for a in argv if a not in ("--style", style)]
    rm = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    base = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    made = [walk(rm, style), wave(rm, style), idle(rm, style)]
    if rm.get("eyes"):                       # blinks: never on the walk loop (it repeats too often)
        add_blinks(made[1], rm, [6, 40])
        add_blinks(made[2], rm, [30])
    if rm.get("mouth"):
        made.append(speak(rm, style))
    names = {s["name"] for s in made}
    base["shots"] = [s for s in base.get("shots", []) if s["name"] not in names] + made
    Path(argv[2]).write_text(json.dumps(base), encoding="utf-8")
    print(json.dumps({"style": style, "shots": [(s["name"], s["frames"]) for s in base["shots"]]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
