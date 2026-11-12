# 0053 — Transform motion blur

- Status: accepted
- Date: 2026-11-12

## Context

Fast motion strobes at 24 to 60 fps: a title that crosses the frame in six frames reads as a few separate copies instead of one moving object. After Effects solves it with motion blur, a per-layer switch plus a composition shutter. The roadmap listed it for v1.x; it was pulled forward at the user's request. Rendering must stay deterministic (same document and frame, same pixels), and the scene graph stays the only source of truth.

PR #57 (beat markers) also claims scene format 10 and ADR-0052. Whichever of the two merges second renumbers its format bump, migration and ADR.

## Decision

- **Per-layer settings.** Drawn layers (everything but audio, null and adjustment layers) gain `motionBlur`: `null` (the default, off) or `{ shutterAngle, shutterPhase, samples }` with defaults 180 degrees, -90 degrees and 16 samples (bounds 0 to 720, -360 to 360, integer 2 to 64). It is not a composition setting: there is no composition-update operation, and agents set it on the layers they animate. `updateLayer` takes `motionBlur` like any other layer field; `{}` stores the defaults. A null layer's motion still blurs its blurred children through parenting.
- **Sample times.** For frame `f`, sample `i` of `n` is evaluated at `f + shutterPhase / 360 + (shutterAngle / 360) * ((i + 0.5) / n)`. The defaults give a half-frame shutter centred on the frame, as in After Effects. The engine samples the layer's world matrix and own opacity at those times (position, scale, rotation, skew, parent chains and behaviors all included) and returns them next to the centre-frame values.
- **Transform-only blur.** Only the transform and opacity are sampled. Contents (text animators, shape paths, a precomp's inner layers, video frames, effect parameters) are drawn once, at the centre frame, and moved rigidly along the sampled placements. Blurring contents means re-evaluating and re-rasterizing them N times, which multiplies raster cost by N for the layers that are most expensive already. That is deferred.
- **Accumulation.** The renderer plans, per sample, a `delta = M_i * inverse(M_centre)` that takes the centre placement to the sample placement, so one rule serves composition-space rasters (shapes, text) and layer-space ones (solids, images, precomps, generators). Both compositors draw the layer once per sample and sum the results, weighted `opacity_i / n`, on RGBA16F, premultiplied and additive. A track matte or mask applies after the sum. Because the mapping is linear, blur-then-matte equals matting each sample and then summing, so the cheaper order is exact. A blurred matte source is blurred before it is used as a matte.
- **Static layers.** When every sample equals the centre transform and opacity, or the centre matrix is singular, the plan carries no motion and the layer draws once exactly as an unblurred layer. Output is byte-identical to blur off.
- **Budgets.** The engine charges every transform resolution (each chain link at each sample time, memoized) against `MAX_FRAME_MOTION_TRANSFORMS = 65 536` per `evaluateFrame` call and throws a `RangeError` naming the layer. The renderer charges `width * height * samples` per blurred layer against the existing per-frame effect-sample budget (`MAX_FRAME_EFFECT_SAMPLES`), before drawing, in both compositors, so a huge blur fails fast with the layer id.
- **Crop margin.** Shapes and text are rasterized in composition space and cropped to the composition rect plus effect padding. Under blur that raster moves by `delta`, so the part that is off-screen at the centre frame but in view during the shutter must exist. The crop becomes the union of the padded composition rect and `inverse(delta_i)` applied to it for every invertible sample, clamped to at most one composition width or height of extra margin on each side. The existing raster-pixel `reserve` budget therefore stays meaningful. Content that moves faster than one composition size per frame is clipped there, and layers without motion crop exactly as before.
- **Format 10.** `SCENE_FORMAT_VERSION` goes from 9 to 10. The migration adds `motionBlur: null` to every drawn layer; golden frames and `golden/determinism.json` are unchanged.
- **Surface.** `get_capabilities` lists `features.motion_blur` and its limits; the `get_layer_schema` and `apply_ops` listings carry the field with its bounds, so an out-of-range value is rejected at the protocol layer with a path such as `ops[0].set.motionBlur.samples`. The server instructions give one line of guidance. A reference scene (`motion-blur`) pins a sliding title, a spinning square, a blurred child on a moving null and a sharp control.

## Alternatives

- **Per-composition shutter.** Matches After Effects, but needs a composition-update operation we do not have, and blurs everything including layers where it hurts (text that should stay crisp).
- **Post-process velocity-buffer blur.** Cheap, but a velocity buffer is not exact across occlusion, mattes and blend modes, gives no per-layer control, and is harder to keep deterministic across content.
- **Full sub-frame re-evaluation of contents.** Exact, but costs N times the raster work. Deferred.

## Consequences

- Fast transform motion reads as motion, per layer and at a cost the agent chooses with `samples`. A blurred layer costs `samples` times the compositing of an unblurred one; text and shapes are still rasterized once.
- Animated contents do not blur: a text animator sweeping across a title, or a path morph, is drawn at the centre frame only.
- The 65 536 transform budget allows, for example, 64 samples on 1 000 layers at depth 1, and 16 samples on 4 000.
- The MCP tool listing stays within its budget: the field was already in the schemas, and the capability manifest limit rose from 10 000 to 10 500 bytes.

## Follow-ups

- Content (sub-frame) blur for text animators, shape paths and nested layers.
- A composition-level override (shutter for all layers, once a composition-update operation exists).
- Adaptive sample count from the on-screen travel, so slow layers stay cheap and fast ones stay smooth.
