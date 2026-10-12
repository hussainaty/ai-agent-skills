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
- Lessons from independent review
- Limbs with bones (skins)
- Faces: blinking and speaking
- Practices borrowed from other animation skills
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
| A straight rod disappears under a part (vertical) | `extend` (repeat one clean row; a list for both ends) | thigh rods under the torso and under the knee balls; antenna stems behind the helmet |
| A cut ran along a rod's edge and took its outline, or the rod's end is hidden | `rod` (rebuild from a clean cross-section, scaled to the measured taper, bilinear; rounded inked tip; visible pixels kept) | upper-arm rods that touched the torso |
| A body edge under a limb | `complete` (silhouette polygons filled with smoothed body colour, then the measured contour inked, both anti-aliased) | torso sides under the arms |
| The top of a ball joint under another piece | `complete` with `radial` (hidden pixels take the ball's own colour-by-radius profile) | elbow balls under the rod tips |
| A hairline opens between two outlines as a part lifts off its neighbour | `underlay` (a patch: the part's silhouette grown 2 px, in outline colour, attached to the part but layered behind the neighbour) | upper arms against the torso |
| No single image is right both at rest and when raised | `alt` (a second drawing of the part; the rig swaps it in above an angle) | an upper arm whose top carries part of the shoulder drawing |

**This is the studio "patch".** Toon Boom Harmony hides joint lines with a
patch articulation: a colour-fill layer that covers the joint, so the line
between two pieces never shows. `complete`, `radial` and the hidden rod ends
do the same job here: whatever a moving joint uncovers is already painted in
the piece behind it.

**Do not chase hairlines by nudging edges.** Moving a rebuilt edge by a
pixel closed a gap on one frame and opened one lower down on another: as a
limb lifts off the body, a thin gap must open somewhere. The `underlay`
patch fixes the cause. It took the every-frame gate from 15 failing frames
of 118 to the last few pixels, without changing the rest pose. Keep the
patch 2 px clear of soft rim pixels, or it shows through at rest (the
rest-pose gate caught this: 37.5 dB fell to 34.0).

**Cut where the drawing's own lines are.** An antenna stem that flows into a
helmet has the helmet's rim lines crossing its base. A flat cut across the
stem took rim pixels with the antenna and left a notch when it tilted. The
cut belongs just above the first rim line, so the helmet keeps its whole rim
and the stem tucks behind it.

**Never sample past a clean cross-section.** A rod rebuild that read one
pixel beyond the source's edge picked up a neighbour's stray fragment and
printed it as a dotted trail along the whole rod. `rod` now clamps to the
cross-section and clears anything beyond it.

**Leave no limb pixel in the wrong piece.** A cut that is a pixel or two
tight at a rod tip leaves rod-coloured pixels in the next piece; they travel
with it and show as a pale wedge when the joint bends. Cut tips a few pixels
generous, and let the piece behind be completed underneath.

**Remove the page matte.** Outline rim pixels in a flattened image are
blended with the page colour. Over the page that is invisible; over another
part it is a pale fringe. `defringe` (on by default) turns each rim pixel
into the outline colour with partial alpha. On the robot this alone raised
the rest-pose match and removed the "double line" on moved arms.

**Use a drawing swap when one image cannot serve two poses.** The top of
the robot's upper arm carries the lower half of the artist's shoulder
shading. It belongs there at rest and reads as a streak when the arm is
raised. Rebuilding it made the rest pose wrong (a "pipe" look); keeping it
left the streak. Cut-out animators keep two drawings and switch. The `alt`
op writes `<name>__alt.png`, and the rig shows it while the joint is more
than `above_deg` from rest (20° here), cross-fading over ±6° so the
change never pops. Once a part has a swap, leave its
first drawing as the artist's untouched pixels (plus the tip hidden under
the cap, and a trim of stray neighbour pixels). Re-inking it as well put a
hatched patch on the low-angle arm; removing that work raised the rest-pose
match from 36.8 to 38.4 dB.

**Read the overlap before cutting a joint.** Zoom in and see which piece is
drawn in front. On the robot, the upper arm ends in a rounded tip drawn *in
front of* the elbow ball. A straight cut across the elbow sliced that tip in
two, and both halves showed as chips when the elbow bent. The correct cut
follows the rounded tip, puts the upper arm above the forearm in z, and
completes the ball's hidden top as a full circle.

**A rebuilt part must not change the rest pose.** The first rod rebuild
overwrote visible pixels and turned each arm into a pipe pushed into the
shoulder; the rest-pose gate dropped to 34.5 dB and caught it. Keep visible
original pixels; write only missing or hidden ones.

Do not borrow hidden areas from a different drawing of the character unless
it registers exactly. On the robot, the artist's arms-up drawing has a
narrower torso (best alignment correlation 0.73), so transplanting it would
have brought back drift. The best input of all is a layered file (PSD) in
which the artist drew every part complete. Ask for it when it exists.

## Motion rules

Generate motion with `scripts/cutout_motion.py` (dense per-frame keys from a
rig map), then adjust. It encodes the rules below. Sparse hand-set poses
with default interpolation look mechanical.

- **Successive breaking of joints.** A limb is a chain: the shoulder leads,
  the elbow repeats the motion about 2 frames later, the wrist about 4 frames
  later. The head leads the antennae (or hair, ears) by about 3 frames. This
  one rule is most of the difference between jointed and stiff.
- **Slow in, slow out.** Smoothstep every transition; use sines for cycles.
  Key every frame (on ones) at 24 fps for smooth motion.
- **Anticipation, overshoot, settle.** Before a big move, a small move the
  other way (a dip before raising an arm). After it, go slightly past the
  pose and come back.
- **Walk:** contact -> down -> passing -> up -> contact, mirrored. A child
  takes about 10 frames per step with a bigger bounce; an adult about 12.
  Down is lowest, passing has the free foot highest, up is highest.
- **Foot lock.** The standing foot must not move. The body bobs, and the
  planted leg slides by the opposite amount (its hidden top, rebuilt with
  `extend`, slides under the torso).
- **The pelvis tilts; the standing leg stays vertical.** When the torso
  leans over the standing leg, the legs are its children and would swing
  with it, sliding the feet sideways. Counter-rotate each thigh by the lean
  and cancel the hip's small rise (`hip_dx` in the rig map). Measure both
  vertical and horizontal foot drift.
- **Opposition.** Arms swing against the legs; the head counter-tilts
  against the torso, a couple of frames late.
- **Front-view walks are subtle.** Most of a walk happens toward the
  camera. A front view shows the bob, the foot lift, the weight shift and
  the arm swing. A profile walk needs a profile drawing.
- **Gestures:** keep the hand clear of the face; let the hand drag behind
  the forearm on each beat.

## Gates and numbers

| Gate | Pass | Tool |
|---|---|---|
| Cut coverage | 0 unassigned foreground pixels | `cutout_parts.py` exit code, `review.png` |
| Parts clean | No neighbour strips, stubs, or missing outlines | parts sheet, 4× zooms |
| Rest reassembly | PSNR ≥ 35 dB; every inventory item matches at zoom | `cutout_rig.py` + diff |
| Joints | No gaps, stubs, or smears at the limits; bad poses clamped | joint stress sheet, `report.json` |
| Feet | Standing-foot drift ≤ 3 px per step, vertical and horizontal | lowest opaque pixel and its x-centre per frame |
| Posed edges, every frame | No detached fragments; no new pinholes (small enclosed gaps at a joint); un-inked silhouette edge no more than 1.5 points above the rest pose | `scripts/cutout_check.py REST.png "renders/*.png" --summary` |
| Posed joints, by eye | 3x zooms of every joint in the most extreme delivered frames, and the frames at 1x | zoom sheet; an independent reviewer |
| Poses | Close to any artist-drawn version of the same pose | side-by-side sheet |

Render settings matter for line art. Use **Linear** texture interpolation
(Cubic is a smoothing B-spline that blurs outlines) and a pixel filter
around 0.5 px (EEVEE's default of 1.5 px softens every edge). Use the
Standard view transform, emission shading, and an orthographic camera at 1
texture pixel per screen pixel. On the robot, these two settings moved the
rest-pose diff from 26.3 dB to 37.4 dB.

## Lessons from independent review

Three rounds of blind review (three reviewers each, with different lenses:
a rigging supervisor hunting defects, an animation director auditing the
motion, and a builder arguing to ship) judged this work. The first two
rounds rejected versions that had passed every automated gate; the third
accepted two to one, and the dissent's finding was fixed afterwards. What
they found:

- **The rest-pose diff cannot see hidden areas.** Everything rebuilt is
  hidden at rest by design, so a 37 dB rest pose says nothing about a raised
  arm. Posed frames need their own checks: the edge gate, 3x zooms, and a
  look at 1x.
- **Measure the defect at delivery size.** A streak described as "about
  8 px" was 25 px and visible at 1x for two thirds of a shot. Check the
  delivered frames, not only the zooms.
- **A one-way move is not a swing.** Arms that only opened outward read as
  a wing flapping. A swing passes through the rest pose in both directions.
  The opposite mistake came next: a 3.5 degree swing was correct and
  invisible. Amplitudes have to be large enough to read (about 7 degrees at
  the shoulder, 12 at the elbow for a child's walk seen from the front).
- **Weight leads the step.** The pelvis should arrive over the standing
  foot about 2 frames before the other foot lifts.
- **Reject advice that breaks anatomy.** One reviewer asked for a bigger
  sideways knee bend. In a front view the knee bends toward the camera, so
  the free leg rises by sliding under the torso, with only a small outward
  swing.
- **Judge motion as motion.** Stills and parameters cannot show whether a
  swing reads. Deliver a GIF or MP4 and have it watched.

## Limbs with bones (skins)

Rigid pieces always have a seam at each joint, and every seam needs a repair.
A limb can instead be one flexible sheet bent by bones, which has no seam at
the bent joint at all. Add a top-level `skins` entry to the spec:

```json
"skins": [{"name": "arm_r",
           "layers": ["forearm_r", "upper_arm_r"],
           "alt_layers": ["forearm_r", "upper_arm_r__alt"], "alt_above_deg": 13,
           "joints": ["upper_arm_r", "forearm_r"], "z": 8, "blend": 10}]
```

The cutter flattens the listed part images (back to front) into one image.
The rig draws it on a fine grid mesh with an armature: each bone copies its
joint's transform, and the weights blend from the first joint to the second
across ±`blend` pixels around the second joint's pivot. The same joint
animation drives rigid parts and skins, so motion data does not change.

- Still cut and repair the parts first. The skin is built from them, so the
  rod tip, the completed ball and the clean alt drawing all carry over.
- Keep the drawing swap on the skin (`alt_layers`). A skin made only from the
  clean raised drawing dropped the rest-pose match from 35.8 to 32.8 dB.
- Keep hands, heads and bodies as rigid planes. A hand hangs from the wrist
  joint as before; the wrist ball covers the join.
- On the reference robot this removed every chip and wedge at the elbows,
  including in the extreme stress pose, and the every-frame gate passed.
- For a soft character with an artist's layered file, weight the whole limb
  by hand in Blender (or use Spine or Live2D) instead of this two-bone blend.

## Faces: blinking and speaking

Eyes and a mouth can be cut from the same flat drawing.

**Eyes.** Each eye (outline, iris, highlights) is its own part with the
pivot at its centre. A blink scales it vertically (`"eye_l@scale": [1, 0.1]`):
closed in 2 frames, held for 1, open again over 3. The head's `complete` op
fills the socket behind it; use `"soft": false`, `"grow": 2` and a high
`min_luma` so the fill is opaque to its edge and seeded only by clean skin.
A squashed eye is a stand-in for a drawn eyelid. It reads at speed, but ask
the artist for a closed-eye drawing when the blink must hold.

**Mouth.** Split a closed smile into three layers:

| Layer | Content | Motion |
|---|---|---|
| upper lip (`lip_top`) | upper line, the teeth wedge, the skin just above | never moves vertically |
| lower lip (`jaw`, `line_only`) | the lower line only | scales vertically about the mouth corners |
| interior (`mouth_in`, `paint`) | a flat dark fill; the one synthetic element | scales with the lower lip |

Put the cut just above the lower line. Paint the interior at its fully open
size with `"anywhere": true` and give the part `rest_scale` so it shrinks to
exactly the hidden area at rest: shrinking a raster stays smooth, stretching
shows steps. The lower lip scales about the corners, so the corners stay put
and the middle drops, as a jaw does.

**Bleed the colours.** Light parts on a light face showed a thin grey box
and rings. Transparent pixels are stored as black, and a renderer that filters
straight-alpha textures blends that black into each part's edge. The cutter
now extends every part's colours outward under its transparent surroundings
(`bleed_rgb`), which removed them.

**Lip-sync.** `cutout_motion.py` takes a list of mouth shapes (visemes) with
frame counts and builds the track. The rules it encodes:

- Only sounds made at the lips and teeth are visible. Sounds from the back
  of the mouth and throat take the shape of the vowel beside them. (For
  Arabic: ب and م close the lips; ح and هـ show as their vowel.)
- A lip closure is held for at least 3 frames and is never softened by
  blending. A ب or م that does not close is the most visible lip-sync error.
- Lips part and meet over two or three frames. A test caught a one-frame
  snap from shut to fully open and it was fixed by easing the release.
- Vowels set the opening: widest on a long ā, narrow and spread on i.
- The body keeps moving under the speech: breathing, a small head dip into
  each long vowel, a light hand gesture, blinks.

The built-in phrase is the basmala, "bismi llāhi r-raḥmāni r-raḥīm", as 24
shapes over about 3.5 seconds. Add another phrase as a list of
`(shape, frames)` pairs.

## Practices borrowed from other animation skills

- **Contact sheet and frame-difference report**
  (`scripts/contact_sheet.py "renders/walk_*.png" sheet.png`), after
  cc-blender-skill's animation quality gate: no shot is accepted without one.
  A spike between two frames is a pop; a loop is clean when the last-to-first
  change is close to its neighbours.
- **Variants for a person to choose.** No instrument grades whether motion
  feels right (rig-c makes this explicit with a vote). When timing or
  amplitude is a judgment call, render two or three variants (for example
  `--style kid` and `--style adult`) and let the person pick.
- **Separate eyes and mouth** (OpenMontage's rigging checklist): pupils and
  lids as their own parts when the gaze or a blink must change; mouth shapes
  as separate drawings.

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
- Successive breaking of joints and drag (shoulder, elbow, wrist, fingers in turn):
  https://courses.cs.washington.edu/courses/cse459/12au/assignments/assignment_5/successive_breaking_of_joints.html,
  https://brianlemay.com/Pages/animationschool/animation/1stsemesteranimation/10armswing/10armswing.html
- Children move with a faster cadence than adults (gait features):
  https://init.cise.ufl.edu/?p=2542
- Toon Boom Harmony patch articulation (a colour-fill layer that covers joint lines):
  https://docs.toonboom.com/help/harmony-12-2/advanced/rigging/patch-articulation.html
- Spine meshes and weights (a limb as one skinned mesh): https://en.esotericsoftware.com/spine-in-depth
- Which Arabic sounds are visible on the face (lips and teeth are; back and throat consonants are not), Ouni et al.,
  "Visual speech intelligibility in Arabic", Interspeech 2007: https://www.isca-archive.org/interspeech_2007/ouni07_interspeech.pdf
- Why generated characters drift (no identity memory between generations):
  https://getimg.ai/blog/how-to-create-consistent-characters-with-ai
