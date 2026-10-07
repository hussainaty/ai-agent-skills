# Animating an existing character: cut out, never redraw

Use this whenever a character already exists as artwork (a PNG, JPG, PSD, or
a model sheet) and the job is to pose it, animate it, or make a sprite set.
The art is the source of truth. The job is to **move the artist's pixels**,
not to draw a new character that looks similar.

## Contents

- Why the previous attempt failed
- The rule
- Divide, see, add up (the workflow)
- Joint rules
- Hidden parts
- Motion rules
- Gates and numbers
- What one drawing cannot give you
- Sources

## Why the previous attempt failed

A real failure on a blue robot character (2026-10-08) is the reference case.
The agent rebuilt the character procedurally (ellipses, polygons, generated
lines) and then animated the rebuild:

| Symptom | Root cause |
|---|---|
| Freckles, eyelashes, line-weight variation, boot creases and highlights gone | The character was **redrawn**. Anything the code did not model was lost. |
| The face changed (stiff ring eyes, different smile) | Redrawing re-interprets. Image generators drift the same way: each output starts from noise with no memory of the character. |
| Hands became rakes; the helmet changed shape | No per-part comparison against the original. |
| Profile, back and three-quarter views invented | Views that were never drawn were made up, so each was off-model in a different way. |
| Knees bent the wrong way; legs disconnected from the hips | No pivots at the real joints and no joint limits. |
| A walk that barely moved, with sliding feet | No key poses (contact, down, passing, up) and no foot lock. |

## The rule

1. Never redraw or regenerate a character that already exists. Cut the
   original art into parts and transform the parts (rotate, move, layer).
   Every output pixel then comes from the artist, so the details survive by
   construction.
2. Art is a task to divide. Split it into parts, check each part on its own,
   then assemble. A whole-image glance hides small losses.
3. A pose or view the artist never drew is a new drawing. Ask for it, or
   treat it as a separate art task with its own review against the model
   sheet. Do not invent it during animation.

## Divide, see, add up

1. **Detail inventory.** Before cutting, list what must survive: freckles
   (count them), eye highlights, lashes, line weights, specular highlights,
   seams and creases, joint balls, finger segments, ear/antenna parts. This
   list is the checklist for every later gate.
2. **Divide** with `scripts/cutout_parts.py spec.json OUT/`. The spec lists
   each part's cut polygon, joint pivot, parent and z (draw order). The first
   matching polygon wins, so list small parts before the big ones they
   overlap. The background is flood-filled from the border, so white areas
   inside outlines (face screen, chest highlight) are kept.
3. **See the parts.**
   - The cutter writes `review.png` (each part tinted, unassigned pixels in
     magenta, pivots circled). The gate is **0 unassigned pixels** (exit code 0).
   - Build a parts sheet with every part on a checkerboard, pivot marked.
     Look for: a piece of a neighbour stuck to a part (a strip of torso on an
     arm), a part missing its own outline, or stubs left behind (an antenna
     stem stub on the helmet).
   - Zoom at 4× with a coordinate grid on each joint boundary to place cuts
     on the real outlines.
4. **Reassemble at rest and diff.** Render the rest pose with
   `scripts/cutout_rig.py` and compare it with the original. Gate: PSNR of
   35 dB or more, and a side-by-side zoom of each item in the detail
   inventory. On the robot this measured 37.4 dB, a mean difference of 0.98
   levels, and all freckles and boot lines intact.
5. **Joint stress test.** Render every joint at its limits. Look for gaps,
   stubs, smears, and parts crossing the face. Fix the cuts or tighten the
   limits, then repeat.
6. **Add up: poses and motion.** Write poses as joint angles in an anim
   JSON. Render, build sheets, and compare against any poses the artist did
   draw.
7. **Deliver** the GIF/MP4, frame PNGs, sheets, and the numbers from each
   gate.

## Joint rules

- **The ball belongs to the child.** Elbow ball -> forearm, knee ball ->
  shin, wrist ball -> hand. The pivot is the ball's centre, so turning the
  child keeps the ball in place and never opens a gap.
- **Joint caps.** When the joint is the rounded end of the parent-side
  piece (a shoulder), cut that cap into its own part, fixed to the body and
  drawn above the limb. The limb turns under it, around the cap centre. This
  is the overlapping-circle joint that cut-out riggers use.
- **Pivots never change after keyframing starts.** Set them once, during
  rigging.
- **Limits per joint**, relative to the parent, in the anim JSON. The rig
  clamps anything outside the range and lists it in `report.json`. Front-view
  knees allow only a few degrees of sideways bend: a knee bends toward or
  away from the camera, which a front view cannot show by rotation.
- **Draw order is anatomy.** Antennae behind the helmet; thighs behind the
  torso; arms in front of the torso; shoulder caps above the arms.

## Hidden parts

A flat drawing has no pixels where one part covers another. When the front
part moves, a hole or a stub appears. Rebuild only pixels that a part in
front hides at rest. The rest pose then stays identical, and the rebuilt
pixels only show when a joint moves.

| Case | Spec op | Example |
|---|---|---|
| A straight rod disappears under a part (vertical) | `extend` (repeat one clean row) | thigh rods under the torso; antenna stems behind the helmet |
| A straight rod at an angle | `sweep` (slide a clean cross-section along the axis) | upper-arm rod under a fixed shoulder cap |
| A body edge under a limb | `complete` (silhouette polygons filled with body colour, outline pixels excluded, then the measured contour inked in the part's own outline colour) | torso sides and corners under the arms |

Do not borrow hidden areas from a different drawing of the character unless
it registers exactly. On the robot, the artist's arms-up drawing has a
narrower torso (best alignment correlation 0.73), so transplanting it would
have brought back drift. The best input of all is a layered file (PSD) in
which the artist drew every part complete. Ask for it when it exists.

## Motion rules

- **Walk (24 frames, 2 steps):** contact (1) -> down (4) -> passing (7) ->
  up (10) -> contact (13), mirrored. Down is lowest, passing has the free
  foot at its highest, and up is highest.
- **Foot lock.** The standing foot must not slide. In a cut-out, move the
  body up and down and slide the standing leg by the opposite amount (its
  hidden top, rebuilt with `extend`, slides under the torso). Do not move
  the root sideways while a foot is planted. Measure it: on the robot, the
  standing foot stayed within ±2 px across each half-cycle while the free
  foot rose 30–39 px.
- **Opposition and overlap.** Arms swing against the legs. The head
  counter-tilts against the torso. Antennae, hair and other loose parts lag
  the head by a few frames (follow-through).
- **Front-view walks are subtle.** Most of a walk happens toward the
  camera. A front view shows the bob, the foot lift, the weight shift and
  the arm swing. A profile walk needs a profile drawing.
- **Waves and gestures:** a ready pose, then 2–4 beats alternating
  forearm and hand angles, then settle. Keep the hand clear of the face.

## Gates and numbers

| Gate | Pass | Tool |
|---|---|---|
| Cut coverage | 0 unassigned foreground pixels | `cutout_parts.py` exit code, `review.png` |
| Parts clean | No neighbour strips, stubs, or missing outlines | parts sheet, 4× zooms |
| Rest reassembly | PSNR ≥ 35 dB; every inventory item matches at zoom | `cutout_rig.py` + diff |
| Joints | No gaps, stubs, or smears at the limits; bad poses clamped | joint stress sheet, `report.json` |
| Feet | Standing-foot drift ≤ 3 px per step | lowest opaque pixel per frame |
| Poses | Close to any artist-drawn version of the same pose | side-by-side sheet |

Render settings matter for line art. Use **Linear** texture interpolation
(Cubic is a smoothing B-spline that blurs outlines) and a pixel filter
around 0.5 px (EEVEE's default of 1.5 px softens every edge). Use the
Standard view transform, emission shading, and an orthographic camera at 1
texture pixel per screen pixel. On the robot, these two settings moved the
rest-pose diff from 26.3 dB to 37.4 dB.

## What one drawing cannot give you

- **New views** (profile, back, three-quarter): these need the artist's
  turnaround drawings. Each view becomes its own cut-out rig. Do not
  generate them inside the animation step.
- **New hand shapes or expressions** (palm-up, fist, blink): cut-out
  animation swaps in drawings from a library. Ask the artist for the
  missing drawings, or treat each one as a separate, reviewed art task.
- **Extreme joint angles:** past about 70–80° at a shoulder, a single
  drawing runs out of hidden area. Limit the joint or get a drawing for that
  pose.

## Sources

- Toon Boom Harmony, *Setting up the pivots* and *How to rig a cut-out
  character*: pivots on the major joints, set before animating and never
  changed afterwards; parts broken into layers in a hierarchy.
  https://docs.toonboom.com/help/harmony/Content/HAR/Stage/018_Deformation/059i_H3_Setting_Up_the_Pivots.html,
  https://docs.toonboom.com/help/harmony-24/premium/getting-started/character-building.html
- COA Tools / COA Tools 2 (2D cut-out rigging in Blender from PSD layers):
  https://github.com/Aodaruma/coa_tools2
- Walk key poses (contact, down, passing, up), hips versus shoulders, and
  arm swing, after Richard Williams' *The Animator's Survival Kit*:
  https://courses.cs.washington.edu/courses/cse459/19au/assignments/assignment_5/index.html
- Why generated characters drift (no identity memory between generations):
  https://getimg.ai/blog/how-to-create-consistent-characters-with-ai
