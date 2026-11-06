# 0015 — Frame evaluation

- Status: accepted
- Date: 2026-11-06

## Context

The renderer (M2), `describe_motion` and the quality checks (M5) all need the document resolved at one frame: plain values instead of keyframe tracks, parenting turned into transforms, precomps resolved. How visibility, parenting, precomp time and coordinate math work changes rendered pixels, so it is decided once, here, in `@kynimo/engine` (`evaluateFrame`).

## Decision

- **Output is a resolved tree, not a draw list.** `evaluateFrame(project, frame, compositionId?)` returns the composition's drawable layers top-first. A precomp layer nests its composition's resolved tree, so blend modes, mattes, effects and the later collapse option keep their group boundary. Every animatable property is resolved, so the renderer never reads tracks.
- **Visibility.** A layer draws on `inFrame <= frame < outFrame` unless it is hidden. Solo applies per composition and covers audio too: once any layer is soloed, only soloed layers render or play. Null layers drive their children but are not in the output. Audio layers that play are listed separately with their volume.
- **Time.** Integer frames only. Each layer samples its tracks at its own layer time `frame - startFrame`. The root frame must lie inside the composition. A precomp shows nothing (`composition: null`) when its local frame falls outside the nested composition.
- **Precomps across frame rates** map content time with exact integer (BigInt) math, floored to the nested composition's own frames (After Effects "preserve frame rate"). That keeps every frame an integer and makes NTSC rates exact.
- **Transforms.** Screen space, +y down, degrees clockwise. The local matrix is `translate(position) · rotate · skew · scale · translate(-anchorPoint)` (After Effects order), and rotations by multiples of 90° are exact. Positive skew leans the top edge right, as in After Effects and Lottie (`x' = x − tan(skew)·y`, i.e. CSS `skewX(-skew)`), so imported Lottie skews keep their direction. Each layer carries its sampled local values and a matrix from layer space to composition space.
- **Parenting follows After Effects.** Children inherit the full transform chain but not opacity. Parents drive children even while hidden or outside their own in/out range.
- **Domain clamps** (ADR-0014 left them to the evaluator): opacities clamp to 0..1, skew to ±85°, and sizes, radii, widths, font size, leading and volume to at least 0. Gradient stop offsets clamp to 0..1 and stay non-decreasing. Scale, rotation and tracking are not clamped.
- **Nested backgrounds are transparent.** Only the evaluated root composition reports its background.
- **Shared precomps are evaluated once per local frame within a call**, so the output is a DAG. That collapses copies at the same offset, not copies at different start frames: N placements of N placements of N layers is N³ work. Each call therefore has a work budget inside precomps, `MAX_EVALUATION_UNITS` = 1,000,000 units: 1 per layer, plus 1 per shape item, path vertex and gradient stop, summed over every distinct (composition, local frame) a precomp evaluates. Cached results and the root composition cost nothing, because root work is already linear in the document. Going over the budget throws a `RangeError` that names the composition and the precomp chain, so a few MB of hostile JSON cannot exhaust a worker's memory. For scale: a 1000-layer composition shown at 1000 different offsets costs 1,000,000, so large staggered templates can hit the limit.
- Component and adjustment layers pass through unevaluated until M6 (components) and M4 (effects).

## Consequences

- Changing the transform order, the clamps or the frame-rate mapping changes rendered pixels and needs a version gate or migration.
- Results are shared objects (with the document and between precomp instances) and must be treated as read-only. Serializing one expands shared subtrees.
- The budget is a per-frame limit, not a schema rule: a document can validate and still be refused at some frames. If real projects approach it, add a schema-level cap on precomp placements so the error appears on save instead.
- Precomps at fractional rates hold frames. A future "sample at parent time" option (motion blur, time remap in v1.x) would add fractional evaluation beside this, not replace it.
- 3D (ADR-0013) adds a 4x4 matrix type next to `Affine`, keeping the same tree.
