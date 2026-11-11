# 0042 — Built-in effects and adjustment layers

- Status: accepted
- Date: 2026-11-11

## Context

ADR-0016 puts the effect stack in the WebGL2 compositor and ADR-0020 defines its position relative to masks and track mattes. ADR-0040 deferred the `add_effect` tool and the `blur-in` preset until the renderer could draw them.

## Decision

- Scene format 8 gives drawable layers an ordered `effects` list. The migration adds an empty list, preserving the pixels. Older `addLayer` operations can omit it. Effects have layer-local IDs, an optional name and an optional enabled switch. Parameters are constants or keyframe tracks sampled in layer time and clamped to their documented ranges after easing.
- `setEffects` replaces the stack in one typed operation. It supports editing, reordering and removing effects and is reachable through `apply_ops` and the script SDK. `add_effect` inserts one effect and returns the operation and its ID. It shares intent dry run, idempotency and undo. `retime` and `stagger` move effect keyframes with the other layer tracks.
- The seven built-ins are Gaussian blur, drop shadow, glow, brightness/contrast, hue/saturation, tint and fill. Gaussian blur has separable normalized weights with sigma equal to radius divided by three. Shadow uses a bilinearly shifted blurred alpha silhouette. Glow places an unshifted colored halo under the source. Color effects work on straight sRGB and keep the incoming alpha. Tint maps Rec. 709 luma between two colors. Hue and saturation use HSV, with signed saturation scaling the input chroma.
- Ordinary layers apply masks, run their effects in raster space, then place the result and apply the track matte, layer opacity and blend mode. Shape and text layers use composition-space pixels. Solids, image and video footage and precomps use layer-space pixels. Spatial effects pad the raster with transparent pixels for the full stack, and vectors can capture source pixels outside the composition where they can contribute to the result.
- An adjustment layer filters the already composited layers below it within the same composition. Its mask, track matte and opacity gate the finished effect by interpolating between the original and the filtered premultiplied pixels. The transform positions the mask. A non-normal blend mode mixes the filtered straight color with the original color, weighted by the original alpha, before interpolation. The root background is applied after the stack and layers above the adjustment are drawn afterward. Adjustment layers cannot serve as track matte sources. Moving an adjustment into a precomp changes which layers it can affect.
- The renderer accepts eight effects per layer, a radius of up to 48 raster pixels and shadow offsets of up to ±256 raster pixels per axis. The compositor refuses work beyond 500 million effect texture samples in one frame, counted across the entire frame, including nested compositions and matte reads. The capability manifest declares these limits.
- `blur-in` fades from zero to the layer's existing opacity while the blur radius goes from 16 raster pixels to zero by default. It uses the same duration and easing tokens as `fade-in`. Per-glyph text animator blur remains a separate capability and continues to report a render warning.

## Consequences

- Effects and their parameters remain editable through scene operations. A zero-radius blur takes the same draw path as an empty stack.
- Existing golden frames continue to check pixel parity. SwiftShader tests compare all seven effects and adjustment compositing to the float64 reference compositor, and the MCP capture test exercises authoring and rendered output together.
