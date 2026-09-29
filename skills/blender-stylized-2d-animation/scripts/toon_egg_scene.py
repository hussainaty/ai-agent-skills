"""Stylized 2D-look ("toon") animated scene: fried eggs with faces in a pan on fire.

Recipe (modelling -> colour -> animation/finishing), tuned for Blender 5.x EEVEE:
  * jagged egg whites: radial grid with noisy outline + Solidify + Subdivision
  * half-sphere yolks, painted-style highlight, pepper, darker stroke marks
  * toon shading: Diffuse -> Shader to RGB -> constant Color Ramp (flat bands)
  * outlines: inverted-hull Solidify with flipped normals + backface culling
  * unique face per egg (eyes, mouth curve, optional brows)
  * "boil" animation: shape keys keyed with a Noise F-modifier, then a Stepped
    modifier so everything moves on twos like hand-drawn animation
  * procedural fire ring: 4D noise + colour ramp, animated by a frame driver
  * bubbles with Geometry Nodes: Distribute Points on a rim ring around each
    white, instanced tiny spheres, re-seeded every other frame
  * compositor glare for glow

Run inside Blender through the Blender Lab MCP tool ``execute_blender_code``
(the file's text is the code; tweak PARAMS first), or headless:

  blender -b --factory-startup --python toon_egg_scene.py -- \
      --out C:/tmp/eggs --render-frames 1,7,13 --save C:/tmp/eggs/eggs.blend

All geometry is generated; no external assets.
"""
import math
import random
import sys

import bpy
import bmesh

PARAMS = {
    "eggs": 4,            # 1..6
    "seed": 7,
    "fps": 24,
    "frames": 48,
    "resolution": (1080, 1080),
    "fire": True,
    "bubbles": True,
    "outline": 0.06,      # inverted-hull thickness (scene units)
    "step": 2,            # animate "on twos"; 1 = smooth
    "palette": {
        "white": (1.0, 0.93, 0.80), "white_shade": (0.86, 0.72, 0.58),
        "yolk": (1.0, 0.62, 0.05), "yolk_shade": (0.90, 0.40, 0.02),
        "pan": (0.30, 0.26, 0.24), "pan_shade": (0.18, 0.15, 0.14),
        "line": (0.05, 0.03, 0.03), "stroke": (0.80, 0.62, 0.48),
        "pepper": (0.12, 0.09, 0.07), "bg": (0.08, 0.05, 0.05),
        "fire": [(0.55, 0.05, 0.02), (1.0, 0.30, 0.05), (1.0, 0.75, 0.25)],
    },
}

EXPRESSIONS = ["smile", "flat", "frown", "o", "smirk", "worried"]


# --------------------------------------------------------------------- helpers
def srgb_to_linear(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def rgba(c, a=1.0):
    return (*srgb_to_linear(c), a)


def link_obj(obj, coll):
    coll.objects.link(obj)
    return obj


def toon_material(name, lit, shade, bands=(0.45,)):
    """Diffuse -> Shader to RGB -> constant ramp: flat 2D colour bands."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    dif = nt.nodes.new("ShaderNodeBsdfDiffuse")
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    emit = nt.nodes.new("ShaderNodeEmission")
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, rgba(shade)
    els[1].position, els[1].color = bands[0], rgba(lit)
    nt.links.new(dif.outputs["BSDF"], s2r.inputs["Shader"])
    nt.links.new(s2r.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def flat_material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = rgba(color)
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def outline_material(color):
    mat = flat_material("Outline", color)
    mat.use_backface_culling = True
    return mat


def add_outline(obj, mat_line, thickness):
    """Inverted hull: shell pushed outward, normals flipped, front faces culled."""
    obj.data.materials.append(mat_line)
    mod = obj.modifiers.new("Outline", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = 1.0
    mod.use_flip_normals = True
    mod.use_rim = False
    mod.material_offset = len(obj.data.materials) - 1


def mesh_object(name, bm, coll, mats=()):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = link_obj(bpy.data.objects.new(name, me), coll)
    for m in mats:
        me.materials.append(m)
    return obj


def jagged_profile(rng, n, radius, rough):
    """Radii of a blobby, jagged fried-egg outline (low + high frequency)."""
    phases = [rng.uniform(0, math.tau) for _ in range(3)]
    radii = []
    for i in range(n):
        t = math.tau * i / n
        r = radius * (1.0 + 0.10 * math.sin(2 * t + phases[0]) + 0.07 * math.sin(3 * t + phases[1])
                      + 0.04 * math.sin(5 * t + phases[2]))
        r *= 1.0 + rng.uniform(-rough, rough)
        radii.append(r)
    return radii


def radial_disc(radii, rings, z=0.0, inner=0.0):
    bm = bmesh.new()
    n = len(radii)
    grid = []
    for k in range(rings + 1):
        f = inner + (1.0 - inner) * (k / rings)
        row = []
        for i, r in enumerate(radii):
            t = math.tau * i / n
            row.append(bm.verts.new((math.cos(t) * r * f, math.sin(t) * r * f, z)))
        grid.append(row)
    if inner == 0.0:
        centre = bm.verts.new((0, 0, z))
        for i in range(n):
            bm.faces.new((centre, grid[1][i], grid[1][(i + 1) % n]))
        start = 1
    else:
        start = 0
    for k in range(start, rings):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((grid[k][i], grid[k + 1][i], grid[k + 1][j], grid[k][j]))
    return bm


def dome_z(x, y, r, h):
    d2 = (x * x + y * y) / (r * r)
    return h * math.sqrt(max(0.0, 1.0 - d2))


def blob(name, coll, mat, loc, scale, segments=12):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=max(6, segments // 2), radius=1.0)
    obj = mesh_object(name, bm, coll, [mat])
    obj.location = loc
    obj.scale = scale
    return obj


def curve_line(name, coll, mat, points, depth):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = depth
    cu.bevel_resolution = 2
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(points) - 1)
    for bp, p in zip(sp.bezier_points, points):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    obj = link_obj(bpy.data.objects.new(name, cu), coll)
    cu.materials.append(mat)
    return obj


def fcurves_of(id_data):
    """F-curves of an ID's action, for both legacy and slotted (4.4+/5.x) actions."""
    ad = id_data.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    try:
        from bpy_extras import anim_utils
        cb = anim_utils.action_get_channelbag_for_slot(act, ad.action_slot)
        if cb is not None:
            return list(cb.fcurves)
    except (ImportError, AttributeError):
        pass
    return list(getattr(act, "fcurves", []))


def boil(id_data, data_path_prefix, strength, phase, step):
    """Noise F-modifier for wobble + Stepped modifier for on-twos timing."""
    for fc in fcurves_of(id_data):
        if not fc.data_path.startswith(data_path_prefix):
            continue
        noise = fc.modifiers.new("NOISE")
        noise.scale = 6.0
        noise.strength = strength
        noise.phase = phase + fc.array_index * 13.7
        noise.blend_in = noise.blend_out = 0.0
        if step > 1:
            st = fc.modifiers.new("STEPPED")
            st.frame_step = step


# ------------------------------------------------------------------ builders
def build_egg(i, rng, coll, mats, P, centre):
    cx, cy = centre
    radius = rng.uniform(0.82, 0.95)
    radii = jagged_profile(rng, 56, radius, 0.05)
    white = mesh_object(f"EggWhite.{i}", radial_disc(radii, 4), coll, [mats["white"]])
    white.location = (cx, cy, 0.12)
    white.rotation_euler.z = rng.uniform(0, math.tau)
    sol = white.modifiers.new("Thickness", "SOLIDIFY")
    sol.thickness = 0.06
    for poly in white.data.polygons:
        poly.use_smooth = True
    sub = white.modifiers.new("Soften", "SUBSURF")
    sub.levels = sub.render_levels = 1
    add_outline(white, mats["line"], P["outline"])

    # "boil": a shape key with small random offsets on the outline, noise-keyed
    white.shape_key_add(name="Basis")
    wob = white.shape_key_add(name="Wobble")
    for v, kv in zip(white.data.vertices, wob.data):
        d = math.hypot(v.co.x, v.co.y)
        k = 0.06 * (d / radius) ** 2
        kv.co = (v.co.x + rng.uniform(-k, k), v.co.y + rng.uniform(-k, k), v.co.z)
    wob.slider_min, wob.slider_max = -1.0, 1.0
    for f in (1, P["frames"]):
        wob.value = 0.0
        wob.keyframe_insert("value", frame=f)
    boil(white.data.shape_keys, 'key_blocks["Wobble"]', 1.0, rng.uniform(0, 100), P["step"])

    # yolk: half sphere, slightly off centre
    yr, yh = radius * rng.uniform(0.40, 0.46), radius * 0.28
    ox, oy = rng.uniform(-0.15, 0.15) * radius, rng.uniform(-0.15, 0.15) * radius
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -1e-4], context="VERTS")
    yolk = mesh_object(f"Yolk.{i}", bm, coll, [mats["yolk"]])
    for poly in yolk.data.polygons:  # smooth normals: clean toon terminator, no sawtooth
        poly.use_smooth = True
    ys = yolk.modifiers.new("Smooth", "SUBSURF")
    ys.levels = ys.render_levels = 1
    yolk.scale = (yr, yr, yh)
    yolk.location = (cx + ox, cy + oy, 0.18)
    add_outline(yolk, mats["line"], P["outline"] * 0.8 / yr)
    yolk.keyframe_insert("location", frame=1)
    boil(yolk, "location", 0.015, rng.uniform(0, 100), P["step"])

    top = 0.18 + yh
    parts = []
    # painted-style highlight on the yolk
    hx, hy = -0.35 * yr, 0.35 * yr
    parts.append(blob(f"Highlight.{i}", coll, mats["highlight"],
                      (cx + ox + hx, cy + oy + hy, 0.18 + dome_z(hx, hy, yr, yh) + 0.01),
                      (0.16 * yr, 0.11 * yr, 0.02)))
    # stroke marks on the white, pepper dots
    for s in range(3):
        a = rng.uniform(0, math.tau)
        d = rng.uniform(0.60, 0.80) * radius
        x0, y0 = cx + math.cos(a) * d, cy + math.sin(a) * d
        tang = a + math.pi / 2
        pts = [(x0 + math.cos(tang) * t * 0.25, y0 + math.sin(tang) * t * 0.25, 0.19) for t in (-1, 0, 1)]
        parts.append(curve_line(f"Stroke.{i}.{s}", coll, mats["stroke"], pts, 0.012))
    for s in range(rng.randint(2, 5)):
        a, d = rng.uniform(0, math.tau), rng.uniform(0.55, 0.85) * radius
        parts.append(blob(f"Pepper.{i}.{s}", coll, mats["pepper"],
                          (cx + math.cos(a) * d, cy + math.sin(a) * d, 0.2), (0.025, 0.025, 0.01), 8))
    # face: eyes, mouth, optional brows -> each egg gets its own character
    expr = EXPRESSIONS[(i + rng.randint(0, 99)) % len(EXPRESSIONS)]
    ex, ey = 0.30 * yr, 0.12 * yr
    for sx in (-1, 1):
        x, y = sx * ex, ey
        closed = expr == "flat" and sx == 1 and rng.random() < 0.5  # a wink
        if closed:
            parts.append(curve_line(f"Eye.{i}.{sx}", coll, mats["line"],
                                    [(cx + ox + x - 0.06, cy + oy + y, top + 0.02),
                                     (cx + ox + x + 0.06, cy + oy + y, top + 0.02)], 0.012))
        else:
            parts.append(blob(f"Eye.{i}.{sx}", coll, mats["line"],
                              (cx + ox + x, cy + oy + y, 0.18 + dome_z(x, y, yr, yh) + 0.01),
                              (0.06, 0.08, 0.012), 10))
        if expr in ("worried", "frown"):
            tilt = 0.04 if expr == "worried" else -0.04
            parts.append(curve_line(f"Brow.{i}.{sx}", coll, mats["line"],
                                    [(cx + ox + x - 0.07, cy + oy + y + 0.12 - sx * tilt, top + 0.02),
                                     (cx + ox + x + 0.07, cy + oy + y + 0.12 + sx * tilt, top + 0.02)], 0.01))
    my = -0.18 * yr
    shape = {"smile": [(-0.12, 0.03), (0, -0.05), (0.12, 0.03)],
             "flat": [(-0.10, 0), (0, 0), (0.10, 0)],
             "frown": [(-0.11, -0.04), (0, 0.03), (0.11, -0.04)],
             "o": [(-0.04, 0), (0, -0.05), (0.04, 0), (0, 0.04), (-0.04, 0)],
             "smirk": [(-0.10, -0.01), (0.03, -0.03), (0.12, 0.04)],
             "worried": [(-0.11, -0.02), (-0.04, 0.02), (0.04, -0.02), (0.11, 0.02)]}[expr]
    parts.append(curve_line(f"Mouth.{i}", coll, mats["line"],
                            [(cx + ox + x, cy + oy + my + y, top + 0.02) for x, y in shape], 0.014))
    for p in parts:  # face and decals ride along with the yolk's boil
        if p.name.startswith(("Eye", "Mouth", "Brow", "Highlight")):
            p.parent = yolk
            p.matrix_parent_inverse = yolk.matrix_basis.inverted()  # matrix_world is stale before a depsgraph update

    rim = None
    if P["bubbles"]:
        rim = mesh_object(f"BubbleRim.{i}", radial_disc(radii, 1, z=0.0, inner=0.86), coll)
        rim.location = white.location
        rim.rotation_euler = white.rotation_euler
    return {"white": white, "yolk": yolk, "expression": expr, "rim": rim}


def bubble_nodes(mat_bubble):
    ng = bpy.data.node_groups.new("Bubbles", "GeometryNodeTree")
    ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    n = ng.nodes
    gin, gout = n.new("NodeGroupInput"), n.new("NodeGroupOutput")
    dist = n.new("GeometryNodeDistributePointsOnFaces")
    dist.inputs["Density"].default_value = 9.0
    time = n.new("GeometryNodeInputSceneTime")
    half = n.new("ShaderNodeMath")
    half.operation = "DIVIDE"
    half.inputs[1].default_value = 2.0
    flo = n.new("ShaderNodeMath")
    flo.operation = "FLOOR"
    ico = n.new("GeometryNodeMeshIcoSphere")
    ico.inputs["Radius"].default_value = 0.03
    ico.inputs["Subdivisions"].default_value = 1
    setm = n.new("GeometryNodeSetMaterial")
    setm.inputs["Material"].default_value = mat_bubble
    rnd = n.new("FunctionNodeRandomValue")
    rnd.data_type = "FLOAT"
    enabled = lambda socks, name: next(s for s in socks if s.name == name and s.enabled)
    enabled(rnd.inputs, "Min").default_value = 0.4
    enabled(rnd.inputs, "Max").default_value = 1.3
    inst = n.new("GeometryNodeInstanceOnPoints")
    L = ng.links.new
    L(gin.outputs[0], dist.inputs["Mesh"])
    L(time.outputs["Frame"], half.inputs[0])
    L(half.outputs[0], flo.inputs[0])
    L(flo.outputs[0], dist.inputs["Seed"])
    L(dist.outputs["Points"], inst.inputs["Points"])
    L(ico.outputs["Mesh"], setm.inputs["Geometry"])
    L(setm.outputs["Geometry"], inst.inputs["Instance"])
    L(enabled(rnd.outputs, "Value"), inst.inputs["Scale"])
    L(inst.outputs["Instances"], gout.inputs[0])
    return ng


def fire_material(P, inner, outer):
    mat = bpy.data.materials.new("Fire")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "4D"
    noise.inputs["Scale"].default_value = 1.1
    noise.inputs["Detail"].default_value = 3.0
    dist = nt.nodes.new("ShaderNodeVectorMath")
    dist.operation = "LENGTH"
    grad = nt.nodes.new("ShaderNodeMapRange")  # 1 at the pan rim -> 0 at the ring's outer edge
    grad.inputs["From Min"].default_value = inner
    grad.inputs["From Max"].default_value = outer
    grad.inputs["To Min"].default_value = 1.0
    grad.inputs["To Max"].default_value = 0.0
    boost = nt.nodes.new("ShaderNodeMath")
    boost.operation = "MULTIPLY"
    boost.inputs[1].default_value = 1.6
    mix = nt.nodes.new("ShaderNodeMath")
    mix.operation = "MULTIPLY"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    cols = P["palette"]["fire"]
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0, 0, 0, 0)
    els[1].position, els[1].color = 0.22, rgba(cols[0])
    for pos, c in ((0.34, cols[1]), (0.48, cols[2])):
        e = els.new(pos)
        e.color = rgba(c)
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.4
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    msh = nt.nodes.new("ShaderNodeMixShader")
    L = nt.links.new
    L(tex.outputs["Object"], noise.inputs["Vector"])
    L(tex.outputs["Object"], dist.inputs[0])
    L(dist.outputs["Value"], grad.inputs["Value"])
    L(noise.outputs["Fac"], mix.inputs[0])
    L(grad.outputs["Result"], mix.inputs[1])
    L(mix.outputs[0], boost.inputs[0])
    L(boost.outputs[0], ramp.inputs["Fac"])
    L(ramp.outputs["Color"], emit.inputs["Color"])
    L(ramp.outputs["Alpha"], msh.inputs["Fac"])
    L(transp.outputs[0], msh.inputs[1])
    L(emit.outputs[0], msh.inputs[2])
    L(msh.outputs[0], out.inputs["Surface"])
    # animate flames: W follows the frame, stepped by the driver expression
    fc = noise.inputs["W"].driver_add("default_value")
    fc.driver.type = "SCRIPTED"
    fc.driver.expression = "floor(frame / %d) * %d * 0.06" % (P["step"], P["step"])
    return mat


def setup_render(scene, P):
    items = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in items else "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x, scene.render.resolution_y = P["resolution"]
    scene.render.fps = P["fps"]
    scene.frame_start, scene.frame_end = 1, P["frames"]
    scene.view_settings.view_transform = "Standard"   # flat colours, no filmic desaturation
    scene.render.film_transparent = False
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bgn = world.node_tree.nodes.get("Background")
    if bgn:
        bgn.inputs["Color"].default_value = rgba(P["palette"]["bg"])


def setup_compositor(scene, warnings):
    """Glow via Glare node; API differs across 4.x/5.x, so failures are reported, not fatal."""
    try:
        if hasattr(scene, "compositing_node_group"):
            ng = bpy.data.node_groups.new("Glow", "CompositorNodeTree")
            scene.compositing_node_group = ng
            ng.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            rl = ng.nodes.new("CompositorNodeRLayers")
            glare = ng.nodes.new("CompositorNodeGlare")
            out = ng.nodes.new("NodeGroupOutput")
            ng.links.new(rl.outputs["Image"], glare.inputs["Image"])
            ng.links.new(glare.outputs["Image"], out.inputs[0])
        else:
            scene.use_nodes = True
            nt = scene.node_tree
            rl = nt.nodes.get("Render Layers") or nt.nodes.new("CompositorNodeRLayers")
            comp = nt.nodes.get("Composite") or nt.nodes.new("CompositorNodeComposite")
            glare = nt.nodes.new("CompositorNodeGlare")
            nt.links.new(rl.outputs["Image"], glare.inputs["Image"])
            nt.links.new(glare.outputs["Image"], comp.inputs["Image"])
        for name, val in (("glare_type", "FOG_GLOW"), ("quality", "MEDIUM")):
            if hasattr(glare, name):
                setattr(glare, name, val)
        for sock, val in (("Type", "Fog Glow"), ("Threshold", 0.9), ("Strength", 0.6)):
            s = glare.inputs.get(sock) if hasattr(glare.inputs, "get") else None
            if s is not None:
                try:
                    s.default_value = val
                except (TypeError, ValueError):
                    pass
    except Exception as exc:  # compositor is optional polish
        warnings.append("compositor skipped: %s" % exc)


def build(P):
    rng = random.Random(P["seed"])
    warnings = []
    scene = bpy.data.scenes.new("ToonEggs")
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    coll = bpy.data.collections.new("ToonEggs")
    scene.collection.children.link(coll)
    pal = P["palette"]
    # Band thresholds are Shader-to-RGB brightness: faces pointing at the sun land in the lit
    # band, only grazing surfaces fall to the shade colour (the 2D "cel" look).
    mats = {"white": toon_material("EggWhite", pal["white"], pal["white_shade"], bands=(0.12,)),
            "yolk": toon_material("Yolk", pal["yolk"], pal["yolk_shade"], bands=(0.2,)),
            "pan": toon_material("Pan", pal["pan"], pal["pan_shade"]),
            "line": outline_material(pal["line"]),
            "stroke": flat_material("Stroke", pal["stroke"]),
            "pepper": flat_material("Pepper", pal["pepper"]),
            "highlight": flat_material("Highlight", (1.0, 0.98, 0.92)),
            "bubble": flat_material("Bubble", (1.0, 0.97, 0.88))}

    # pan: filled disc + rim + handle, all toon + outlined
    n = max(1, min(6, int(P["eggs"])))
    pan_r = 2.6 if n <= 4 else 3.3
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=64, radius=pan_r)
    pan = mesh_object("Pan", bm, coll, [mats["pan"]])
    s = pan.modifiers.new("Thickness", "SOLIDIFY")
    s.thickness = 0.12
    add_outline(pan, mats["line"], P["outline"])
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    handle = mesh_object("PanHandle", bm, coll, [mats["pan"]])
    handle.scale = (1.8, 0.28, 0.08)
    handle.location = (pan_r + 0.8, -pan_r * 0.35, 0.0)
    handle.rotation_euler.z = -0.35
    add_outline(handle, mats["line"], P["outline"] / 0.28)

    # egg layout: ring (or centre) inside the pan
    if n == 1:
        centres = [(0.0, 0.0)]
    else:
        ring = pan_r * (0.50 if n <= 4 else 0.58)
        off = rng.uniform(0, math.tau)
        centres = [(ring * math.cos(off + math.tau * k / n), ring * math.sin(off + math.tau * k / n)) for k in range(n)]
    eggs = [build_egg(k, rng, coll, mats, P, c) for k, c in enumerate(centres)]

    if P["bubbles"]:
        ng = bubble_nodes(mats["bubble"])
        for e in eggs:
            mod = e["rim"].modifiers.new("Bubbles", "NODES")
            mod.node_group = ng

    if P["fire"]:
        bm = bmesh.new()
        bmesh.ops.create_circle(bm, cap_ends=True, segments=96, radius=pan_r * 1.45)
        fire = mesh_object("FireRing", bm, coll, [fire_material(P, pan_r * 0.9, pan_r * 1.45)])
        fire.location.z = -0.3

    # light for the toon bands, orthographic top-down camera
    sun = bpy.data.lights.new("Key", "SUN")
    sun.energy = 3.0
    # Inverted-hull outline shells enclose their objects; with shadows on, every object sits in
    # its own outline's shadow and renders in the shade band. Cel shading needs only N.L bands.
    sun.use_shadow = False
    sun_obj = link_obj(bpy.data.objects.new("Key", sun), coll)
    sun_obj.rotation_euler = (math.radians(35), math.radians(-25), math.radians(40))
    cam = bpy.data.cameras.new("Cam")
    cam.type = "ORTHO"
    cam.ortho_scale = pan_r * 3.1
    cam_obj = link_obj(bpy.data.objects.new("Cam", cam), coll)
    cam_obj.location = (0.3, 0.0, 12.0)
    scene.camera = cam_obj

    setup_render(scene, P)
    setup_compositor(scene, warnings)
    scene.frame_set(1)
    return scene, {"scene": scene.name, "eggs": [{"white": e["white"].name, "expression": e["expression"]} for e in eggs],
                   "objects": len(coll.objects), "engine": scene.render.engine, "frames": P["frames"],
                   "warnings": warnings}


def render_frames(scene, out_dir, frames):
    import os
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for f in frames:
        scene.frame_set(f)
        scene.render.filepath = os.path.join(out_dir, "frame_%04d.png" % f)
        bpy.ops.render.render(write_still=True, scene=scene.name)
        written.append(scene.render.filepath)
    return written


def _cli():
    import argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--render-frames", default="")
    ap.add_argument("--save", default=None)
    ap.add_argument("--eggs", type=int, default=PARAMS["eggs"])
    ap.add_argument("--seed", type=int, default=PARAMS["seed"])
    ap.add_argument("--resolution", type=int, default=None)
    a = ap.parse_args(argv)
    P = dict(PARAMS, eggs=a.eggs, seed=a.seed)
    if a.resolution:
        P["resolution"] = (a.resolution, a.resolution)
    scene, info = build(P)
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=a.save)
    if a.out and a.render_frames:
        info["rendered"] = render_frames(scene, a.out, [int(x) for x in a.render_frames.split(",")])
    import json
    print("TOON_EGGS_RESULT " + json.dumps(info))


if "--" in sys.argv and bpy.app.background:
    _cli()
else:  # executed through the Blender Lab MCP add-on (namespace pre-seeds `result`)
    _scene, _info = build(PARAMS)
    result = _info
