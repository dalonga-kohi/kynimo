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
- **Transforms.** Screen space, +y down, degrees clockwise. The local matrix is `translate(position) · rotate · skewX · scale · translate(-anchorPoint)` (After Effects order), and rotations by multiples of 90° are exact. Each layer carries its sampled local values and a matrix from layer space to composition space.
- **Parenting follows After Effects.** Children inherit the full transform chain but not opacity. Parents drive children even while hidden or outside their own in/out range.
- **Domain clamps** (ADR-0014 left them to the evaluator): opacities clamp to 0..1, skew to ±85°, and sizes, radii, widths, font size, leading and volume to at least 0. Gradient stop offsets clamp to 0..1 and stay non-decreasing. Scale, rotation and tracking are not clamped.
- **Nested backgrounds are transparent.** Only the evaluated root composition reports its background.
- **Shared precomps are evaluated once per local frame within a call.** The output is then a DAG, and its size stays linear in compositions even for hostile documents that place a composition many times at many levels.
- Component and adjustment layers pass through unevaluated until M6 (components) and M4 (effects).

## Consequences

- Changing the transform order, the clamps or the frame-rate mapping changes rendered pixels and needs a version gate or migration.
- Results are shared objects and must be treated as read-only. Serializing one expands shared subtrees.
- Precomps at fractional rates hold frames. A future "sample at parent time" option (motion blur, time remap in v1.x) would add fractional evaluation beside this, not replace it.
- 3D (ADR-0013) adds a 4x4 matrix type next to `Affine`, keeping the same tree.
