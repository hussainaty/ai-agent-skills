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
Parts with "alt_above_deg" in rig.json (from the cutter's "alt") have two
drawings; the alternative one is shown while the joint is rotated more than
that many degrees from rest (a drawing swap), cross-faded over
+/- "swap_fade_deg" (default 6) so it never pops. "save_blend": "name.blend"
saves the rigged scene next to the renders. Limbs listed under "skins" in rig.json are drawn on a mesh bent by bones
(see build_skin), so a bent joint has no seam. "root" moves the whole character. Rotations outside "limits" are clamped and
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
    info = nt.nodes.new("ShaderNodeObjectInfo")       # object colour alpha fades a whole part (drawing swap)
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(tex.outputs["Alpha"], mul.inputs[0])
    nt.links.new(info.outputs["Alpha"], mul.inputs[1])
    nt.links.new(mul.outputs[0], mix.inputs["Fac"])
    nt.links.new(transp.outputs[0], mix.inputs[1])
    nt.links.new(emit.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    else:
        mat.blend_method = "BLEND"
    return mat


def build_skin(sk, rig, empties, parts_dir, w, h, suffix="", image=None, dz=0.0):
    """One limb as a flexible sheet: a grid mesh carrying the limb's image, bent by two bones.

    Each bone copies the transform of its joint empty, so the same joint
    animation drives rigid parts and skins. Weights blend from the first joint
    to the second across +/- blend pixels around the second joint's pivot,
    measured along the limb's axis.
    """
    pivots = {p["name"]: p["pivot"] for p in rig["parts"]}
    j0, j1 = sk["joints"][:2]
    (sx, sy), (ex, ey) = pivots[j0], pivots[j1]
    L = math.hypot(ex - sx, ey - sy)
    ux, uy = (ex - sx) / L, (ey - sy) / L
    x0, y0, x1, y1 = sk["bbox"]
    g = sk.get("grid", 4)
    xs = list(range(x0 - 2, x1 + 2 + g, g))
    ys = list(range(y0 - 2, y1 + 2 + g, g))
    verts, uvs, wts = [], [], []
    for py in ys:
        for px in xs:
            wx, wy = world(px, py)
            verts.append((wx, wy, 0.0))
            uvs.append((px / w, 1 - py / h))
            d = (px - ex) * ux + (py - ey) * uy
            t = max(0.0, min(1.0, (d + sk["blend"]) / (2 * sk["blend"])))
            wts.append(t * t * (3 - 2 * t))
    nx = len(xs)
    faces = [(r * nx + c, r * nx + c + 1, (r + 1) * nx + c + 1, (r + 1) * nx + c)
             for r in range(len(ys) - 1) for c in range(nx - 1)]
    mesh = bpy.data.meshes.new(f"M_{sk['name']}{suffix}")
    mesh.from_pydata(verts, [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]
    ob = bpy.data.objects.new(f"S_{sk['name']}{suffix}", mesh)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = (0, 0, sk.get("z", 0) * 0.01 + dz)
    image = image or f"{sk['name']}__skin.png"
    mesh.materials.append(make_material(image[:-4], parts_dir / image))
    g0, g1 = ob.vertex_groups.new(name=j0), ob.vertex_groups.new(name=j1)
    for i, wt in enumerate(wts):
        if wt < 1:
            g0.add([i], 1 - wt, "REPLACE")
        if wt > 0:
            g1.add([i], wt, "REPLACE")

    arm_data = bpy.data.armatures.new(f"ARM_{sk['name']}{suffix}")
    arm = bpy.data.objects.new(f"ARM_{sk['name']}{suffix}", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for j in (j0, j1):
        bx, by = world(*pivots[j])
        eb = arm_data.edit_bones.new(j)
        eb.head = (bx, by, 0)
        eb.tail = (bx, by + 0.2, 0)          # +Y, roll 0: the bone's rest matrix is a pure translation, like its empty
        eb.roll = 0
    bpy.ops.object.mode_set(mode="POSE")
    for j in (j0, j1):
        con = arm.pose.bones[j].constraints.new("COPY_TRANSFORMS")
        con.target = empties[j]
    bpy.ops.object.mode_set(mode="OBJECT")
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    arm.hide_render = True
    return ob


def build(parts_dir: Path, pad=(0, 0, 0, 0)):
    rig = json.loads((parts_dir / "rig.json").read_text(encoding="utf-8"))
    w, h = rig["canvas"]
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    empties = {}
    swaps = {}
    skin_swaps = {}
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
    skinned = {layer.replace("__alt", "") for sk in rig.get("skins", []) for layer in sk["layers"]}
    for p in order:
        if p["name"] in skinned:      # drawn by a bone-deformed skin instead of a rigid plane
            continue
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
        if "alt_above_deg" in p:   # drawing swap: a second plane with the alternative drawing
            alt = plane.copy()
            alt.data = plane.data.copy()
            alt.name = f"A_{p['name']}"
            bpy.context.scene.collection.objects.link(alt)
            alt.data.materials.clear()
            alt.data.materials.append(make_material(p["name"] + "__alt", parts_dir / f"{p['name']}__alt.png"))
            alt.hide_render = True
            swaps[p["name"]] = (plane, alt, p["alt_above_deg"])
    for sk in rig.get("skins", []):
        first = build_skin(sk, rig, empties, parts_dir, w, h)
        if sk.get("alt_layers"):
            second = build_skin(sk, rig, empties, parts_dir, w, h, suffix="_alt",
                                image=f"{sk['name']}__skin_alt.png", dz=0.001)
            second.hide_render = True
            skin_swaps[sk["name"]] = (first, second, sk["joints"][0], sk.get("alt_above_deg", 13))
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
    return rig, empties, root, swaps, skin_swaps


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
    rig, empties, root, swaps, skin_swaps = build(parts_dir, tuple(anim.get("pad", [0, 0, 0, 0])))
    sc = bpy.context.scene
    sc.render.fps = anim.get("fps", 24)
    limits = anim.get("limits", {})
    fade = anim.get("swap_fade_deg", 6)                     # the swap blends over +/- this many degrees
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
            for name, (plane, alt, above) in swaps.items():      # cross-fade to the drawing that suits this angle
                ang = abs(math.degrees(empties[name].rotation_euler.z))
                k = max(0.0, min(1.0, (ang - (above - fade)) / (2 * fade)))
                k = k * k * (3 - 2 * k)
                alt.color = (1, 1, 1, k)
                alt.hide_render = k <= 0.001
                plane.hide_render = k >= 0.999                   # the first drawing stays underneath during the fade
                under = bpy.data.objects.get(f"P_{name}__under")   # its patch belongs to the first drawing
                if under:
                    under.color = (1, 1, 1, 1 - k)
                    under.hide_render = k >= 0.999
            for first, second, joint, above in skin_swaps.values():   # cross-fade the skin's two looks
                ang = abs(math.degrees(empties[joint].rotation_euler.z))
                k = max(0.0, min(1.0, (ang - (above - fade)) / (2 * fade)))
                k = k * k * (3 - 2 * k)
                second.color = (1, 1, 1, k)
                second.hide_render = k <= 0.001
                first.hide_render = k >= 0.999
            for sk in rig.get("skins", []):
                fu = sk.get("fade_under")
                under = bpy.data.objects.get(f"P_{fu['part']}__under") if fu else None
                if under:
                    ang = abs(math.degrees(empties[fu["part"]].rotation_euler.z))
                    k = max(0.0, min(1.0, (ang - fu["from_deg"]) / max(fu["to_deg"] - fu["from_deg"], 1e-6)))
                    under.color = (1, 1, 1, 1 - k)
                    under.hide_render = k >= 0.999
            sc.render.filepath = str(out / f"{shot['name']}_{f:03d}.png")
            bpy.ops.render.render(write_still=True)
    if anim.get("save_blend"):
        bpy.ops.file.pack_all()                                  # images travel inside the .blend
        bpy.ops.wm.save_as_mainfile(filepath=str(out / anim["save_blend"]))
    (out / "report.json").write_text(json.dumps({"clamped": report}, indent=2), encoding="utf-8")
    print("CUTOUT_DONE", json.dumps({"shots": [s["name"] for s in anim["shots"]], "clamped": len(report)}))


main()
