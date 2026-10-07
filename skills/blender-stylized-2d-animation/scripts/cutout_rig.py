"""Rig and animate cut-out parts (from cutout_parts.py) in Blender, without redrawing.

    blender -b --factory-startup --python cutout_rig.py -- PARTS_DIR ANIM.json OUT_DIR

Every part is a flat plane carrying the original pixels, hung from an empty at
its joint pivot; empties follow the parent chain in rig.json. Rotations are in
degrees, counter-clockwise on screen, relative to the drawn rest pose.

ANIM.json:
{
  "fps": 24,
  "pad": [120, 120, 20, 20],                                  # px of room around the canvas (left, right, top, bottom)
  "limits": {"shin_l": [-8, 8], "forearm_l": [-110, 10]},   # per-joint, relative to parent
  "poses": {"rest": {}, "wave_up": {"upper_arm_r": 95, "forearm_r": 60, "root": [0, 0]}},
  "shots": [
    {"name": "wave", "frames": 24,
     "keys": [[1, "rest"], [8, "wave_up"], [24, "rest"]],
     "render": [1, 8, 16]}            # or "all"
  ]
}

A pose may also move a part: {"thigh_l@move": [0, -12]} slides the part in
pixels (screen down = +y), e.g. lifting a leg whose hidden top was rebuilt.
"root" moves the whole character. Rotations outside "limits" are clamped and
reported in OUT_DIR/report.json, so impossible joints never reach a render.
"""
import json
import math
import sys
from pathlib import Path

import bpy

S = 0.01  # world units per pixel


def args():
    a = sys.argv[sys.argv.index("--") + 1:]
    return Path(a[0]).resolve(), json.loads(Path(a[1]).read_text(encoding="utf-8")), Path(a[2]).resolve()


def world(x, y):
    return (x * S, -y * S)


def make_material(name, img_path):
    img = bpy.data.images.load(str(img_path))
    img.colorspace_settings.name = "sRGB"
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"  # Cubic is a smoothing B-spline: it blurs line art
    tex.extension = "CLIP"
    emit = nt.nodes.new("ShaderNodeEmission")
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], emit.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    else:
        mat.blend_method = "BLEND"
    return mat


def build(parts_dir: Path, pad=(0, 0, 0, 0)):
    rig = json.loads((parts_dir / "rig.json").read_text(encoding="utf-8"))
    w, h = rig["canvas"]
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    empties = {}
    order = []
    pending = list(rig["parts"])
    while pending:  # parents first
        for p in list(pending):
            if p.get("parent") in (None, *empties.keys()):
                e = bpy.data.objects.new(f"J_{p['name']}", None)
                bpy.context.scene.collection.objects.link(e)
                e.empty_display_size = 0.05
                px, py = world(*p["pivot"])
                if p.get("parent"):
                    par = empties[p["parent"]]
                    e.parent = par
                    pw = par["pivot_world"]
                    e.location = (px - pw[0], py - pw[1], 0)
                else:
                    e.location = (px, py, 0)
                e["pivot_world"] = (px, py)
                empties[p["name"]] = e
                order.append(p)
                pending.remove(p)
    for p in order:
        bpy.ops.mesh.primitive_plane_add(size=1)
        plane = bpy.context.active_object
        plane.name = f"P_{p['name']}"
        plane.scale = (w * S, h * S, 1)
        e = empties[p["name"]]
        pw = e["pivot_world"]
        cx, cy = world(w / 2, h / 2)
        plane.parent = e
        plane.location = (cx - pw[0], cy - pw[1], p.get("z", 0) * 0.01)
        plane.data.materials.append(make_material(p["name"], parts_dir / f"{p['name']}.png"))
    root = empties[order[0]["name"]]
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    pl, pr, pt, pb = pad
    rw, rh = w + pl + pr, h + pt + pb
    cam_data.ortho_scale = max(rw, rh) * S
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cx, cy = world(w / 2 + (pr - pl) / 2, h / 2 + (pb - pt) / 2)
    cam.location = (cx, cy, 10)
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = rw, rh
    sc.render.film_transparent = True
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    if hasattr(sc, "eevee"):
        sc.eevee.taa_render_samples = 32
    sc.render.filter_size = 0.5  # default 1.5 px softens every outline
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    return rig, empties, root


def pose_values(pose: dict, limits: dict, report: list, shot: str, frame: int):
    rot, move = {}, {}
    for k, v in pose.items():
        if k == "root":
            continue
        if k.endswith("@move"):
            move[k[:-5]] = v
            continue
        lo, hi = limits.get(k, [-360, 360])
        if not lo <= v <= hi:
            report.append({"shot": shot, "frame": frame, "joint": k, "asked": v, "clamped_to": max(lo, min(hi, v))})
            v = max(lo, min(hi, v))
        rot[k] = v
    return rot, move, pose.get("root", [0, 0])


def main():
    parts_dir, anim, out = args()
    out.mkdir(parents=True, exist_ok=True)
    rig, empties, root = build(parts_dir, tuple(anim.get("pad", [0, 0, 0, 0])))
    sc = bpy.context.scene
    sc.render.fps = anim.get("fps", 24)
    limits = anim.get("limits", {})
    report = []
    base = {n: tuple(e.location) for n, e in empties.items()}
    for shot in anim["shots"]:
        for e in empties.values():
            e.animation_data_clear()
        for frame, pose_ref in shot["keys"]:
            pose = anim["poses"][pose_ref] if isinstance(pose_ref, str) else pose_ref
            rot, move, root_off = pose_values(pose, limits, report, shot["name"], frame)
            for n, e in empties.items():
                e.rotation_euler = (0, 0, math.radians(rot.get(n, 0)))
                bx, by, bz = base[n]
                dx, dy = move.get(n, [0, 0])
                if e is root:
                    dx += root_off[0]
                    dy += root_off[1]
                e.location = (bx + dx * S, by - dy * S, bz)
                e.keyframe_insert("rotation_euler", frame=frame)
                e.keyframe_insert("location", frame=frame)
        sc.frame_start, sc.frame_end = 1, shot["frames"]
        frames = range(1, shot["frames"] + 1) if shot.get("render") == "all" else shot.get("render", [1])
        for f in frames:
            sc.frame_set(f)
            sc.render.filepath = str(out / f"{shot['name']}_{f:03d}.png")
            bpy.ops.render.render(write_still=True)
    (out / "report.json").write_text(json.dumps({"clamped": report}, indent=2), encoding="utf-8")
    print("CUTOUT_DONE", json.dumps({"shots": [s["name"] for s in anim["shots"]], "clamped": len(report)}))


main()
