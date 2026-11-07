# 0020 — Masks, track mattes and blend modes

- Status: accepted (amends ADR-0016: mask coverage, including feathering and combining, is computed on the CPU)
- Date: 2026-11-07

## Context

The capability map puts blend modes, track mattes (alpha, luma, inverted, from any layer) and masks (path, feather, expansion, opacity, mode, inverted) in the beta. None of them existed: schema v2 had no fields for them, the engine did not evaluate them and the WebGL2 compositor of ADR-0016 is not built yet. ADR-0016 assigned feathering and combining masks to the compositor. We split the item into two PRs: this one (schema, evaluation, mask rasters, matte planning) and the compositor (blend modes, mattes, RGBA16F).

## Decision

- **Scene format v3.** Every drawing layer (all visual layers but null) gets `blendMode`, `matte` and `masks`. The 2 → 3 migration adds `"normal"`, `null` and `[]`, which draw exactly as version 2 did. Null layers draw nothing, so they get none of the three.
- **Order of operations follows After Effects:** masks, then (M4) effects, then the transform, the track matte, opacity and finally the blend mode against the layers below.
- **Blend modes: 24.** The 16 W3C Compositing and Blending modes (normal, multiply, screen, overlay, darken, lighten, color dodge, color burn, hard light, soft light, difference, exclusion, hue, saturation, color, luminosity), plus add, subtract, divide, linear burn, linear light, vivid light, pin light and hard mix. Formulas follow the W3C spec where it has one and are fixed for the rest in the compositor PR. Blending runs on sRGB-encoded values (ADR-0016). Dissolve, the "classic" variants, lighter/darker color and the stencil/silhouette modes are left out; adding one later is an additive enum change.
- **Track mattes: the After Effects 2023 model.** `matte: { layerId, mode } | null`, with mode `alpha`, `alpha-inverted`, `luma` or `luma-inverted`.
  - The source is any other drawing layer of the same composition, except adjustment layers, which draw no pixels of their own.
  - The source keeps drawing according to its own `hidden` switch. A hidden or unsoloed layer still works as a matte, so the `set_matte` tool (M3) can hide the source in the same operation, as After Effects does.
  - The source is drawn with its own masks, transform, opacity and matte, but not its blend mode. Chains are allowed; cycles are a validation error, reported once.
  - Outside the source's in/out range, or when it draws nothing, the matte is empty: an alpha matte hides the layer and an inverted one keeps all of it.
  - When the matte chain reaches a layer the renderer cannot draw yet (a component, until M6), the target is not drawn with an empty matte. It is left out and listed as skipped, naming that source.
- **Masks** are a list, combined top-first. Each has a closed bezier path in layer space (open paths cover nothing), a mode, `inverted`, and animatable `feather` (per-axis, layer units), `opacity` and `expansion` (layer units, at most the composition size limit either way; negative shrinks).
  - A mask's coverage `c` is its path's coverage, flipped by `inverted`, times its opacity.
  - The combined coverage `A` starts at 0 when the first active mask is add, lighten or difference, and at 1 for subtract, intersect or darken. Each mask then sets `A` to: add `A + c − A·c`, subtract `A·(1 − c)`, intersect `A·c`, lighten `max(A, c)`, darken `min(A, c)`, difference `|A − c|`. `none` masks are kept in the document and ignored.
  - Feather is a Gaussian blur with σ = feather / 3 per axis, centered on the edge, so coverage rises from 7% to 93% over the feather width. It is our definition: we have not measured After Effects' curve.
  - Expansion is the union with (or difference from) the path's stroke of twice that width, with round joins.
- **Masks are computed on the CPU, in the layer's raster space** (amends ADR-0016). Skia fills each mask's expanded path and blurs it with a paint image filter, which runs in the draw's local space, so feather stays a layer-space width under rotation and scale. JavaScript combines the masks into one 8-bit coverage raster the size of the layer's raster: the crop for shape and text layers, the layer itself for solids and images, the nested composition for precomps. The compositor only multiplies by it. Reasons: it is tested in Node like the rest of the rasterizer, reuses Skia's anti-aliasing and blur, and the cost is bounded by the layer's raster, which the frame's pixel budget already counts (each mask raster is charged too).
- **The frame plan** carries `blendMode`, `mask` and `matte` per layer. A matte source is planned once, even when hidden, and is the same object when it also draws. A layer its masks remove completely is left out, and masks that keep every pixel become `mask: null`.
- **`compositeReference` applies masks and throws on blend modes and mattes.** It cannot draw them correctly, and drawing them as normal would be silently wrong. The compositor PR replaces it for those. (Done in ADR-0021: it is now a full JavaScript compositor.)

## Consequences

- Imported After Effects and Lottie masks and mattes map field by field. Lottie's mask modes (`a`, `s`, `i`, `l`, `d`, `f`, `n`) all have a counterpart.
- A precomp's mask is applied to the composited nested frame. Until the compositor exists, only `compositeReference` does that.
- Mask feather is a Skia CPU blur. It is deterministic like the rest of the rasterizer; whether it matches After Effects closely enough should be checked against a reference frame from the "reference scenes" item.
- A feathered mask on a heavily scaled vector layer blurs at composition resolution, which is correct but costs more than in layer resolution. Caching mask rasters while their inputs are unchanged is a later optimization.
- The capability manifest (M3) must list blend modes and mattes as unrendered until the compositor lands.
- Open follow-ups: the compositor PR fixes the formulas for the eight non-W3C modes, and decides how mattes and blend modes interact with adjustment layers (M4).
