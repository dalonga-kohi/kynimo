# 0014 — Engine interpolation

- Status: accepted
- Date: 2026-11-06

## Context

`@kynimo/engine` turns keyframe tracks (ADR-0009) into values at a frame. How colors blend, how easing maps onto motion paths and where out-of-range values are handled all change rendered pixels, so changing them later changes how existing documents render. They are decided once here.

## Decision

- **Easing is a progress function, mixing is per type.** Each segment's interpolation (linear, hold, cubic-bezier, spring) yields an unclamped progress `p` between its two keyframes. A type-specific mixer then combines the values. New value types only add a mixer.
- **Exact keyframes.** Mixers return the stored value exactly at `p = 0` and `p = 1`, and a keyframe's own frame starts its segment. Every stored keyframe value is therefore the value rendered at that frame (the spring note in CAPABILITIES §6).
- **Cubic-bezier** is CSS-style, solved with a fixed number of Newton steps and a bisection fallback, so results don't depend on timing.
- **Springs** are the closed-form damped harmonic oscillator released from rest (under-, critically and over-damped), with damping ratio and response period. Progress is exactly 1 from `springSettleFrames` (in `@kynimo/scene`) onward. Validation and evaluation share that definition, and no velocity carries into the next segment.
- **Vectors are N-dimensional** (`readonly number[]`), so 3D (ADR-0013) needs no new math.
- **Colors mix in OKLab with premultiplied alpha** (as in CSS `color-mix`): even perceptual steps, no muddy midpoints, and fades from transparent keep the target's hue. The result is float sRGB RGBA, clipped to the gamut and with alpha clamped to 0..1. The renderer quantizes it once.
- **Spatial motion paths** are cubic beziers `from → from + outTangent → to + inTangent → to`, parameterized by **arc length**, so temporal easing controls speed along the path exactly, as in After Effects. Arc length comes from a fixed 128-chord table per segment. Overshoot continues along the end tangent. Segments without handles are straight lines.
- **No clamping to property domains here.** Bezier overshoot and springs may push values out of range (opacity above 1, a negative radius). The document evaluator clamps per property, because only the property knows its domain. Colors are the exception, since their domain is fixed.
- Pure functions only. `Math.exp`/`cos`/`sin`/`cbrt`/`**` carry the cross-engine caveat already accepted in ADR-0009.

## Consequences

- Switching the color space, the arc-length table size or the solver would shift rendered pixels, so it counts as a rendering change and needs a version gate or migration.
- Motion paths rebuild their arc-length table on every sample. That is cheap (128 points) but can be cached per segment if profiling shows a need.
- Colors on paths, gradients and per-dimension spatial paths (v1.x) reuse these primitives.
- Roving keyframes (`later`) need arc length across segments and will build on `cubicPath`.
