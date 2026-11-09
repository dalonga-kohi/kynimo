# 0034 — Path operators: trim paths, round corners, repeater

- Status: accepted (extends ADR-0017's paint binding; format v5)
- Date: 2026-11-09

## Context

M4 opens with the shape operators that most motion design leans on: trim paths (draw-ons, progress rings, line reveals), round corners (soft polygons and stars, which the primitives can't round) and the repeater (radial loaders, grids, echoes). The beta also lists path morphing between equal vertex counts, which schema v1 part 2 and the engine already shipped (`pathMorphCheck`, vertex-by-vertex `mixPath`), so this item adds nothing for it.

ADR-0017 kept geometry in our own JavaScript so that start points and directions, which trims depend on, are ours. Three questions were open: which paths an operator changes, which paints see the change, and how a repeater fits a binder that pairs paints with the paths above them.

## Decision

- **Three new shape item variants, format v5.** `trim` (`start`, `end` in 0..1, `offset` in degrees, `mode` `simultaneous` | `individual`), `round-corners` (`radius`), and `repeater` (`copies` 0..1000, `offset` in steps, `composite` `above` | `below`, and a step `transform` with anchor point, position, scale ratio, rotation, start and end opacity). Every number is animatable. The 4 → 5 migration changes nothing, because all three are new variants. Values are fractions (0..1) and scale ratios, not After Effects percentages, matching the rest of the schema.
- **After Effects semantics for reach.** An operator changes every path listed above it in its group, including the paths inside groups above it. Operators apply in list order, with inner groups' operators first. A fill or stroke draws its paths as all operators leave them, wherever it sits relative to the operator. So the usual stack `path, stroke, fill, trim` trims the stroke, as in After Effects. Paths below an operator, and paths in sibling groups below it, are untouched.
- **Operators work in their own group's space.** Trim lengths and corner radii are measured where the operator sits. A path in a transformed child group is mapped up into the operator's space, changed, and mapped back by the inverse of each group's local matrix. When a group collapses (its matrix has no inverse), the path it holds has no area there, and an operator above it that changes the path leaves nothing of it. A stroke in an enclosing group would draw such a collapsed path as a line; with a changing operator above it, the line disappears for that frame instead of being trimmed or rounded. This is accepted: it only happens on the frame a flip passes through zero scale. Paths an operator leaves unchanged keep their exact coordinates, so documents without operators draw bit-identically: every golden hash and approved reference frame is unchanged.
- **Trim.** The kept window runs from the smaller of `start` and `end` to the larger, shifted by `offset / 360` of the length, wrapping around.
  - A wrapped window on a closed path comes out as one open path through the start point. On an open path it comes out as two.
  - A window of the whole length keeps the path closed and untouched; an empty window removes it.
  - `simultaneous` cuts each path by the same fractions. `individual` treats the paths, top first, as one path.
  - A fill closes a trimmed open path with a straight line, as Skia and After Effects do.
- **Round corners.** Every sharp vertex is rounded. A vertex is sharp when the segments on both sides of it have no tangent handle at that vertex, and the ends of an open path are excluded. Each side is cut back by `min(radius, half its length)`, along its arc length, so curved sides work too. The cut points are joined by a cubic whose handles reach κ (0.5519…) of the way toward the corner. For a right angle with equal cuts that is the same quarter arc a rectangle's own corner radius draws (a test checks this). Vertices with handles, like an ellipse's, are left alone. On a closed path, a rounded first vertex moves the start back to where its arc begins, as in Lottie.
- **Arc length is ours and fixed-work.** Each cubic gets a table of 32 steps, each integrated with 3-point Gauss–Legendre, and is split with de Casteljau. Lengths use `Math.sqrt`, never `Math.hypot`, whose rounding is not pinned. Relative error is below 2·10⁻⁴ on a circle, far under a pixel at composition sizes.
- **Repeater: structural, before binding.** A repeater replaces everything listed above it (paths, paints, operators and groups) with one group per copy.
  - **Placement.** Copy `i` is placed by `M^n · step(f)`, where `n + f = offset + i`. `M` is one step: translate by the position, then rotate and scale about the anchor. `step(f)` scales the position and rotation by `f` and raises the scale to the power `f`. Steps compose, so position plus rotation walks a circle, as in After Effects. Negative offsets use the inverse step; when the step has none, those copies are not drawn.
  - **Opacity.** It runs linearly from `startOpacity` on copy 0 to `endOpacity` on copy `copies − 1`. A fractional count adds one more copy at that fraction of its opacity, so an animated count fades copies in instead of popping. This is our choice: After Effects' handling of fractional counts isn't documented.
  - **Stacking.** `above` draws each copy over the one before; `below` draws it under.
  - **Opacity scope.** Copy opacity follows ADR-0017's group opacity: it applies to paints inside the copies, not to a paint below the repeater that fills the repeated paths. That paint fills all copies as one compound path.
- **A work budget per layer.** Counting items is not enough: paints and operators below a repeater act on every copy, and each wrapping trim splits every open contour in two. So a few kilobytes of document could ask for minutes of CPU or more memory than the process has. A shape layer may take at most `MAX_SHAPE_LAYER_WORK` (500 000) units per frame:
  - one per item visited, every copy counted;
  - one per segment plus one per contour, each time a path is built, read or written by an operator, or handed to a paint.

  An operator is charged three times what it reads, because its output is at most twice its input. Every charge is made before the work it pays for, so a refused layer fails fast with a `RenderError` that says what to lower, before building anything large. The worst accepted layers take about half a second per frame. Ordinary heavy layers fit easily, e.g. 1000 copies of a rounded, filled and stroked rectangle.
- **And a work budget per frame.** The evaluation budget (ADR-0015) counts a repeater as one item, so many layers, or one precomp placed many times, could each fit the layer budget and still add up to minutes. Every shape layer of a frame, precomps included, also charges one shared `MAX_FRAME_SHAPE_WORK` (2 000 000 units), the same way the frame's raster pixels are budgeted (ADR-0017). The capability manifest states both limits.

## Consequences

- After Effects and Lottie operator stacks map one to one, so SVG/Lottie import and agents' After Effects knowledge carry over. Item order matters even more than before, and the tool docs that explain binding now cover operators too.
- Operators re-run every frame on CPU. A trim over a long path costs one arc-length table per cubic, so a frame stays in the milliseconds. Caching contours between frames is an optimization for when exports need it (M7).
- The repeater shares the items it copies instead of cloning them, so expansion is cheap. Each copy still gets its own path slots, because operators below the repeater change copies independently.
- `offset paths` and `merge paths` (v1.x) fit the same slot model: both are operators over the paths above them. Merge paths will also need to treat the paints above it specially, as After Effects does.
- Not settled here: whether a repeater's copy opacity should also dim an enclosing paint that reaches into the copies. We follow ADR-0017's rule; if imported After Effects files disagree, the change is renderer-only.
