---
name: blender-stylized-2d-animation
description: Build and animate stylized "2D-look" (cel/toon, anime-style) scenes in Blender through the Blender Lab MCP server or headless Blender, and animate EXISTING 2D character art without losing detail by cutting the original drawing into jointed parts (cut-out rig) instead of redrawing it. Covers flat colour bands, inverted-hull outlines, boil on twos, procedural fire, Geometry Nodes bubbles, joint pivots and limits, walk cycles with foot lock, and per-part review gates. Use when the user asks for a toon, cel-shaded, NPR, cartoon, 2D-looking or anime-style Blender animation, or wants an existing character posed, animated, or turned into a sprite set. Not for photoreal rendering.
metadata:
  short-description: Toon/2D-look Blender scenes and boil animation via MCP
---

# Stylized 2D-look animation in Blender

Technique studied from Zha Art's short "Eggs in Blender (stylized)"
(https://youtube.com/shorts/5aHML0L9tyg, 2026-09-22). Its full tutorial is
"How I Made a 2D Looking Eggs Animation in Blender! (Tutorial)". The
script here is an original, fully procedural implementation of that recipe,
tested on Blender 5.2.1 LTS with EEVEE.

## First decision: does the character already exist as art?

If the user supplies a drawing of the character, **do not rebuild or
regenerate it**. Cut the original into parts and animate the parts. Every
pixel then comes from the artist, so freckles, line weights and creases
survive. A previous run redrew a character procedurally and lost all of
them; its knees bent the wrong way, and its feet slid. Read
[references/character-cutout.md](references/character-cutout.md) first. The
work is divided, seen, then added up:

1. **Detail inventory:** list what must survive (freckles, lashes,
   highlights, seams, finger segments).
2. **Divide:** `python scripts/cutout_parts.py spec.json OUT/`, with one
   polygon, pivot, parent and z per part. The ball goes to the child part,
   and the pivot is at the ball centre. Shoulder-type joints get a fixed
   cap. Hidden ends are rebuilt with `extend`, `sweep` or `complete`.
   Gate: 0 unassigned pixels.
3. **See:** a parts sheet, 4× grid zooms at each joint, then a rest-pose
   render with `scripts/cutout_rig.py` diffed against the original (PSNR ≥
   35 dB, every inventory item intact at zoom), then a joint stress test at
   the limits.
4. **Add up:** poses and animation as joint angles with per-joint limits
   (out-of-range poses are clamped and reported). Walks use contact, down,
   passing, up, with foot lock. Compare against any poses the artist drew.
5. Views or hand shapes the artist never drew are new drawings: ask for
   them, and never invent them during animation.

```
blender -b --factory-startup --python scripts/cutout_rig.py -- OUT/ anim.json RENDERS/
```

`tests/test_cutout_parts.py` covers the cutter (no Blender needed).

## Connect

- Install the official Blender Lab MCP add-on (Blender 5.2 extension `mcp`)
  and register its MCP server with your agent. Codex example
  (`.codex/config.toml`):
  ```toml
  [mcp_servers.blender_lab]
  command = "uvx"
  args = ["--from", "git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp", "blender-mcp"]
  ```
- If the uvx Git download is blocked, use the bundled adapter instead:
  `scripts/blender_lab_local_mcp.py` talks to the running add-on on its
  default port 127.0.0.1:9876, and `python scripts/mcp_call.py <file.py>`
  sends one code file through a real MCP session. Both need
  `pip install mcp`.
- Blender must be running with the add-on enabled. For headless use, put
  `blender` on PATH or call it by its full path.
- Code sent to `execute_blender_code` runs with `result = {}` pre-defined.
  Put a JSON-serializable dict in `result`. `sys.exit` and factory-reset
  operators are blocked. For long renders, define `check_is_finished()`
  returning `None` until done, then a dict.

## Fast path

1. Edit `PARAMS` at the top of `scripts/toon_egg_scene.py` (egg count 1–6,
   seed, frames, fps, resolution, fire, bubbles, outline, step, palette).
2. Send it, from the skill folder: `python scripts/mcp_call.py scripts/toon_egg_scene.py`.
   It creates a new scene `ToonEggs` (the user's scenes are untouched) and
   returns the object count, expressions, engine, and warnings.
3. Verify visually, and don't trust the JSON alone: render frames 1 and 3
   and look at them. Headless alternative:
   `blender -b --factory-startup --python scripts/toon_egg_scene.py -- --out OUT --render-frames 1,3,5 --resolution 720 --save OUT/eggs.blend`
4. Final render: EEVEE, frames 1–48 at 24 fps, then encode with ffmpeg.

## The recipe (apply it to any subject, not just eggs)

**Part I — shapes**
- Organic flat shapes: radial grid with a noisy outline (low-frequency
  sines plus jitter) -> Solidify -> Subdivision 1, smooth shading.
- Domes: UV sphere, delete the bottom half, squash Z.
- Props (pan): filled circle + Solidify; handle from a scaled cube.

**Part II — colour and lines**
- Cel shader: Diffuse -> **Shader to RGB** -> **constant Color Ramp** (2–3
  bands) -> Emission. Pick band thresholds so lit faces land in the lit band.
- Outlines: an **inverted hull**, meaning a Solidify modifier with offset +1,
  flipped normals, and a black material with backface culling
  (`material_offset`). Scale the thickness by the object's scale.
- **Turn off cast shadows on the key light** (`light.use_shadow = False`).
  The hull encloses the object, so with shadows on, everything renders in
  the shade band. This bug was found while testing this skill.
- Painted details as geometry: highlight blob, darker strokes (thin bevelled
  curves), pepper dots.
- Character: every instance gets its own face (dot eyes or a wink line,
  brows, and a mouth curve from a small expression table), parented to the
  moving part. Use `matrix_basis.inverted()` as the parent inverse: before a
  depsgraph update, `matrix_world` is stale and features land in the wrong
  place.

**Part III — animation and finishing**
- **Boil:** a shape key with small random rim offsets, keyed flat, then an
  F-curve **Noise** modifier plus a **Stepped** modifier (`frame_step 2`) so
  it moves "on twos" like hand-drawn animation. Use the same pattern on the
  location of parts that must jitter together.
- In Blender 5.x, F-curves live in the action's channelbag:
  `bpy_extras.anim_utils.action_get_channelbag_for_slot(action, slot)`.
  `action.fcurves` is the legacy fallback.
- **Fire:** a ring mesh under the prop. 4D Noise × radial falloff (Vector
  Length -> Map Range from the pan rim to the ring edge) -> constant ramp
  (transparent -> red -> orange -> yellow). Emission is mixed with
  Transparent via the ramp's alpha. Animate W with the driver
  `floor(frame/2)*2*0.06`, which also steps on twos.
- **Bubbles:** Geometry Nodes on a rim-ring mesh: Distribute Points on
  Faces (seed = floor(Scene Time frame / 2)) -> Instance tiny Ico Spheres
  with a random scale. Only the instances are output, so the ring itself
  is invisible.
- **Compositor:** Glare (Fog Glow). The 5.x API uses
  `scene.compositing_node_group`; 4.x uses `scene.node_tree`. The script
  handles both and reports skips in `warnings`.
- Render: EEVEE, view transform **Standard** (not AgX/Filmic) for true flat
  colours, orthographic top-down camera.

## Check before delivering

- Character work: every gate in `references/character-cutout.md` passed, with
  its numbers reported (unassigned pixels, rest-pose PSNR, foot drift, clamped poses).

- Render at least two frames a few apart: the rims and flames must differ
  (proving the boil and fire animate), while the faces stay on the yolks.
- No object is fully in the shade band; outlines are visible all around.
- Save the `.blend` and state the Blender version used.
